import test from "node:test";
import assert from "node:assert/strict";
import { buildAntigravityUpstreamError } from "../../open-sse/executors/antigravityUpstreamError.ts";

test("Antigravity 400 retains the sanitized upstream reason in the error message", () => {
  const body = buildAntigravityUpstreamError(
    400,
    "Bad Request",
    JSON.stringify({
      error: {
        code: 400,
        message: "Function call and response do not match",
        status: "INVALID_ARGUMENT",
      },
    })
  );
  assert.match(body.error.message, /Function call and response do not match/);
  assert.equal(body.error.code, "bad_request");
});

test("Antigravity 400 omits malformed upstream details and does not leak credentials", () => {
  const malformed = buildAntigravityUpstreamError(
    400,
    "Bad Request",
    "<html>upstream error</html>"
  );
  assert.equal(malformed.error.message, "Antigravity upstream error (400): Bad Request");
  const sensitive = buildAntigravityUpstreamError(
    400,
    "Bad Request",
    JSON.stringify({ error: { message: "Bearer sk-123456789abcdefghijk invalid" } })
  );
  assert.doesNotMatch(sensitive.error.message, /sk-123456789abcdefghijk/);
});
