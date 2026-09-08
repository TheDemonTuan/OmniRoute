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
      url.hash
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
let activeLeases = 0;
const activeConnections = new Set<string>();
const MAX_ACTIVE_LEASES = 2;
export async function acquireChatGptWebCdpLease(
  driver: CdpDriver,
  endpoint: string,
  options: {
    connectionId: string;
    contextOptions: BrowserContextOptions;
    signal?: AbortSignal | null;
  }
): Promise<ChatGptWebCdpLease> {
  if (options.signal?.aborted) throw new DOMException("Browser operation aborted", "AbortError");
  if (activeConnections.has(options.connectionId) || activeLeases >= MAX_ACTIVE_LEASES) {
    throw new ChatGptWebRuntimeGuardError(
      "CHATGPT_BROWSER_BUSY",
      "Browser capacity is occupied; no prompt was sent. Retry after the active turn finishes."
    );
  }
  activeLeases++;
  activeConnections.add(options.connectionId);
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let disposal: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    disposal = (async () => {
      try {
        await context?.close();
      } catch {
        /* best-effort cleanup after a process crash */
      }
      try {
        await browser?.close();
      } catch {
        /* connected browser: disconnect this client */
      } finally {
        activeConnections.delete(options.connectionId);
        activeLeases--;
      }
    })();
    return disposal;
  };
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
    return { page, dispose };
  } catch (error) {
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
