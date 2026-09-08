import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeChatGptWebCodexSecrets,
  encodeChatGptWebCodexSecrets,
} from "../../open-sse/executors/chatgpt-web-codex/credentials.ts";

const cookie = "__Secure-next-auth.session-token=TEST_ONLY";
const state = {
  cookies: [
    {
      name: "__Secure-next-auth.session-token",
      value: "TEST_ONLY",
      domain: ".chatgpt.com",
    },
  ],
  origins: [],
};

test("Codex raw cookie remains pending-cookie input", () => {
  assert.equal(decodeChatGptWebCodexSecrets(cookie).cookie, cookie);
});

test("Codex v2 cookie envelope preserves runtime key", () => {
  assert.deepEqual(
    decodeChatGptWebCodexSecrets(
      JSON.stringify({ version: 2, cookie, runtimeKey: " TEST_RUNTIME " })
    ),
    { cookie, runtimeKey: "TEST_RUNTIME" }
  );
});

test("Codex direct storage state accepted", () => {
  const decoded = decodeChatGptWebCodexSecrets(JSON.stringify(state));
  const cookies = decoded.storageState?.cookies as Array<{ sameSite?: string }>;
  assert.equal(cookies[0]?.sameSite, "Lax");
});

test("Codex extension array accepted", () => {
  const decoded = decodeChatGptWebCodexSecrets(JSON.stringify(state.cookies));
  const cookies = decoded.storageState?.cookies as Array<{ value?: string }>;
  assert.equal(cookies[0]?.value, "TEST_ONLY");
});

test("Codex v2 state accepted and encoded round trip", () => {
  const encoded = encodeChatGptWebCodexSecrets({
    storageState: state,
    runtimeKey: "TEST_RUNTIME",
  });
  const decoded = decodeChatGptWebCodexSecrets(encoded);
  const cookies = decoded.storageState?.cookies as Array<{ expires?: number }>;
  assert.equal(cookies[0]?.expires, -1);
  assert.equal(decoded.runtimeKey, "TEST_RUNTIME");
});

test("Codex malformed JSON rejected, not a raw token", () => {
  assert.throws(() => decodeChatGptWebCodexSecrets('{"version":2, broken'), {
    name: "ChatGptWebAuthInputError",
  });
});

test("Codex foreign origins rejected", () => {
  assert.throws(
    () =>
      decodeChatGptWebCodexSecrets(
        JSON.stringify({
          cookies: state.cookies,
          origins: [{ origin: "https://evil.example.com", localStorage: [] }],
        })
      ),
    { name: "ChatGptWebAuthInputError" }
  );
});

test("Codex unrelated valid JSON rejected, not a raw token", () => {
  assert.throws(() => decodeChatGptWebCodexSecrets(JSON.stringify({ somethingElse: true })), {
    name: "ChatGptWebAuthInputError",
  });
});

test("Codex empty input rejected", () => {
  assert.throws(
    () => decodeChatGptWebCodexSecrets("   "),
    /ChatGPT Web \(Codex\) credentials are missing/
  );
});
