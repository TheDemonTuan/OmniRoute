import test from "node:test";
import assert from "node:assert/strict";
import { mergeClientAnthropicBeta } from "../../open-sse/config/anthropicHeaders.ts";

const COMPACTION_BETA = "compact-2026-09-04";

test("mergeClientAnthropicBeta keeps the compaction beta the client sent", () => {
  const out = mergeClientAnthropicBeta(
    "claude-code-20250219,oauth-2025-04-20",
    `oauth-2025-04-20,${COMPACTION_BETA}`
  );
  const tokens = out.split(",");

  assert.equal(tokens.filter((token) => token === COMPACTION_BETA).length, 1, "forwarded once");
  assert.deepEqual(tokens.slice(0, 2), ["claude-code-20250219", "oauth-2025-04-20"]);
});

test("mergeClientAnthropicBeta does not add the compaction beta the client did not send", () => {
  const out = mergeClientAnthropicBeta("claude-code-20250219,oauth-2025-04-20", "oauth-2025-04-20");

  assert.equal(out.split(",").includes(COMPACTION_BETA), false, "must stay opt-in by the client");
});
