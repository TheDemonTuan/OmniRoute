import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  FALLBACK_CLAUDE_CODE_IDENTITY,
  buildIdentity,
  computeClaudeCodeBillingVersion,
  getClaudeCodeIdentity,
  resolveClaudeCodeIdentity,
  resolveWireMetadata,
  setClaudeCodeIdentityForTesting,
  resetClaudeCodeIdentityForTesting,
} from "../../src/shared/services/claudeCodeIdentity.ts";
import {
  getClaudeCodeVersion,
  getClaudeCodeSdkVersion,
  getClaudeCodeRuntimeVersion,
  getClaudeCodeBillingVersion,
  getClaudeCodeUserAgent,
} from "../../src/shared/constants/claudeCodeClient.ts";

describe("claudeCodeIdentity - Dynamic Identity Resolver", () => {
  beforeEach(() => {
    resetClaudeCodeIdentityForTesting();
  });

  afterEach(() => {
    resetClaudeCodeIdentityForTesting();
    delete process.env.CLAUDE_CODE_CLIENT_VERSION;
    delete process.env.CLAUDE_CODE_VERSION_MODE;
    delete process.env.CLAUDE_CODE_VERSION_CHANNEL;
  });

  it("buildIdentity creates consistent identity object using wire metadata", () => {
    const id = buildIdentity("2.1.258");
    assert.equal(id.version, "2.1.258");
    assert.equal(id.sdkVersion, "0.94.0");
    assert.equal(id.runtimeVersion, "v24.3.0");
    assert.equal(id.userAgentCli, "claude-cli/2.1.258 (external, cli)");
    assert.equal(id.userAgentSdkCli, "claude-cli/2.1.258 (external, sdk-cli)");
  });

  it("buildIdentity trims 'v' prefixes and whitespace", () => {
    const id = buildIdentity(" v2.1.258 ");
    assert.equal(id.version, "2.1.258");
  });

  it("resolveWireMetadata returns mapped or fallback metadata", () => {
    const meta258 = resolveWireMetadata("2.1.258");
    assert.equal(meta258.sdkVersion, "0.94.0");

    const metaUnknown = resolveWireMetadata("99.99.99");
    assert.equal(metaUnknown.sdkVersion, "0.94.0");
    assert.ok(typeof metaUnknown.runtimeVersion === "string");
  });

  it("computeClaudeCodeBillingVersion computes deterministic 3-char hash suffix", () => {
    const billing = computeClaudeCodeBillingVersion("2.1.259", "hello Claude!");
    assert.match(billing, /^2\.1\.259\.[0-9a-f]{3}$/);
  });

  it("returns fallback baseline 2.1.258 by default", () => {
    const current = getClaudeCodeIdentity();
    assert.equal(current.version, "2.1.258");
    assert.equal(current.version, FALLBACK_CLAUDE_CODE_IDENTITY.version);
    assert.equal(current.sdkVersion, FALLBACK_CLAUDE_CODE_IDENTITY.sdkVersion);
  });

  it("resolves fixed version when specified in options", async () => {
    const resolved = await resolveClaudeCodeIdentity({
      mode: "fixed",
      fixedVersion: "2.1.299",
    });
    assert.equal(resolved.version, "2.1.299");
    assert.equal(resolved.userAgentCli, "claude-cli/2.1.299 (external, cli)");
  });

  it("resolves fixed version from CLAUDE_CODE_CLIENT_VERSION env var", async () => {
    process.env.CLAUDE_CODE_CLIENT_VERSION = "2.1.300";
    const resolved = await resolveClaudeCodeIdentity();
    assert.equal(resolved.version, "2.1.300");
  });

  it("resolves fallback when fixed mode has no version specified", async () => {
    const resolved = await resolveClaudeCodeIdentity({
      mode: "fixed",
    });
    assert.equal(resolved.version, "2.1.258");
  });

  it("setClaudeCodeIdentityForTesting updates dynamic getters", () => {
    const custom = buildIdentity("2.1.999", "0.99.0", "v26.0.0");
    setClaudeCodeIdentityForTesting(custom);

    assert.equal(getClaudeCodeVersion(), "2.1.999");
    assert.equal(getClaudeCodeSdkVersion(), "0.99.0");
    assert.equal(getClaudeCodeRuntimeVersion(), "v26.0.0");
    assert.match(getClaudeCodeBillingVersion("test"), /^2\.1\.999\.[0-9a-f]{3}$/);
    assert.equal(getClaudeCodeUserAgent("cli"), "claude-cli/2.1.999 (external, cli)");
    assert.equal(getClaudeCodeUserAgent("sdk-cli"), "claude-cli/2.1.999 (external, sdk-cli)");
  });
});
