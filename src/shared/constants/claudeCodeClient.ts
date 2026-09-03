/**
 * Wire-version data captured from the signed Claude Code binary, backed by
 * the dynamic Claude Code identity resolver.
 *
 * Keep this leaf dependency-free (except for internal shared service) so
 * server executors, compatibility bridges, and client-facing identity
 * presets can share one source of truth.
 */

import {
  FALLBACK_CLAUDE_CODE_IDENTITY,
  getClaudeCodeIdentity,
  initClaudeCodeIdentity,
  resolveClaudeCodeIdentity,
  type ClaudeCodeIdentity,
  type ClaudeCodeResolverOptions,
} from "../services/claudeCodeIdentity";

export type ClaudeCodeEntrypoint = "cli" | "sdk-cli";

export function getClaudeCodeVersion(): string {
  return getClaudeCodeIdentity().version;
}

export function getClaudeCodeBuildRevision(): string {
  return getClaudeCodeIdentity().buildRevision;
}

export function getClaudeCodeBillingVersion(): string {
  return getClaudeCodeIdentity().billingVersion;
}

export function getClaudeCodeSdkVersion(): string {
  return getClaudeCodeIdentity().sdkVersion;
}

export function getClaudeCodeRuntimeVersion(): string {
  return getClaudeCodeIdentity().runtimeVersion;
}

export function getClaudeCodeUserAgent(entrypoint: ClaudeCodeEntrypoint = "cli"): string {
  const identity = getClaudeCodeIdentity();
  return entrypoint === "sdk-cli" ? identity.userAgentSdkCli : identity.userAgentCli;
}

// Fallback baseline constants for static typing and fallback baseline references
export const CLAUDE_CODE_CLIENT_VERSION = FALLBACK_CLAUDE_CODE_IDENTITY.version;
export const CLAUDE_CODE_CLIENT_BUILD_REVISION = FALLBACK_CLAUDE_CODE_IDENTITY.buildRevision;
export const CLAUDE_CODE_CLIENT_BILLING_VERSION = FALLBACK_CLAUDE_CODE_IDENTITY.billingVersion;
export const CLAUDE_CODE_SDK_PACKAGE_VERSION = FALLBACK_CLAUDE_CODE_IDENTITY.sdkVersion;
export const CLAUDE_CODE_RUNTIME_VERSION = FALLBACK_CLAUDE_CODE_IDENTITY.runtimeVersion;

export {
  FALLBACK_CLAUDE_CODE_IDENTITY,
  getClaudeCodeIdentity,
  initClaudeCodeIdentity,
  resolveClaudeCodeIdentity,
};
export type { ClaudeCodeIdentity, ClaudeCodeResolverOptions };
