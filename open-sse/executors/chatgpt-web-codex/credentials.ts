import { normalizeChatGptWebAuthInput } from "../../utils/chatgptWebAuthInput.ts";

export type ChatGptWebCodexSecrets = {
  cookie?: string;
  storageState?: Record<string, unknown>;
  runtimeKey?: string;
};
const VERSION = 2;
function normalizedCookie(value: string): string {
  return value.trim().replace(/^cookie\s*:\s*/i, "");
}
function validatedCookie(value: string): string {
  const cookie = normalizedCookie(value);
  normalizeChatGptWebAuthInput(cookie, { allowBareSessionToken: true });
  return cookie;
}
export function encodeChatGptWebCodexSecrets(secrets: ChatGptWebCodexSecrets): string {
  const storageState = secrets.storageState
    ? (normalizeChatGptWebAuthInput(secrets.storageState, {
        allowEmptyCookies: true,
      }) as unknown as Record<string, unknown>)
    : undefined;
  const cookie = !storageState && secrets.cookie ? validatedCookie(secrets.cookie) : "";
  if (!cookie && !storageState)
    throw new Error("ChatGPT Cookie or browser storage state is required");
  return JSON.stringify({
    version: VERSION,
    ...(storageState ? { storageState } : { cookie }),
    ...(secrets.runtimeKey?.trim() ? { runtimeKey: secrets.runtimeKey.trim() } : {}),
  });
}
export function decodeChatGptWebCodexSecrets(value: string): ChatGptWebCodexSecrets {
  const text = value.trim();
  if (!text) throw new Error("ChatGPT Web (Codex) credentials are missing");
  if (!/^[\[{]/.test(text)) return { cookie: validatedCookie(text) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Reuse the bounded, secret-safe syntax error. Never reinterpret broken JSON as a cookie.
    normalizeChatGptWebAuthInput(text);
    throw new Error("ChatGPT credential JSON is invalid");
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const envelope = parsed as Record<string, unknown>;
    if (envelope.version === 1 || envelope.version === VERSION) {
      const runtimeKey = typeof envelope.runtimeKey === "string" ? envelope.runtimeKey.trim() : "";
      const runtime = runtimeKey ? { runtimeKey } : {};
      if (envelope.storageState !== undefined) {
        return {
          storageState: envelope.storageState as Record<string, unknown>,
          ...runtime,
        };
      }
      if (typeof envelope.cookie === "string") {
        return { cookie: normalizedCookie(envelope.cookie), ...runtime };
      }
    }
  }
  return {
    storageState: normalizeChatGptWebAuthInput(parsed) as unknown as Record<string, unknown>,
  };
}
