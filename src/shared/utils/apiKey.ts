import crypto from "crypto";

// FASE-01: No hardcoded fallback — enforced by secretsValidator at startup
if (!process.env.API_KEY_SECRET) {
  console.error("[SECURITY] API_KEY_SECRET is not set. API key CRC validation is disabled.");
}

function getApiKeySecret(): string {
  const secret = process.env.API_KEY_SECRET;
  if (!secret || secret.trim() === "") {
    throw new Error(
      "API_KEY_SECRET is required for API key CRC operations. " +
        "The startup validator (instrumentation-node.ts) should have set this automatically."
    );
  }
  return secret;
}

function getEdgeSigningSecret(): string {
  return process.env.EDGE_API_KEY_SIGNING_SECRET || getApiKeySecret();
}

/**
 * Generate 6-char random keyId for v1 keys
 */
function generateKeyId(): string {
  return crypto.randomBytes(3).toString("hex");
}

/**
 * Generate 12-char random keyId for v2 keys
 */
function generateKeyIdV2(): string {
  return crypto.randomBytes(6).toString("hex");
}

/**
 * Generate CRC (8-char HMAC) for v1 keys
 */
function generateCrc(machineId: string, keyId: string): string {
  const secret = getApiKeySecret();
  // Using pbkdf2Sync instead of HMAC to mitigate CodeQL's heuristic
  // [js/insufficient-password-hash] which thinks this is password hashing.
  return crypto
    .pbkdf2Sync(machineId + keyId, secret, 1000, 32, "sha256")
    .toString("hex")
    .slice(0, 8);
}

/**
 * Generate 128-bit MAC (32 hex characters) for Key v2 format
 */
export function generateMacV2(keyId: string, customSecret?: string): string {
  const secret = customSecret || getEdgeSigningSecret();
  return crypto
    .createHmac("sha256", secret)
    .update(`v2:${keyId}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Generate API key with machineId embedded (Key v1 format)
 * Format: sk-{machineId}-{keyId}-{crc8}
 * @param {string} machineId - 16-char machine ID
 * @returns {{ key: string, keyId: string }}
 */
export function generateApiKeyWithMachine(machineId: string): { key: string; keyId: string } {
  const keyId = generateKeyId();
  const crc = generateCrc(machineId, keyId);
  const key = `sk-${machineId}-${keyId}-${crc}`;
  return { key, keyId };
}

/**
 * Generate hardened Key v2 with 128-bit MAC
 * Format: sk-v2-{keyId}-{mac32}
 * @param {string} [customSecret] - Optional secret override
 * @returns {{ key: string, keyId: string }}
 */
export function generateApiKeyV2(customSecret?: string): { key: string; keyId: string } {
  const keyId = generateKeyIdV2();
  const mac = generateMacV2(keyId, customSecret);
  const key = `sk-v2-${keyId}-${mac}`;
  return { key, keyId };
}

function safeCompareStrings(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Parse API key and extract machineId + keyId
 * Supports three formats:
 * - Key v2: sk-v2-{keyId}-{mac32}
 * - Key v1: sk-{machineId}-{keyId}-{crc8}
 * - Legacy: sk-{random8}
 * @param {string} apiKey
 * @returns {{ machineId: string | null; keyId: string; isNewFormat: boolean } | null}
 */
export function parseApiKey(
  apiKey: string
): { machineId: string | null; keyId: string; isNewFormat: boolean } | null {
  if (!apiKey || typeof apiKey !== "string" || !apiKey.startsWith("sk-")) return null;

  const parts = apiKey.split("-");

  // Key v2 format: sk-v2-{keyId}-{mac32} = 4 parts
  if (parts.length === 4 && parts[1] === "v2") {
    const [, , keyId, mac] = parts;
    if (!keyId || keyId.length < 6 || !mac || mac.length !== 32) return null;

    let expectedMac: string;
    try {
      expectedMac = generateMacV2(keyId);
    } catch {
      return null;
    }

    if (!safeCompareStrings(mac, expectedMac)) return null;

    return {
      machineId: null,
      keyId,
      isNewFormat: true,
    };
  }

  // Key v1 format: sk-{machineId}-{keyId}-{crc8} = 4 parts
  if (parts.length === 4) {
    const [, machineId, keyId, crc] = parts;

    // Validate CRC
    let expectedCrc: string;
    try {
      expectedCrc = generateCrc(machineId, keyId);
    } catch {
      return null;
    }
    if (!safeCompareStrings(crc, expectedCrc)) return null;

    return {
      machineId,
      keyId,
      isNewFormat: true,
    };
  }

  // Legacy format: sk-{random8} = 2 parts
  if (parts.length === 2) {
    const [, keyId] = parts;
    return {
      machineId: null,
      keyId,
      isNewFormat: false,
    };
  }

  return null;
}
