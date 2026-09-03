import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  FALLBACK_CLAUDE_CODE_IDENTITY,
  buildIdentity,
  getClaudeCodeIdentity,
  resolveClaudeCodeIdentity,
  setClaudeCodeIdentityForTesting,
  resetClaudeCodeIdentityForTesting,
} from "../../src/shared/services/claudeCodeIdentity.ts";
import {
  getClaudeCodeVersion,
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

  it("buildIdentity creates consistent identity object", () => {
    const id = buildIdentity("2.1.258", "1f2", "0.94.0");
    assert.equal(id.version, "2.1.258");
    assert.equal(id.buildRevision, "1f2");
    assert.equal(id.sdkVersion, "0.94.0");
    assert.equal(id.billingVersion, "2.1.258.1f2");
    assert.equal(id.userAgentCli, "claude-cli/2.1.258 (external, cli)");
    assert.equal(id.userAgentSdkCli, "claude-cli/2.1.258 (external, sdk-cli)");
  });

  it("buildIdentity trims 'v' prefixes and whitespace", () => {
    const id = buildIdentity(" v2.1.258 ", " 1f2 ", " 0.94.0 ");
    assert.equal(id.version, "2.1.258");
    assert.equal(id.buildRevision, "1f2");
    assert.equal(id.billingVersion, "2.1.258.1f2");
  });

  it("returns fallback identity by default", () => {
    const current = getClaudeCodeIdentity();
    assert.equal(current.version, FALLBACK_CLAUDE_CODE_IDENTITY.version);
    assert.equal(current.billingVersion, FALLBACK_CLAUDE_CODE_IDENTITY.billingVersion);
  });

  it("resolves fixed version when specified in options", async () => {
    const resolved = await resolveClaudeCodeIdentity({
      mode: "fixed",
      fixedVersion: "2.1.299",
    });
    assert.equal(resolved.version, "2.1.299");
    assert.equal(resolved.billingVersion, "2.1.299.1f2");
    assert.equal(resolved.userAgentCli, "claude-cli/2.1.299 (external, cli)");
  });

  it("resolves fixed version from CLAUDE_CODE_CLIENT_VERSION env var", async () => {
    process.env.CLAUDE_CODE_CLIENT_VERSION = "2.1.300";
    const resolved = await resolveClaudeCodeIdentity();
    assert.equal(resolved.version, "2.1.300");
    assert.equal(resolved.billingVersion, "2.1.300.1f2");
  });

  it("setClaudeCodeIdentityForTesting updates dynamic getters", () => {
    const custom = buildIdentity("2.1.999", "custom-rev");
    setClaudeCodeIdentityForTesting(custom);

    assert.equal(getClaudeCodeVersion(), "2.1.999");
    assert.equal(getClaudeCodeBillingVersion(), "2.1.999.custom-rev");
    assert.equal(getClaudeCodeUserAgent("cli"), "claude-cli/2.1.999 (external, cli)");
    assert.equal(getClaudeCodeUserAgent("sdk-cli"), "claude-cli/2.1.999 (external, sdk-cli)");
  });
});
