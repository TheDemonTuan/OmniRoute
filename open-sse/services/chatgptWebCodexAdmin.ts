/**
 * Service-boundary re-exports for the chatgpt-web-codex admin/dashboard API
 * routes (src/app/api/providers/**).
 *
 * `no-restricted-imports` (EXECUTOR_IMPORT_RESTRICTION, eslint.config.mjs)
 * forbids `src/app/**` files from importing `open-sse/executors/**` directly
 * — executor implementations must stay behind an open-sse handler or service
 * boundary. This file is that boundary for the small set of
 * chatgpt-web-codex helpers the provider CRUD/doctor routes need (secret
 * encode/decode, storage-state finalization, connection health status).
 */
export { getChatGptWebCodexDoctorStatus } from "../executors/chatgpt-web-codex/doctor.ts";
export {
  finalizeValidatedChatGptWebCodexSecrets,
  cookieHeaderValue,
  parseCookies,
} from "../executors/chatgpt-web-codex/storageState.ts";
export {
  decodeChatGptWebCodexSecrets,
  encodeChatGptWebCodexSecrets,
  type ChatGptWebCodexSecrets,
} from "../executors/chatgpt-web-codex/credentials.ts";
export {
  detectChromeExecutable,
  resolveChatGptWebCodexBrowserRuntime,
  ChatGptWebCodexRuntimeError,
  type ChatGptWebCodexBrowserRuntime,
} from "../executors/chatgpt-web-codex/browserRuntime.ts";
export { getChatGptWebCodexRuntimeCounts } from "../executors/chatgpt-web-codex/runtime.ts";
export { connectionRuntimePaths } from "../executors/chatgpt-web-codex/storageState.ts";
