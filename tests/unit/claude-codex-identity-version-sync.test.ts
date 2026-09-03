/**
 * tests/unit/claude-codex-identity-version-sync.test.ts
 *
 * Guards the CLI identity versions against drift. Claude Code versions
 * resolve dynamically through the identity resolver. Codex client version lives in codexClient.
 */

import test from "node:test";
import assert from "node:assert/strict";

const hdr = await import("../../open-sse/config/anthropicHeaders.ts");
const compat = await import("../../open-sse/services/claudeCodeCompatible.ts");
const codexCfg = await import("../../open-sse/config/codexClient.ts");
const canonical = await import("../../src/shared/constants/claudeCodeClient.ts");

test("Claude CLI version getters are in lockstep across sources", () => {
  const V = canonical.getClaudeCodeVersion();
  assert.equal(hdr.getClaudeCliVersion(), V, "anthropicHeaders.getClaudeCliVersion() drift");
  assert.equal(compat.getClaudeCodeCompatibleVersion(), V, "claudeCodeCompatible version drift");
  assert.equal(
    hdr.getClaudeCliUserAgent(),
    `claude-cli/${V} (external, cli)`,
    "getClaudeCliUserAgent drift"
  );
  assert.equal(
    compat.getClaudeCodeCompatibleUserAgent(),
    `claude-cli/${V} (external, sdk-cli)`,
    "getClaudeCodeCompatibleUserAgent drift"
  );
});

test("Claude CLI wire versions match the baseline identity", () => {
  assert.equal(canonical.FALLBACK_CLAUDE_CODE_IDENTITY.version, "2.1.258");
  assert.equal(canonical.FALLBACK_CLAUDE_CODE_IDENTITY.sdkVersion, "0.94.0");
  assert.equal(
    compat.getClaudeCodeCompatibleStainlessPackageVersion(),
    canonical.getClaudeCodeSdkVersion()
  );
  assert.equal(
    compat.getClaudeCodeCompatibleStainlessRuntimeVersion(),
    canonical.getClaudeCodeRuntimeVersion()
  );
  assert.equal(hdr.getClaudeCliStainlessPackageVersion(), canonical.getClaudeCodeSdkVersion());
  assert.equal(hdr.getClaudeCliStainlessRuntimeVersion(), canonical.getClaudeCodeRuntimeVersion());
});

test("Codex client is pinned to the captured 0.149.0 release", () => {
  assert.equal(codexCfg.getCodexClientVersion(), "0.149.0");
  assert.equal(codexCfg.getCodexUserAgent(), "codex-cli/0.149.0 (Windows 10.0.26200; x64)");
  assert.equal(codexCfg.getCodexDefaultHeaders().Version, "0.149.0");
  assert.equal(codexCfg.getCodexCliRsHeaders()["User-Agent"], "codex_cli_rs/0.149.0");
});
