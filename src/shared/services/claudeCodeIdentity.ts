/**
 * Dynamic Claude Code identity resolver.
 *
 * Resolves the Claude Code CLI wire-identity (version, buildRevision,
 * sdkVersion, runtimeVersion, billingVersion, user-agents) using:
 *   1. Environment override (CLAUDE_CODE_CLIENT_VERSION / mode='fixed')
 *   2. Installed local binary (`claude --version` if mode='installed' or 'auto')
 *   3. NPM registry dist-tags (@anthropic-ai/claude-code: stable | latest)
 *   4. Bundled fallback identity
 *
 * Employs an in-memory SWR (stale-while-revalidate) cache so hot-path calls
 * to `getClaudeCodeIdentity()` have zero latency and never block requests.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ClaudeCodeIdentity {
  readonly version: string;
  readonly buildRevision: string;
  readonly sdkVersion: string;
  readonly runtimeVersion: string;
  readonly billingVersion: string;
  readonly userAgentCli: string;
  readonly userAgentSdkCli: string;
}

export interface ClaudeCodeResolverOptions {
  mode?: "auto" | "installed" | "fixed";
  channel?: "stable" | "latest";
  fixedVersion?: string;
  cacheTtlMs?: number;
}

export const FALLBACK_CLAUDE_CODE_IDENTITY: ClaudeCodeIdentity = Object.freeze({
  version: "2.1.236",
  buildRevision: "1f2",
  sdkVersion: "0.94.0",
  runtimeVersion: typeof process !== "undefined" ? process.version : "v22.14.0",
  billingVersion: "2.1.236.1f2",
  userAgentCli: "claude-cli/2.1.236 (external, cli)",
  userAgentSdkCli: "claude-cli/2.1.236 (external, sdk-cli)",
});

const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const NPM_REGISTRY_URL = "https://registry.npmjs.org/@anthropic-ai/claude-code";

let activeIdentity: ClaudeCodeIdentity = FALLBACK_CLAUDE_CODE_IDENTITY;
let cacheExpiresAt = 0;
let isRefreshing = false;

export function buildIdentity(
  version: string,
  buildRevision = "1f2",
  sdkVersion = "0.94.0"
): ClaudeCodeIdentity {
  const cleanVersion = String(version || "")
    .trim()
    .replace(/^v/, "");
  const cleanRevision = String(buildRevision || "1f2").trim();
  const cleanSdk = String(sdkVersion || "0.94.0").trim();
  const runtimeVersion =
    typeof process !== "undefined" && process.version ? process.version : "v22.14.0";

  return Object.freeze({
    version: cleanVersion,
    buildRevision: cleanRevision,
    sdkVersion: cleanSdk,
    runtimeVersion,
    billingVersion: `${cleanVersion}.${cleanRevision}`,
    userAgentCli: `claude-cli/${cleanVersion} (external, cli)`,
    userAgentSdkCli: `claude-cli/${cleanVersion} (external, sdk-cli)`,
  });
}

/**
 * 1. Probe local installed CLI: `claude --version`
 * Uses execFile directly (no shell interpolation) per Hard Rule #13.
 */
export async function tryGetInstalledVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("claude", ["--version"], {
      timeout: 2000,
      maxBuffer: 1024,
    });
    const match = stdout.match(/(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * 2. Fetch version from NPM registry dist-tags
 */
export async function tryGetNpmVersion(
  channel: "stable" | "latest" = "stable"
): Promise<string | null> {
  try {
    const res = await fetch(NPM_REGISTRY_URL, {
      signal: AbortSignal.timeout(3000),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;

    const data = (await res.json()) as { "dist-tags"?: Record<string, string> };
    const distTags = data["dist-tags"] || {};

    const resolved = distTags[channel] || distTags.stable || distTags.latest || null;

    if (typeof resolved === "string" && resolved.trim()) {
      return resolved.trim();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Core Resolver function
 */
export async function resolveClaudeCodeIdentity(
  options: ClaudeCodeResolverOptions = {}
): Promise<ClaudeCodeIdentity> {
  const envMode = (process.env.CLAUDE_CODE_VERSION_MODE || "").trim().toLowerCase();
  const mode = options.mode || (envMode === "installed" || envMode === "fixed" ? envMode : "auto");

  const envChannel = (process.env.CLAUDE_CODE_VERSION_CHANNEL || "").trim().toLowerCase();
  const channel = options.channel || (envChannel === "latest" ? "latest" : "stable");

  const fixedVersion = options.fixedVersion || process.env.CLAUDE_CODE_CLIENT_VERSION?.trim();

  // Mode: Fixed or explicit env fixed version
  if (mode === "fixed" || (fixedVersion && mode !== "installed")) {
    if (fixedVersion) {
      return buildIdentity(fixedVersion);
    }
  }

  // Mode: Installed
  if (mode === "installed" || mode === "auto") {
    const installed = await tryGetInstalledVersion();
    if (installed) {
      return buildIdentity(installed);
    }
    if (mode === "installed") {
      return FALLBACK_CLAUDE_CODE_IDENTITY;
    }
  }

  // Mode: Auto -> NPM registry
  const npmVersion = await tryGetNpmVersion(channel);
  if (npmVersion) {
    return buildIdentity(npmVersion);
  }

  return FALLBACK_CLAUDE_CODE_IDENTITY;
}

/**
 * Background refresh without blocking active requests (SWR)
 */
export async function refreshClaudeCodeIdentity(
  options?: ClaudeCodeResolverOptions
): Promise<ClaudeCodeIdentity> {
  if (isRefreshing) return activeIdentity;
  isRefreshing = true;
  try {
    const envTtl = Number(process.env.CLAUDE_CODE_VERSION_CACHE_TTL);
    const ttl =
      (Number.isFinite(envTtl) && envTtl > 0 ? envTtl * 1000 : null) ||
      options?.cacheTtlMs ||
      DEFAULT_CACHE_TTL_MS;
    activeIdentity = await resolveClaudeCodeIdentity(options);
    cacheExpiresAt = Date.now() + ttl;
    return activeIdentity;
  } catch {
    return activeIdentity;
  } finally {
    isRefreshing = false;
  }
}

/**
 * App initialization hook (called at server bootstrap)
 */
export async function initClaudeCodeIdentity(
  options?: ClaudeCodeResolverOptions
): Promise<ClaudeCodeIdentity> {
  return refreshClaudeCodeIdentity(options);
}

/**
 * Synchronous Hot-Path Accessor (0ms overhead)
 * Returns the active snapshot immediately; triggers background revalidation if expired.
 */
export function getClaudeCodeIdentity(): ClaudeCodeIdentity {
  if (Date.now() > cacheExpiresAt && !isRefreshing) {
    void refreshClaudeCodeIdentity();
  }
  return activeIdentity;
}

// Test / debugging utilities
export function setClaudeCodeIdentityForTesting(identity: ClaudeCodeIdentity | null): void {
  activeIdentity = identity || FALLBACK_CLAUDE_CODE_IDENTITY;
  cacheExpiresAt = identity ? Date.now() + 1000 * 60 * 60 : 0;
}

export function resetClaudeCodeIdentityForTesting(): void {
  activeIdentity = FALLBACK_CLAUDE_CODE_IDENTITY;
  cacheExpiresAt = 0;
  isRefreshing = false;
}
