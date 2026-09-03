/**
 * Wire-version accessors backed by the dynamic Claude Code identity resolver.
 *
 * Keep this leaf dependency-free (except for internal shared service) so
 * server executors, compatibility bridges, and client-facing identity
 * presets can share one source of truth.
 */

import {
  FALLBACK_CLAUDE_CODE_IDENTITY,
  computeClaudeCodeBillingVersion,
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

export function getClaudeCodeBillingVersion(firstUserMessage = ""): string {
  return computeClaudeCodeBillingVersion(getClaudeCodeVersion(), firstUserMessage);
}

export {
  FALLBACK_CLAUDE_CODE_IDENTITY,
  computeClaudeCodeBillingVersion,
  getClaudeCodeIdentity,
  initClaudeCodeIdentity,
  resolveClaudeCodeIdentity,
};
export type { ClaudeCodeIdentity, ClaudeCodeResolverOptions };
