/** Credential import boundary. Structural validation is NOT a live login check. */
type RecordValue = Record<string, unknown>;
export interface ImportedCookie extends RecordValue {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}
export interface ImportedOrigin extends RecordValue {
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
}
export interface ImportedChatGptState {
  cookies: ImportedCookie[];
  origins: ImportedOrigin[];
}
export class ChatGptWebAuthInputError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "ChatGptWebAuthInputError";
    this.code = code;
  }
}
const MAX_BYTES = 4 * 1024 * 1024;
const SESSION_NAME = /^__Secure-next-auth\.session-token(?:\.\d+)?$/;
const COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
function fail(code: string, message: string): never {
  throw new ChatGptWebAuthInputError(code, message);
}
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function firstPartyHost(host: string): boolean {
  return ["chatgpt.com", "openai.com"].some((base) => host === base || host.endsWith(`.${base}`));
}
function bool(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") fail("AUTH_COOKIE_SCHEMA", "Cookie flags must be booleans.");
  return value;
}
function cookie(value: unknown): ImportedCookie {
  if (
    !record(value) ||
    typeof value.name !== "string" ||
    !COOKIE_NAME.test(value.name) ||
    typeof value.value !== "string" ||
    /[\r\n;]/.test(value.value) ||
    (value.domain !== undefined && typeof value.domain !== "string")
  ) {
    fail("AUTH_COOKIE_SCHEMA", "Cookie entries need valid name, value and domain fields.");
  }
  let domain = (typeof value.domain === "string" ? value.domain : ".chatgpt.com").toLowerCase();
  const host = domain.replace(/^\./, "");
  if (
    !/^[a-z0-9.-]+$/.test(host) ||
    host.startsWith(".") ||
    host.endsWith(".") ||
    host.includes("..") ||
    !firstPartyHost(host)
  ) {
    fail(
      "AUTH_FOREIGN_COOKIE_DOMAIN",
      "ChatGPT Web browser storage state contains a foreign cookie domain. Only chatgpt.com/openai.com cookie domains are accepted. Export only this account's first-party data."
    );
  }
  if (value.hostOnly !== undefined && typeof value.hostOnly !== "boolean") {
    fail("AUTH_COOKIE_SCHEMA", "hostOnly must be a boolean.");
  }
  if (value.hostOnly === true) domain = host;
  const path = value.path === undefined ? "/" : value.path;
  if (typeof path !== "string" || !path.startsWith("/") || /[\r\n]/.test(path)) {
    fail("AUTH_COOKIE_SCHEMA", "Cookie path must begin with a slash.");
  }
  const secure = bool(value.secure, true);
  const httpOnly = bool(
    value.httpOnly,
    value.name.startsWith("__Secure-") || value.name.startsWith("__Host-")
  );
  const session = bool(value.session, false);
  const expires = session ? -1 : (value.expires ?? value.expirationDate ?? -1);
  if (typeof expires !== "number" || !Number.isFinite(expires) || (expires < 0 && expires !== -1)) {
    fail("AUTH_COOKIE_EXPIRY", "Cookie expiry must be Unix seconds, or -1 for a session cookie.");
  }
  if (expires > 100_000_000_000) {
    fail(
      "AUTH_COOKIE_EXPIRY",
      "Cookie expiry appears to use milliseconds; export Unix seconds instead."
    );
  }
  const sameSiteValue = value.sameSite === undefined ? "lax" : String(value.sameSite).toLowerCase();
  const sites: Record<string, "Strict" | "Lax" | "None"> = {
    strict: "Strict",
    lax: "Lax",
    none: "None",
    no_restriction: "None",
    unspecified: "Lax",
  };
  const sameSite = Object.hasOwn(sites, sameSiteValue) ? sites[sameSiteValue] : undefined;
  if (!sameSite)
    fail(
      "AUTH_COOKIE_SAMESITE",
      "Cookie sameSite must be Strict, Lax or None (extension spellings are supported)."
    );
  if (sameSite === "None" && !secure) fail("AUTH_COOKIE_SCHEMA", "SameSite=None requires Secure.");
  if (value.name.startsWith("__Secure-") && !secure)
    fail("AUTH_COOKIE_SCHEMA", "__Secure- cookies require Secure.");
  if (value.name.startsWith("__Host-") && (!secure || path !== "/" || domain.startsWith("."))) {
    fail("AUTH_COOKIE_SCHEMA", "__Host- cookies require a host-only domain, Secure and path=/.");
  }
  if (value.partitionKey !== undefined) {
    fail(
      "AUTH_PARTITIONED_COOKIE_UNSUPPORTED",
      "Partitioned cookie imports need an explicit account-browser migration; they are not silently flattened."
    );
  }
  return {
    name: value.name,
    value: value.value,
    domain,
    path,
    expires,
    httpOnly,
    secure,
    sameSite,
  };
}
function origin(value: unknown): ImportedOrigin {
  if (!record(value) || typeof value.origin !== "string" || !Array.isArray(value.localStorage)) {
    fail("AUTH_ORIGIN_SCHEMA", "Each origin needs an origin URL and a localStorage array.");
  }
  let url: URL;
  try {
    url = new URL(value.origin);
  } catch {
    fail("AUTH_ORIGIN_SCHEMA", "Origin URL is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    !firstPartyHost(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    fail(
      "AUTH_FOREIGN_ORIGIN",
      "Only canonical HTTPS first-party origins are accepted; paths, credentials and non-default ports are rejected."
    );
  }
  const localStorage = value.localStorage.map((entry) => {
    if (!record(entry) || typeof entry.name !== "string" || typeof entry.value !== "string") {
      fail("AUTH_LOCAL_STORAGE_SCHEMA", "Local storage entries need string name and value fields.");
    }
    return { name: entry.name, value: entry.value };
  });
  if (
    value.indexedDB !== undefined &&
    (!Array.isArray(value.indexedDB) || value.indexedDB.length > 0)
  ) {
    fail(
      "AUTH_INDEXED_DB_UNSUPPORTED",
      "This importer does not migrate IndexedDB. Use the dedicated account browser instead."
    );
  }
  return { origin: url.origin, localStorage };
}
function fromCookieHeader(raw: string, allowBareSessionToken: boolean): ImportedChatGptState {
  const header = raw.trim().replace(/^cookie\s*:\s*/i, "");
  if (!header || /[\r\n]/.test(header))
    fail("AUTH_COOKIE_HEADER", "Paste one Cookie header, not a complete HTTP request.");
  const pairs = header
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((pair) => {
      const equals = pair.indexOf("=");
      if (equals <= 0) {
        if (allowBareSessionToken && !header.includes(";") && !header.includes("=")) {
          return ["__Secure-next-auth.session-token", pair] as const;
        }
        fail(
          "AUTH_COOKIE_HEADER",
          "Expected Cookie: name=value; name=value, or a JSON cookie export/storage state."
        );
      }
      return [pair.slice(0, equals).trim(), pair.slice(equals + 1)] as const;
    });
  if (!pairs.some(([name, value]) => SESSION_NAME.test(name) && value.length > 0)) {
    fail(
      "AUTH_SESSION_COOKIE_MISSING",
      "Cookie header is missing __Secure-next-auth.session-token (chunked session cookies are supported)."
    );
  }
  return {
    cookies: pairs.map(([name, value]) =>
      cookie({ name, value, domain: name.startsWith("__Host-") ? "chatgpt.com" : ".chatgpt.com" })
    ),
    origins: [],
  };
}
export function normalizeChatGptWebAuthInput(
  input: unknown,
  options: { allowBareSessionToken?: boolean; allowEmptyCookies?: boolean } = {}
): ImportedChatGptState {
  let value = input;
  if (typeof value === "string") {
    if (new TextEncoder().encode(value).byteLength > MAX_BYTES)
      fail("AUTH_INPUT_TOO_LARGE", "Credential input exceeds 4 MiB.");
    const text = value.trim();
    if (!text) fail("AUTH_INPUT_REQUIRED", "ChatGPT browser credentials are required.");
    if (/^[\[{]/.test(text)) {
      try {
        value = JSON.parse(text);
      } catch {
        fail(
          "AUTH_JSON_SYNTAX",
          "Malformed JSON. Re-export the cookie data; secret contents were not included in this error."
        );
      }
    } else {
      return fromCookieHeader(text, options.allowBareSessionToken === true);
    }
  }
  if (Array.isArray(value)) value = { cookies: value, origins: [] };
  if (
    !record(value) ||
    !Array.isArray(value.cookies) ||
    (value.origins !== undefined && !Array.isArray(value.origins))
  ) {
    fail(
      "AUTH_STORAGE_STATE_SCHEMA",
      "Expected a cookie array or {cookies: [...], origins: [...]}; account/session API JSON is not a browser storage state."
    );
  }
  if (value.cookies.length === 0 && !options.allowEmptyCookies)
    fail("AUTH_COOKIES_REQUIRED", "Browser credentials must contain first-party cookies.");
  if (value.cookies.length > 4096) fail("AUTH_INPUT_TOO_LARGE", "Too many cookie entries.");
  const origins = value.origins === undefined ? [] : (value.origins as unknown[]);
  if (origins.length > 128) fail("AUTH_INPUT_TOO_LARGE", "Too many storage origins.");
  return { cookies: value.cookies.map(cookie), origins: origins.map(origin) };
}
