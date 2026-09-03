/**
 * Dynamic Claude Code identity resolver.
 *
 * Resolves the Claude Code CLI wire-identity (version, sdkVersion,
 * runtimeVersion, user-agents) using:
 *   1. Environment override (CLAUDE_CODE_CLIENT_VERSION / mode='fixed')
 *   2. NPM registry dist-tags (@anthropic-ai/claude-code: latest | stable)
 *   3. Installed local binary (`claude --version` if mode='installed' or 'auto')
 *   4. Bundled fallback identity
 *
 * Employs an in-memory SWR (stale-while-revalidate) cache so hot-path calls
 * to `getClaudeCodeIdentity()` have zero latency and never block requests.
 */

import wireVersions from "../data/claudeCodeWireVersions.json";

export interface ClaudeCodeIdentity {
  readonly version: string;
  readonly sdkVersion: string;
  readonly runtimeVersion: string;
  readonly userAgentCli: string;
  readonly userAgentSdkCli: string;
}

export interface ClaudeCodeWireMetadata {
  readonly sdkVersion: string;
  readonly runtimeVersion: string;
}

export interface ClaudeCodeResolverOptions {
  mode?: "auto" | "installed" | "fixed";
  channel?: "stable" | "latest";
  fixedVersion?: string;
  cacheTtlMs?: number;
}

export const FALLBACK_WIRE_METADATA: ClaudeCodeWireMetadata = Object.freeze({
  sdkVersion: "0.94.0",
  runtimeVersion: typeof process !== "undefined" && process.version ? process.version : "v24.3.0",
});

export const FALLBACK_CLAUDE_CODE_IDENTITY: ClaudeCodeIdentity = Object.freeze({
  version: "2.1.258",
  sdkVersion: "0.94.0",
  runtimeVersion: typeof process !== "undefined" && process.version ? process.version : "v24.3.0",
  userAgentCli: "claude-cli/2.1.258 (external, cli)",
  userAgentSdkCli: "claude-cli/2.1.258 (external, sdk-cli)",
});

const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const NPM_REGISTRY_URL = "https://registry.npmjs.org/@anthropic-ai/claude-code";
const BILLING_SALT = "59cf53e54c78";
const BILLING_INDICES = [4, 7, 20] as const;

let activeIdentity: ClaudeCodeIdentity = FALLBACK_CLAUDE_CODE_IDENTITY;
let cacheExpiresAt = 0;
let isRefreshing = false;

function sha256Hex(input: string): string {
  try {
    const cryptoModule = require("crypto");
    return cryptoModule.createHash("sha256").update(input, "utf8").digest("hex");
  } catch {
    return "000000";
  }
}

/**
 * Compute the dynamic cc_version header value (e.g. 2.1.259.xxx)
 * where xxx is a 3-character hex fingerprint computed from the version
 * and sampled characters of the first user message.
 */
export function computeClaudeCodeBillingVersion(version: string, firstUserMessage = ""): string {
  const cleanVersion = String(version || "")
    .trim()
    .replace(/^v/, "");
  const sampled = BILLING_INDICES.map((index) =>
    typeof firstUserMessage[index] === "string" ? firstUserMessage[index] : "\0"
  ).join("");

  const suffix = sha256Hex(`${BILLING_SALT}${sampled}${cleanVersion}`).slice(0, 3);
  return `${cleanVersion}.${suffix}`;
}

export function resolveWireMetadata(version: string): ClaudeCodeWireMetadata {
  const clean = String(version || "")
    .trim()
    .replace(/^v/, "");
  const found = (wireVersions as Record<string, ClaudeCodeWireMetadata>)[clean];
  if (found && typeof found.sdkVersion === "string" && typeof found.runtimeVersion === "string") {
    return found;
  }
  return FALLBACK_WIRE_METADATA;
}

export function buildIdentity(
  version: string,
  sdkVersion?: string,
  runtimeVersion?: string
): ClaudeCodeIdentity {
  const cleanVersion = String(version || "")
    .trim()
    .replace(/^v/, "");
  const meta = resolveWireMetadata(cleanVersion);
  const cleanSdk = String(sdkVersion || meta.sdkVersion).trim();
  const cleanRuntime = String(runtimeVersion || meta.runtimeVersion).trim();

  return Object.freeze({
    version: cleanVersion,
    sdkVersion: cleanSdk,
    runtimeVersion: cleanRuntime,
    userAgentCli: `claude-cli/${cleanVersion} (external, cli)`,
    userAgentSdkCli: `claude-cli/${cleanVersion} (external, sdk-cli)`,
  });
}

/**
 * 1. Probe local installed CLI: `claude --version`
 * Uses execFile directly (no shell interpolation) per Hard Rule #13.
 * Dynamic import with webpackIgnore prevents bundling Node built-ins on the client.
 */
export async function tryGetInstalledVersion(): Promise<string | null> {
  if (typeof window !== "undefined" || typeof process === "undefined") {
    return null;
  }
  try {
    const cp = await import(/* webpackIgnore: true */ "node:child_process");
    const util = await import(/* webpackIgnore: true */ "node:util");
    const execFileAsync = util.promisify(cp.execFile);
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
  channel: "stable" | "latest" = "latest"
): Promise<string | null> {
  if (typeof fetch !== "function") return null;
  try {
    const res = await fetch(NPM_REGISTRY_URL, {
      signal: AbortSignal.timeout(3000),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;

    const data = (await res.json()) as { "dist-tags"?: Record<string, string> };
    const distTags = data["dist-tags"] || {};

    const resolved = distTags[channel] || distTags.latest || distTags.stable || null;

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
  const envMode =
    typeof process !== "undefined" && process.env
      ? (process.env.CLAUDE_CODE_VERSION_MODE || "").trim().toLowerCase()
      : "";
  const mode = options.mode || (envMode === "installed" || envMode === "fixed" ? envMode : "auto");

  const envChannel =
    typeof process !== "undefined" && process.env
      ? (process.env.CLAUDE_CODE_VERSION_CHANNEL || "").trim().toLowerCase()
      : "";
  const channel = options.channel || (envChannel === "stable" ? "stable" : "latest");

  const fixedVersion =
    options.fixedVersion ||
    (typeof process !== "undefined" && process.env
      ? process.env.CLAUDE_CODE_CLIENT_VERSION?.trim()
      : undefined);

  // Mode: Fixed or explicit env fixed version
  if (mode === "fixed" || (fixedVersion && mode !== "installed")) {
    if (fixedVersion) {
      return buildIdentity(fixedVersion);
    }
    return FALLBACK_CLAUDE_CODE_IDENTITY;
  }

  // Mode: Installed (user explicitly requested local binary)
  if (mode === "installed") {
    const installed = await tryGetInstalledVersion();
    if (installed) {
      return buildIdentity(installed);
    }
    return FALLBACK_CLAUDE_CODE_IDENTITY;
  }

  // Mode: Auto (Default)
  // 1. NPM registry (channel: latest by default)
  // 2. Locally installed CLI binary
  // 3. Fallback bundled version
  const npmVersion = await tryGetNpmVersion(channel);
  if (npmVersion) {
    return buildIdentity(npmVersion);
  }

  const installed = await tryGetInstalledVersion();
  if (installed) {
    return buildIdentity(installed);
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
    const envTtl =
      typeof process !== "undefined" && process.env
        ? Number(process.env.CLAUDE_CODE_VERSION_CACHE_TTL)
        : 0;
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
