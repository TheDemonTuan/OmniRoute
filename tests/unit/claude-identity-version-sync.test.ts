import test from "node:test";
import assert from "node:assert/strict";

// Claude-Code identity getters are consumed across several transports. They resolve
// through the dynamic identity resolver; this guard protects the getters and their
// generated User-Agent strings from drift.
const claudeClient = await import("../../src/shared/constants/claudeCodeClient.ts");
const claudeCompat = await import("../../open-sse/services/claudeCodeCompatible.ts");
const anthropicHeaders = await import("../../open-sse/config/anthropicHeaders.ts");
const glmProvider = await import("../../open-sse/config/glmProvider.ts");

const CANONICAL = claudeClient.getClaudeCodeVersion();

// "claude-cli/2.1.258 (external, sdk-cli)" → "2.1.258". String ops only — never a RegExp over
// the value, per the project's anti-ReDoS contract.
function versionFromUserAgent(userAgent: string): string {
  const afterSlash = userAgent.split("claude-cli/")[1] ?? "";
  return afterSlash.split(" ")[0];
}

test("canonical claude-cli version is a sane semver value", () => {
  assert.match(CANONICAL, /^\d+\.\d+\.\d+$/);
});

test("all Claude-Code identity version getters are in lockstep", () => {
  assert.equal(
    claudeCompat.getClaudeCodeCompatibleVersion(),
    CANONICAL,
    "claudeCodeCompatible.getClaudeCodeCompatibleVersion() drifted from canonical"
  );
  assert.equal(
    anthropicHeaders.getClaudeCliVersion(),
    CANONICAL,
    "anthropicHeaders.getClaudeCliVersion() drifted from canonical"
  );
});

test("all claude-cli User-Agent strings embed the canonical version", () => {
  assert.equal(
    versionFromUserAgent(claudeCompat.getClaudeCodeCompatibleUserAgent()),
    CANONICAL,
    "claudeCodeCompatible.getClaudeCodeCompatibleUserAgent() embeds a stale version"
  );
  assert.equal(
    versionFromUserAgent(anthropicHeaders.getClaudeCliUserAgent()),
    CANONICAL,
    "anthropicHeaders.getClaudeCliUserAgent() embeds a stale version"
  );
  assert.equal(
    versionFromUserAgent(glmProvider.buildGlmBaseHeaders("test-key")["User-Agent"]),
    CANONICAL,
    "glmProvider base header User-Agent embeds a stale version"
  );
});
