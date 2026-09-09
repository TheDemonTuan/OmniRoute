import assert from "node:assert/strict";
import test from "node:test";

import {
  ChatGptWebAuthInputError,
  normalizeChatGptWebAuthInput,
} from "../../open-sse/utils/chatgptWebAuthInput.ts";

const fakeCookie = {
  name: "__Secure-next-auth.session-token",
  value: "TEST_ONLY_NOT_A_CREDENTIAL",
  domain: ".chatgpt.com",
  path: "/",
  expires: -1,
  httpOnly: true,
  secure: true,
  sameSite: "Lax" as const,
};

const createStorageState = () => ({
  cookies: [{ ...fakeCookie }],
  origins: [],
});

function assertThrowsCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    return error instanceof ChatGptWebAuthInputError && error.code === code;
  });
}

test("Playwright state is cloned, not mutated", () => {
  const input = createStorageState();
  const out = normalizeChatGptWebAuthInput(input);
  out.cookies[0]!.value = "changed";
  assert.equal(input.cookies[0]!.value, fakeCookie.value);
});

test("Cookie header preserves equals and chunked session names", () => {
  const out = normalizeChatGptWebAuthInput(
    "Cookie: __Secure-next-auth.session-token.0=abc=; __Secure-next-auth.session-token.1=xyz; __Host-test=ok"
  );
  assert.equal(out.cookies[0]!.value, "abc=");
  assert.equal(out.cookies[2]!.domain, "chatgpt.com");
  assert.deepEqual(out.origins, []);
});

test("malformed Cookie header error stays actionable after sanitization", async () => {
  const { sanitizeErrorMessage } = await import("../../open-sse/utils/errorSanitization.ts");
  assert.throws(
    () => normalizeChatGptWebAuthInput("not-a-cookie-header"),
    (error: unknown) => {
      assert.ok(error instanceof ChatGptWebAuthInputError);
      const message = sanitizeErrorMessage(error.message);
      assert.match(message, /Expected name=value/);
      assert.doesNotMatch(message, /\[REDACTED\]/);
      return true;
    }
  );
});

test("bare token requires explicit Codex compatibility option", () => {
  assertThrowsCode(() => normalizeChatGptWebAuthInput("TEST_ONLY"), "AUTH_COOKIE_HEADER");
  const result = normalizeChatGptWebAuthInput("TEST_ONLY", { allowBareSessionToken: true });
  assert.equal(result.cookies.length, 1);
});

test("empty input is rejected", () => {
  assertThrowsCode(() => normalizeChatGptWebAuthInput(""), "AUTH_INPUT_REQUIRED");
});

test("broken JSON is not reinterpreted as a cookie", () => {
  assertThrowsCode(() => normalizeChatGptWebAuthInput('{"cookies":'), "AUTH_JSON_SYNTAX");
});

test("extension export maps expirationDate and sameSite", () => {
  const c = {
    ...fakeCookie,
    expires: undefined,
    expirationDate: 2_000_000_000,
    sameSite: "no_restriction",
  };
  const out = normalizeChatGptWebAuthInput(JSON.stringify([c]));
  assert.equal(out.cookies[0]!.expires, 2_000_000_000);
  assert.equal(out.cookies[0]!.sameSite, "None");
});

test("omitted origins becomes empty for cookie-only JSON", () => {
  const out = normalizeChatGptWebAuthInput(JSON.stringify({ cookies: [fakeCookie] }));
  assert.deepEqual(out.origins, []);
});

test("account session API JSON is not storage state", () => {
  assertThrowsCode(
    () => normalizeChatGptWebAuthInput({ user: {}, accessToken: "TEST_ONLY" }),
    "AUTH_STORAGE_STATE_SCHEMA"
  );
});

test("session flag maps extension cookie to expires -1", () => {
  const out = normalizeChatGptWebAuthInput(
    JSON.stringify([{ ...fakeCookie, session: true, expirationDate: 2_000_000_000 }])
  );
  assert.equal(out.cookies[0]!.expires, -1);
});

test("foreign cookie rejected", () => {
  assertThrowsCode(
    () => normalizeChatGptWebAuthInput([{ ...fakeCookie, domain: "evil.example.com" }]),
    "AUTH_FOREIGN_COOKIE_DOMAIN"
  );
});

test("suffix spoof rejected", () => {
  assertThrowsCode(
    () => normalizeChatGptWebAuthInput([{ ...fakeCookie, domain: "not-chatgpt.com" }]),
    "AUTH_FOREIGN_COOKIE_DOMAIN"
  );
});

test("foreign origin rejected without logging values", () => {
  assert.throws(
    () =>
      normalizeChatGptWebAuthInput({
        cookies: [fakeCookie],
        origins: [{ origin: "https://evil.example.com", localStorage: [] }],
      }),
    (error: unknown) => {
      const err = error as ChatGptWebAuthInputError;
      return err.code === "AUTH_FOREIGN_ORIGIN" && !err.message.includes("evil");
    }
  );
});

test("origin port, credentials and non-root path rejected", () => {
  for (const origin of [
    "https://chatgpt.com:8443",
    "https://user:pass@chatgpt.com",
    "https://chatgpt.com/path",
  ]) {
    assertThrowsCode(
      () =>
        normalizeChatGptWebAuthInput({
          cookies: [fakeCookie],
          origins: [{ origin, localStorage: [] }],
        }),
      "AUTH_FOREIGN_ORIGIN"
    );
  }
});

test("first-party origin canonicalized", () => {
  const out = normalizeChatGptWebAuthInput({
    cookies: [fakeCookie],
    origins: [{ origin: "HTTPS://CHATGPT.COM", localStorage: [] }],
  });
  assert.equal(out.origins[0]!.origin, "https://chatgpt.com");
});

test("milliseconds are not silently converted", () => {
  assertThrowsCode(
    () => normalizeChatGptWebAuthInput([{ ...fakeCookie, expires: 2_000_000_000_000 }]),
    "AUTH_COOKIE_EXPIRY"
  );
});

test("unsupported sameSite rejected", () => {
  assertThrowsCode(
    () => normalizeChatGptWebAuthInput([{ ...fakeCookie, sameSite: "sometimes" }]),
    "AUTH_COOKIE_SAMESITE"
  );
});

test("insecure __Secure- cookie rejected", () => {
  assertThrowsCode(
    () => normalizeChatGptWebAuthInput([{ ...fakeCookie, secure: false }]),
    "AUTH_COOKIE_SCHEMA"
  );
});

test("partitioned auth not silently flattened", () => {
  assertThrowsCode(
    () => normalizeChatGptWebAuthInput([{ ...fakeCookie, partitionKey: "https://chatgpt.com" }]),
    "AUTH_PARTITIONED_COOKIE_UNSUPPORTED"
  );
});

test("unrecognized IndexedDB not silently discarded", () => {
  const s = createStorageState();
  (s.origins as unknown[]).push({
    origin: "https://chatgpt.com",
    localStorage: [],
    indexedDB: [{}],
  });
  assertThrowsCode(() => normalizeChatGptWebAuthInput(s), "AUTH_INDEXED_DB_UNSUPPORTED");
});

test("oversized import rejected", () => {
  assertThrowsCode(
    () => normalizeChatGptWebAuthInput("x".repeat(4 * 1024 * 1024 + 1)),
    "AUTH_INPUT_TOO_LARGE"
  );
});

test("sameSite prototype keys are not enum members", () => {
  for (const sameSite of ["constructor", "__proto__", "toString"]) {
    assertThrowsCode(
      () => normalizeChatGptWebAuthInput([{ ...fakeCookie, sameSite }]),
      "AUTH_COOKIE_SAMESITE"
    );
  }
});
