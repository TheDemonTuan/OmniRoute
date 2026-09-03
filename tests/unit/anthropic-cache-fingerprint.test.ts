import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeClaudeCodeBillingVersion,
  getClaudeCodeBillingVersion,
} from "../../src/shared/constants/claudeCodeClient.ts";

describe("Anthropic billing header fingerprint (#1638)", () => {
  it("computes dynamic billing version with version and fingerprint suffix", () => {
    const billing = computeClaudeCodeBillingVersion("2.1.258", "Hello world!");
    assert.match(billing, /^2\.1\.258\.[0-9a-f]{3}$/);
  });

  it("getClaudeCodeBillingVersion returns formatted cc_version string", () => {
    const billing = getClaudeCodeBillingVersion();
    assert.match(billing, /^\d+\.\d+\.\d+\.[0-9a-f]{3}$/);
  });
});
