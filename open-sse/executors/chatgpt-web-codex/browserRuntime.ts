import {
  chatGptWebCdpEndpoint,
  ChatGptWebRuntimeGuardError,
  requireChatGptWebDisplay,
} from "../../utils/chatgptWebRuntimeGuard.ts";
import { existsSync } from "node:fs";

export type ChatGptWebCodexBrowserRuntime = {
  available: boolean;
  chromeExecutablePath?: string;
  cdpEndpoint?: string;
  mode: "internal-cdp" | "local-chromium" | "unavailable";
  reason?: "browser_unavailable";
};

export class ChatGptWebCodexRuntimeError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(
    code = "CHATGPT_WEB_CODEX_BROWSER_UNAVAILABLE",
    message = "ChatGPT Web (Codex) browser runtime is unavailable",
    statusCode = 503
  ) {
    super(message);
    this.name = "ChatGptWebCodexRuntimeError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function detectChromeExecutable(
  explicit?: string,
  options?: { skipSystemPaths?: boolean }
): string | undefined {
  if (
    explicit === "disabled" ||
    explicit === "none" ||
    process.env.CHATGPT_WEB_CODEX_CHROME_PATH === "disabled"
  ) {
    return undefined;
  }
  const systemPaths =
    options?.skipSystemPaths || process.env.CHATGPT_WEB_CODEX_DEFAULT_CHROME_PATHS === "0"
      ? []
      : [
          "/usr/bin/google-chrome",
          "/usr/bin/google-chrome-stable",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        ];

  const candidates = [
    explicit,
    process.env.CHATGPT_WEB_CODEX_CHROME_PATH,
    process.env.CHROME_PATH,
    ...systemPaths,
  ];
  return candidates.find((candidate): candidate is string =>
    Boolean(candidate && candidate !== "disabled" && candidate !== "none" && existsSync(candidate))
  );
}

export function resolveChatGptWebCodexBrowserRuntime(
  data?: Record<string, unknown>
): ChatGptWebCodexBrowserRuntime {
  const explicitChrome =
    data && typeof data.chromeExecutablePath === "string" ? data.chromeExecutablePath : undefined;
  let cdpEndpoint: string | undefined;
  try {
    cdpEndpoint = chatGptWebCdpEndpoint();
  } catch (error) {
    if (error instanceof ChatGptWebRuntimeGuardError) {
      throw new ChatGptWebCodexRuntimeError(
        "chatgpt_cdp_config_invalid",
        error.message,
        error.statusCode
      );
    }
    throw error;
  }
  const chromeExecutablePath = detectChromeExecutable(explicitChrome);

  if (cdpEndpoint) {
    return {
      available: true,
      cdpEndpoint,
      ...(chromeExecutablePath ? { chromeExecutablePath } : {}),
      mode: "internal-cdp",
    };
  }

  if (chromeExecutablePath) {
    try {
      requireChatGptWebDisplay();
    } catch (error) {
      throw new ChatGptWebCodexRuntimeError(
        "chatgpt_browser_display_missing",
        error instanceof Error ? error.message : "Headed browser display is unavailable",
        503
      );
    }
    return {
      available: true,
      chromeExecutablePath,
      mode: "local-chromium",
    };
  }

  return {
    available: false,
    mode: "unavailable",
    reason: "browser_unavailable",
  };
}
