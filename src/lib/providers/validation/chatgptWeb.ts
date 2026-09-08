import {
  ChatGptWebAuthInputError,
  normalizeChatGptWebAuthInput,
} from "@omniroute/open-sse/utils/chatgptWebAuthInput.ts";

export type ChatGptWebValidationResult = {
  valid: boolean;
  error: string | null;
  unsupported: false;
  method?: string;
  warning?: string;
};

/** Validate the import format only. Never label an imported credential as a live login. */
export function validateChatGptWebProvider({
  apiKey,
}: {
  apiKey?: unknown;
}): ChatGptWebValidationResult {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return {
      valid: false,
      error: "ChatGPT Web cookie header or browser storage-state JSON is required",
      unsupported: false,
    };
  }
  try {
    const state = normalizeChatGptWebAuthInput(apiKey);
    if (state.cookies.length === 0) {
      return {
        valid: false,
        error: "ChatGPT Web browser storage state must contain first-party cookies",
        unsupported: false,
      };
    }
    return {
      valid: true,
      error: null,
      unsupported: false,
    };
  } catch (error) {
    return {
      valid: false,
      unsupported: false,
      error:
        error instanceof ChatGptWebAuthInputError
          ? error.message
          : "ChatGPT Web credential import failed; no secret content was included in this error",
    };
  }
}
