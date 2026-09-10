import assert from "node:assert/strict";
import test from "node:test";

import { checkFallbackError } from "../../open-sse/services/accountFallback.ts";

test("checkFallbackError does not retry or fallback when ChatGPT turn has already been submitted", () => {
  const codes = ["chatgpt_submission_ambiguous", "chatgpt_submitted_turn_failed"];

  for (const code of codes) {
    const byStructured = checkFallbackError(
      502,
      "turn failed after prompt was submitted",
      0,
      null,
      "chatgpt-web-codex",
      null,
      null,
      { code, type: "provider_error" }
    );
    assert.equal(byStructured.shouldFallback, false);
    assert.equal(byStructured.cooldownMs, 0);
    assert.equal(byStructured.skipProviderBreaker, true);
    assert.equal(byStructured.reason, code);

    const byText = checkFallbackError(
      502,
      `[${code}] connection failed after submission`,
      0,
      null,
      "chatgpt-web-codex"
    );
    assert.equal(byText.shouldFallback, false);
    assert.equal(byText.cooldownMs, 0);
    assert.equal(byText.skipProviderBreaker, true);
  }
});
