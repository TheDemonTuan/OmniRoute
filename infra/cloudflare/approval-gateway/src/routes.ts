import type { RouteType, ExtractedCredential } from "./types";

const STATIC_EXTENSIONS = new Set([
  "js",
  "css",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "ico",
  "woff",
  "woff2",
  "ttf",
  "eot",
  "map",
  "json",
  "txt",
]);

const PUBLIC_EXACT_PATHS = new Set([
  "/api/health",
  "/api/health/ping",
  "/api/monitoring/health",
  "/api/settings/require-login",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/status",
  "/api/init",
  "/api/sync/bundle",
  "/api/cli/connect",
  "/api/usage/om-usage",
  "/api/skills/collect/chaos",
  "/favicon.ico",
  "/robots.txt",
  "/sitemap.xml",
]);

const PUBLIC_PREFIXES = [
  "/_next/",
  "/api/auth/oidc/",
  "/api/oauth/",
  "/api/codex/connect/",
  "/api/telegram/",
];

/**
 * Classify incoming request URL path into functional RouteType
 */
export function classifyRequestPath(pathname: string): RouteType {
  let normalized = pathname || "/";
  if (!normalized.startsWith("/")) normalized = "/" + normalized;
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }

  // Telegram bot webhook route -> pass directly to origin
  if (normalized === "/tg-ops" || normalized.startsWith("/tg-ops/")) {
    return "TELEGRAM_WEBHOOK";
  }

  // Edge control plane -> intercept at edge
  if (normalized === "/__edge-control" || normalized.startsWith("/__edge-control/")) {
    return "EDGE_CONTROL";
  }

  // Exact public endpoints
  if (PUBLIC_EXACT_PATHS.has(normalized)) {
    return "PUBLIC";
  }

  // Public prefixes (Next assets, OAuth callbacks, Telegram update proxy)
  for (const prefix of PUBLIC_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      return "PUBLIC";
    }
  }

  // Check static file extension
  const dotIndex = normalized.lastIndexOf(".");
  if (dotIndex !== -1) {
    const ext = normalized.slice(dotIndex + 1).toLowerCase();
    if (STATIC_EXTENSIONS.has(ext)) {
      return "PUBLIC";
    }
  }

  // Dashboard pages and root dashboard redirect
  if (normalized === "/" || normalized === "/dashboard" || normalized.startsWith("/dashboard/")) {
    return "DASHBOARD";
  }

  // Default to CLIENT_API for all proxy / completions / responses routes
  return "CLIENT_API";
}

/**
 * Extract API credential from standard headers or tokenized URL paths
 */
export function extractClientCredential(request: Request): ExtractedCredential | null {
  const headers = request.headers;

  // 1. Authorization: Bearer <key>
  const authHeader = headers.get("authorization") || headers.get("Authorization");
  if (authHeader) {
    const trimmed = authHeader.trim();
    if (trimmed.toLowerCase().startsWith("bearer ")) {
      const token = trimmed.slice(7).trim();
      if (token && token.startsWith("sk-")) {
        return { apiKey: token, transport: "bearer" };
      }
    }
  }

  // 2. x-api-key: <key>
  const xApiKey = headers.get("x-api-key") || headers.get("X-Api-Key");
  if (xApiKey) {
    const token = xApiKey.trim();
    if (token && token.startsWith("sk-")) {
      return { apiKey: token, transport: "x-api-key" };
    }
  }

  // 3. x-goog-api-key: <key> (Gemini CLI / @google/genai)
  const xGoogApiKey = headers.get("x-goog-api-key") || headers.get("X-Goog-Api-Key");
  if (xGoogApiKey) {
    const token = xGoogApiKey.trim();
    if (token && token.startsWith("sk-")) {
      return { apiKey: token, transport: "x-goog-api-key" };
    }
  }

  // 4. Tokenized URL path (/api/v1/vscode/{token}/... or /vscode/{token}/...)
  try {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);

    // Format: /api/v1/vscode/{token}/...
    if (segments[0] === "api" && segments[1] === "v1" && segments[2] === "vscode" && segments[3]) {
      const token = decodeURIComponent(segments[3]).trim();
      if (token && token.startsWith("sk-")) {
        return { apiKey: token, transport: "path-token" };
      }
    }

    // Format: /vscode/{token}/...
    if (segments[0] === "vscode" && segments[1]) {
      const token = decodeURIComponent(segments[1]).trim();
      if (token && token.startsWith("sk-")) {
        return { apiKey: token, transport: "path-token" };
      }
    }
  } catch {
    /* ignore URL parsing failure */
  }

  return null;
}

/**
 * Mask an API key string for safe logging and Telegram display
 */
export function maskApiKey(apiKey: string): string {
  if (!apiKey || typeof apiKey !== "string") return "sk-unknown";
  if (apiKey.length <= 12) return apiKey.slice(0, 4) + "****";
  return apiKey.slice(0, 10) + "****" + apiKey.slice(-4);
}
