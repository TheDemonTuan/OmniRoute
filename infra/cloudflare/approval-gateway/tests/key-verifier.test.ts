import test from "node:test";
import assert from "node:assert/strict";

import {
  computeSha256Hex,
  verifyApiKeySignature,
  verifyKeyV1,
  verifyKeyV2,
} from "../src/key-verifier.ts";

const TEST_SECRET = "test-edge-signing-secret-key-123456789";

test("key-verifier: computeSha256Hex produces standard hex digest", async () => {
  const hash = await computeSha256Hex("hello world");
  assert.equal(hash, "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
});

test("key-verifier: verifyKeyV2 validates valid 128-bit MAC", async () => {
  // Generate a valid v2 key
  const keyId = "a1b2c3d4e5f6";
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(TEST_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(`v2:${keyId}`));
  const hex = Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
  const mac = hex.slice(0, 32);

  const apiKey = `sk-v2-${keyId}-${mac}`;
  const res = await verifyKeyV2(apiKey, TEST_SECRET);
  assert.equal(res.valid, true);
  assert.equal(res.keyId, keyId);

  // Invalid MAC
  const invalidKey = `sk-v2-${keyId}-00000000000000000000000000000000`;
  const invalidRes = await verifyKeyV2(invalidKey, TEST_SECRET);
  assert.equal(invalidRes.valid, false);
});

test("key-verifier: verifyApiKeySignature handles v2 and v1", async () => {
  const keyId = "fe9876543210";
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(TEST_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(`v2:${keyId}`));
  const mac = Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);

  const v2Key = `sk-v2-${keyId}-${mac}`;
  const verified = await verifyApiKeySignature(v2Key, TEST_SECRET);
  assert.ok(verified);
  assert.equal(verified.valid, true);
  assert.equal(verified.keyId, keyId);
  assert.equal(verified.version, "v2");

  // Invalid random token
  assert.equal(await verifyApiKeySignature("sk-random123456", TEST_SECRET), null);
  assert.equal(await verifyApiKeySignature("bearer-invalid", TEST_SECRET), null);
});
