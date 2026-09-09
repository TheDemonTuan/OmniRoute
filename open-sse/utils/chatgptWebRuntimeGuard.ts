/** Runtime-only helpers. No cookie values, CDP URLs, or raw browser stderr in public errors. */
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright";
export class ChatGptWebRuntimeGuardError extends Error {
  readonly code: string;
  readonly statusCode = 503;
  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "ChatGptWebRuntimeGuardError";
    this.code = code;
  }
}
export function requireChatGptWebDisplay(
  cdpEndpoint?: string,
  options: { platform?: string; env?: Record<string, string | undefined> } = {}
): void {
  if (cdpEndpoint) return;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform === "linux" && !env.DISPLAY?.trim()) {
    throw new ChatGptWebRuntimeGuardError(
      "CHATGPT_BROWSER_DISPLAY_MISSING",
      "Headed Chromium needs an X display. Configure the internal CDP browser sidecar or run this process under Xvfb. Credentials were not tested."
    );
  }
}
export function chatGptWebCdpEndpoint(
  env: Record<string, string | undefined> = process.env
): string | undefined {
  // Server-admin environment only. Never select CDP from untrusted request or cookie JSON.
  const endpoint = env.CHATGPT_WEB_CDP_URL?.trim() || env.CHATGPT_WEB_CODEX_CDP_URL?.trim();
  if (!endpoint) return undefined;
  try {
    const url = new URL(endpoint);
    if (
      !["http:", "https:", "ws:", "wss:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      !url.hostname ||
      url.port === "0" ||
      url.pathname !== "/"
    )
      throw new Error();
    return endpoint;
  } catch {
    throw new ChatGptWebRuntimeGuardError(
      "CHATGPT_CDP_CONFIG_INVALID",
      "CDP must be a valid server-admin HTTP(S) or WS(S) endpoint without embedded credentials."
    );
  }
}
type CdpDriver = {
  connectOverCDP(endpoint: string, options: { timeout: number }): Promise<Browser>;
};
export interface ChatGptWebCdpLease {
  page: Page;
  dispose(): Promise<void>;
}

export interface ChatGptWebRuntimeAdmission {
  release(): void;
}

interface ActiveLeaseRecord {
  disposal?: Promise<void>;
  acquiredAt: number;
}

let activeLeases = 0;
const activeConnections = new Map<string, ActiveLeaseRecord>();
const activeAdmissions = new Map<string, symbol>();

function getActiveCount(): number {
  const allActive = new Set([...activeAdmissions.keys(), ...activeConnections.keys()]);
  return allActive.size;
}

export function acquireChatGptWebRuntimeAdmission(
  connectionId: string,
  owner: "clean-room" | "codex" | "verification"
): ChatGptWebRuntimeAdmission {
  const normalizedConnectionId = connectionId.trim();
  if (
    !normalizedConnectionId ||
    activeAdmissions.has(normalizedConnectionId) ||
    activeConnections.has(normalizedConnectionId) ||
    getActiveCount() >= getMaxActiveLeases()
  ) {
    throw new ChatGptWebRuntimeGuardError(
      "CHATGPT_BROWSER_BUSY",
      `Browser capacity is occupied by another ${owner} operation; no prompt was sent. Retry after the active operation finishes.`
    );
  }
  const token = Symbol(owner);
  activeAdmissions.set(normalizedConnectionId, token);
  return {
    release(): void {
      if (activeAdmissions.get(normalizedConnectionId) === token) {
        activeAdmissions.delete(normalizedConnectionId);
      }
    },
  };
}

const DEFAULT_MAX_ACTIVE_LEASES = 2;
function getMaxActiveLeases(): number {
  const envVal = Number(process.env.CHATGPT_WEB_MAX_BROWSER_TABS);
  return Number.isFinite(envVal) && envVal > 0 ? envVal : DEFAULT_MAX_ACTIVE_LEASES;
}

const CLEANUP_TIMEOUT_MS = 3_000;
const MAX_LEASE_DURATION_MS = 180_000;

async function boundedCleanup(fn: (() => Promise<void>) | undefined, ms: number): Promise<void> {
  if (!fn) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
        timer.unref?.();
      }),
    ]);
  } catch {
    /* best effort cleanup */
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function acquireChatGptWebCdpLease(
  driver: CdpDriver,
  endpoint: string,
  options: {
    connectionId: string;
    contextOptions: BrowserContextOptions;
    signal?: AbortSignal | null;
    admission?: ChatGptWebRuntimeAdmission;
  }
): Promise<ChatGptWebCdpLease> {
  if (options.signal?.aborted) throw new DOMException("Browser operation aborted", "AbortError");
  const admission = options.admission;

  // If the same connection has an existing lease that is already disposing, wait for it to settle
  const existing = activeConnections.get(options.connectionId);
  if (existing?.disposal) {
    try {
      await boundedCleanup(() => existing.disposal, 5_000);
    } catch {
      /* continue to capacity check */
    }
  }

  const maxLeases = getMaxActiveLeases();
  if (activeConnections.has(options.connectionId) || activeLeases >= maxLeases) {
    admission?.release();
    throw new ChatGptWebRuntimeGuardError(
      "CHATGPT_BROWSER_BUSY",
      "Browser capacity is occupied; no prompt was sent. Retry after the active turn finishes."
    );
  }

  activeLeases++;
  const record: ActiveLeaseRecord = { acquiredAt: Date.now() };
  activeConnections.set(options.connectionId, record);

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let disposal: Promise<void> | undefined;

  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    disposal = (async () => {
      try {
        await boundedCleanup(() => context?.close(), CLEANUP_TIMEOUT_MS);
      } catch {
        /* best-effort cleanup after a process crash */
      }
      try {
        await boundedCleanup(() => browser?.close(), 2_000);
      } catch {
        /* connected browser: disconnect this client */
      } finally {
        activeConnections.delete(options.connectionId);
        activeLeases = Math.max(0, activeLeases - 1);
        admission?.release();
      }
    })();
    record.disposal = disposal;
    return disposal;
  };

  // Stale lease watchdog: auto-dispose if a lease exceeds max turn duration
  const watchdog = setTimeout(() => {
    if (activeConnections.get(options.connectionId) === record) {
      void dispose();
    }
  }, MAX_LEASE_DURATION_MS);
  watchdog.unref?.();

  let phase: "connect" | "context" | "page" = "connect";
  try {
    browser = await driver.connectOverCDP(endpoint, { timeout: 20_000 });
    if (options.signal?.aborted) throw new DOMException("Browser operation aborted", "AbortError");
    phase = "context";
    context = await browser.newContext(options.contextOptions);
    if (options.signal?.aborted) throw new DOMException("Browser operation aborted", "AbortError");
    phase = "page";
    const page = await context.newPage();
    if (options.signal?.aborted) throw new DOMException("Browser operation aborted", "AbortError");
    return {
      page,
      dispose: async () => {
        clearTimeout(watchdog);
        return dispose();
      },
    };
  } catch (error) {
    clearTimeout(watchdog);
    await dispose();
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    const code = phase === "connect" ? "CHATGPT_CDP_UNAVAILABLE" : "CHATGPT_BROWSER_CONTEXT_FAILED";
    throw new ChatGptWebRuntimeGuardError(
      code,
      phase === "connect"
        ? "Cannot connect to the configured browser sidecar. Check its health and internal network; credentials were not tested."
        : "The browser could not create an isolated context/page. Check browser health, storage-state schema and runtime resources."
    );
  }
}
