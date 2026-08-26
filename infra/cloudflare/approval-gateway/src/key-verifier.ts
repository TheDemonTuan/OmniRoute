/**
 * Web Crypto cryptographic verifier for API key signatures at the Cloudflare Edge.
 */

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Compute SHA-256 hash of a string (returns hex string)
 */
export async function computeSha256Hex(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const buffer = await crypto.subtle.digest("SHA-256", encoder.encode(data));
  return bytesToHex(new Uint8Array(buffer));
}

/**
 * Verify Key v2 format: sk-v2-{keyId}-{mac32}
 * Uses HMAC-SHA256 over "v2:{keyId}" truncated to 128 bits (32 hex characters).
 */
export async function verifyKeyV2(
  apiKey: string,
  secret: string
): Promise<{ valid: boolean; keyId: string | null }> {
  if (!apiKey.startsWith("sk-v2-")) {
    return { valid: false, keyId: null };
  }

  const parts = apiKey.split("-");
  if (parts.length !== 4) return { valid: false, keyId: null };

  const [, version, keyId, providedMac] = parts;
  if (version !== "v2" || !keyId || keyId.length < 6 || !providedMac || providedMac.length !== 32) {
    return { valid: false, keyId: null };
  }

  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`v2:${keyId}`));
    const fullMacHex = bytesToHex(new Uint8Array(signature));
    const expectedMac = fullMacHex.slice(0, 32);

    const isValid = constantTimeCompare(providedMac.toLowerCase(), expectedMac.toLowerCase());
    return { valid: isValid, keyId: isValid ? keyId : null };
  } catch {
    return { valid: false, keyId: null };
  }
}

/**
 * Verify Key v1 format: sk-{machineId}-{keyId}-{crc8}
 * Uses PBKDF2-SHA256(password=machineId+keyId, salt=secret, iterations=1000, keylen=32) truncated to 8 hex chars.
 */
export async function verifyKeyV1(
  apiKey: string,
  secret: string
): Promise<{ valid: boolean; keyId: string | null; machineId: string | null }> {
  if (!apiKey.startsWith("sk-")) {
    return { valid: false, keyId: null, machineId: null };
  }

  const parts = apiKey.split("-");
  if (parts.length !== 4 || parts[1] === "v2") {
    return { valid: false, keyId: null, machineId: null };
  }

  const [, machineId, keyId, providedCrc] = parts;
  if (!machineId || !keyId || !providedCrc || providedCrc.length !== 8) {
    return { valid: false, keyId: null, machineId: null };
  }

  try {
    const encoder = new TextEncoder();
    // In Node.js: crypto.pbkdf2Sync(machineId + keyId, secret, 1000, 32, "sha256")
    // Password is (machineId + keyId), Salt is secret
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      encoder.encode(machineId + keyId),
      { name: "PBKDF2" },
      false,
      ["deriveBits"]
    );

    const derivedBits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: encoder.encode(secret),
        iterations: 1000,
        hash: "SHA-256",
      },
      keyMaterial,
      256
    );

    const fullHex = bytesToHex(new Uint8Array(derivedBits));
    const expectedCrc = fullHex.slice(0, 8);

    const isValid = constantTimeCompare(providedCrc.toLowerCase(), expectedCrc.toLowerCase());
    return { valid: isValid, keyId: isValid ? keyId : null, machineId: isValid ? machineId : null };
  } catch {
    return { valid: false, keyId: null, machineId: null };
  }
}

/**
 * Verify any presented OmniRoute API key against the edge secret
 */
export async function verifyApiKeySignature(
  apiKey: string,
  secret: string,
  allowLegacyV1: boolean = true
): Promise<{ valid: boolean; keyId: string; version: "v2" | "v1" } | null> {
  if (!apiKey || typeof apiKey !== "string") return null;

  // Try Key v2
  if (apiKey.startsWith("sk-v2-")) {
    const res = await verifyKeyV2(apiKey, secret);
    if (res.valid && res.keyId) {
      return { valid: true, keyId: res.keyId, version: "v2" };
    }
    return null;
  }

  // Try Key v1
  if (allowLegacyV1 && apiKey.startsWith("sk-")) {
    const res = await verifyKeyV1(apiKey, secret);
    if (res.valid && res.keyId) {
      return { valid: true, keyId: res.keyId, version: "v1" };
    }
  }

  return null;
}
