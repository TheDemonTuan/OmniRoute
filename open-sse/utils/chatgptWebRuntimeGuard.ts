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
  token: symbol;
}

let activeLeases = 0;
const activeConnections = new Map<string, ActiveLeaseRecord>();
const activeAdmissions = new Map<string, symbol>();

interface AdmissionWaiter {
  connectionId: string;
  owner: "clean-room" | "codex" | "verification";
  resolve: (admission: ChatGptWebRuntimeAdmission) => void;
  reject: (err: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  abortHandler?: () => void;
  signal?: AbortSignal | null;
}

const queuedAdmissionWaiters: AdmissionWaiter[] = [];
const DEFAULT_MAX_QUEUE_WAITERS = 20;
const DEFAULT_QUEUE_TIMEOUT_MS = 120_000;

let isScheduling = false;
function scheduleNextAdmissionWaiter(): void {
  if (isScheduling) return;
  isScheduling = true;
  try {
    const maxLeases = getMaxActiveLeases();
    while (getActiveCount() < maxLeases && queuedAdmissionWaiters.length > 0) {
      let eligibleIndex = -1;
      for (let i = 0; i < queuedAdmissionWaiters.length; i++) {
        const candidate = queuedAdmissionWaiters[i];
        if (candidate.signal?.aborted) {
          queuedAdmissionWaiters.splice(i, 1);
          candidate.reject(new DOMException("Browser operation aborted", "AbortError"));
          i--;
          continue;
        }
        if (
          !activeConnections.has(candidate.connectionId) &&
          !activeAdmissions.has(candidate.connectionId)
        ) {
          eligibleIndex = i;
          break;
        }
      }

      if (eligibleIndex === -1) {
        break;
      }

      const [waiter] = queuedAdmissionWaiters.splice(eligibleIndex, 1);
      if (waiter.timer) clearTimeout(waiter.timer);

      const token = Symbol(waiter.owner);
      activeAdmissions.set(waiter.connectionId, token);

      const admission: ChatGptWebRuntimeAdmission = {
        release(): void {
          if (activeAdmissions.get(waiter.connectionId) === token) {
            activeAdmissions.delete(waiter.connectionId);
            scheduleNextAdmissionWaiter();
          }
        },
      };

      waiter.resolve(admission);
    }
  } finally {
    isScheduling = false;
  }
}

function getActiveCount(): number {
  const allActive = new Set([...activeAdmissions.keys(), ...activeConnections.keys()]);
  return allActive.size;
}

function ensureCapacity(connectionId: string): void {
  if (activeConnections.has(connectionId) || getActiveCount() >= getMaxActiveLeases()) {
    throw new ChatGptWebRuntimeGuardError(
      "CHATGPT_BROWSER_BUSY",
      "Browser capacity is occupied; no prompt was sent. Retry after the active turn finishes."
    );
  }
}

export function acquireChatGptWebRuntimeAdmission(
  connectionId: string,
  owner: "clean-room" | "codex" | "verification"
): ChatGptWebRuntimeAdmission {
  const normalizedConnectionId = connectionId.trim();
  if (!normalizedConnectionId || activeAdmissions.has(normalizedConnectionId)) {
    throw new ChatGptWebRuntimeGuardError(
      "CHATGPT_BROWSER_BUSY",
      `Browser capacity is occupied by another ${owner} operation; no prompt was sent. Retry after the active operation finishes.`
    );
  }
  ensureCapacity(normalizedConnectionId);
  const token = Symbol(owner);
  activeAdmissions.set(normalizedConnectionId, token);
  return {
    release(): void {
      if (activeAdmissions.get(normalizedConnectionId) === token) {
        activeAdmissions.delete(normalizedConnectionId);
        scheduleNextAdmissionWaiter();
      }
    },
  };
}

export async function acquireQueuedChatGptWebRuntimeAdmission(
  connectionId: string,
  owner: "clean-room" | "codex" | "verification",
  options: {
    timeoutMs?: number;
    signal?: AbortSignal | null;
    maxQueueWaiters?: number;
  } = {}
): Promise<ChatGptWebRuntimeAdmission> {
  const normalizedConnectionId = connectionId.trim();
  if (options.signal?.aborted) {
    throw new DOMException("Browser operation aborted", "AbortError");
  }

  const timeoutMs =
    options.timeoutMs !== undefined
      ? options.timeoutMs
      : process.env.CHATGPT_WEB_QUEUE_TIMEOUT_MS !== undefined
        ? Number(process.env.CHATGPT_WEB_QUEUE_TIMEOUT_MS)
        : DEFAULT_QUEUE_TIMEOUT_MS;
  const maxWaiters = options.maxQueueWaiters ?? DEFAULT_MAX_QUEUE_WAITERS;

  const maxLeases = getMaxActiveLeases();
  const hasQueuedSameConn = queuedAdmissionWaiters.some(
    (w) => w.connectionId === normalizedConnectionId
  );
  const hasEligibleQueued = queuedAdmissionWaiters.some(
    (w) => !activeConnections.has(w.connectionId) && !activeAdmissions.has(w.connectionId)
  );
  const isBusy =
    activeConnections.has(normalizedConnectionId) ||
    activeAdmissions.has(normalizedConnectionId) ||
    hasQueuedSameConn ||
    hasEligibleQueued ||
    getActiveCount() >= maxLeases;

  if (!isBusy) {
    const token = Symbol(owner);
    activeAdmissions.set(normalizedConnectionId, token);
    return {
      release(): void {
        if (activeAdmissions.get(normalizedConnectionId) === token) {
          activeAdmissions.delete(normalizedConnectionId);
          scheduleNextAdmissionWaiter();
        }
      },
    };
  }

  if (timeoutMs <= 0) {
    throw new ChatGptWebRuntimeGuardError(
      "CHATGPT_BROWSER_BUSY",
      `Browser capacity is occupied by another ${owner} operation; no prompt was sent. Retry after the active operation finishes.`
    );
  }

  if (queuedAdmissionWaiters.length >= maxWaiters) {
    throw new ChatGptWebRuntimeGuardError(
      "CHATGPT_BROWSER_BUSY",
      "Browser capacity is saturated. Please wait for the current turn to complete."
    );
  }

  return new Promise<ChatGptWebRuntimeAdmission>((resolve, reject) => {
    let settled = false;
    const removeWaiter = (): void => {
      const idx = queuedAdmissionWaiters.indexOf(waiter);
      if (idx !== -1) queuedAdmissionWaiters.splice(idx, 1);
    };

    const waiter: AdmissionWaiter = {
      connectionId: normalizedConnectionId,
      owner,
      signal: options.signal,
      resolve: (admission) => {
        if (settled) {
          admission.release();
          return;
        }
        settled = true;
        if (waiter.timer) clearTimeout(waiter.timer);
        if (waiter.abortHandler && options.signal) {
          options.signal.removeEventListener("abort", waiter.abortHandler);
        }
        resolve(admission);
      },
      reject: (err) => {
        if (settled) return;
        settled = true;
        if (waiter.timer) clearTimeout(waiter.timer);
        if (waiter.abortHandler && options.signal) {
          options.signal.removeEventListener("abort", waiter.abortHandler);
        }
        removeWaiter();
        reject(err);
        scheduleNextAdmissionWaiter();
      },
    };

    if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      waiter.timer = setTimeout(() => {
        waiter.reject(
          new ChatGptWebRuntimeGuardError(
            "CHATGPT_BROWSER_BUSY",
            "Browser capacity is occupied; no prompt was sent. Retry after the active turn finishes."
          )
        );
      }, timeoutMs);
      waiter.timer.unref?.();
    }

    if (options.signal) {
      waiter.abortHandler = () => {
        waiter.reject(new DOMException("Browser operation aborted", "AbortError"));
      };
      options.signal.addEventListener("abort", waiter.abortHandler, { once: true });
    }

    queuedAdmissionWaiters.push(waiter);
    scheduleNextAdmissionWaiter();
  });
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

  const connectionId = options.connectionId.trim();
  const admissionOwnsConnection = activeAdmissions.has(connectionId);
  if (
    activeConnections.has(connectionId) ||
    (!admissionOwnsConnection && getActiveCount() >= getMaxActiveLeases())
  ) {
    admission?.release();
    throw new ChatGptWebRuntimeGuardError(
      "CHATGPT_BROWSER_BUSY",
      "Browser capacity is occupied; no prompt was sent. Retry after the active turn finishes."
    );
  }

  activeLeases++;
  const record: ActiveLeaseRecord = { acquiredAt: Date.now(), token: Symbol("lease") };
  activeConnections.set(connectionId, record);

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
        if (activeConnections.get(connectionId) === record) {
          activeConnections.delete(connectionId);
          activeLeases = Math.max(0, activeLeases - 1);
        }
        admission?.release();
        scheduleNextAdmissionWaiter();
      }
    })();
    record.disposal = disposal;
    return disposal;
  };

  // The watchdog only begins retirement. Capacity is released in dispose() after cleanup settles.
  const watchdog = setTimeout(() => {
    if (activeConnections.get(connectionId) === record) void dispose();
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
