import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  computeSha256Hex,
  verifyApiKeySignature,
  verifyKeyV1,
  verifyKeyV2,
} from "../src/key-verifier.ts";

const TEST_SECRET = "b6805c3a729c47cdf956434935397502b599386e4f6e784df9f7660d76c140ca";

test("key-verifier: computeSha256Hex produces standard hex digest", async () => {
  const hash = await computeSha256Hex("hello world");
  assert.equal(hash, "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
});

test("key-verifier: verifyKeyV2 validates valid 128-bit MAC", async () => {
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

test("key-verifier: verifyKeyV1 matches Node pbkdf2Sync output exactly", async () => {
  const machineId = "machine123456789";
  const keyId = "abcdef";
  const crcNode = crypto
    .pbkdf2Sync(machineId + keyId, TEST_SECRET, 1000, 32, "sha256")
    .toString("hex")
    .slice(0, 8);

  const v1Key = `sk-${machineId}-${keyId}-${crcNode}`;
  const res = await verifyKeyV1(v1Key, TEST_SECRET);
  assert.equal(res.valid, true);
  assert.equal(res.keyId, keyId);
  assert.equal(res.machineId, machineId);

  // Invalid CRC
  const invalidKey = `sk-${machineId}-${keyId}-00000000`;
  const invalidRes = await verifyKeyV1(invalidKey, TEST_SECRET);
  assert.equal(invalidRes.valid, false);
});

test("key-verifier: verifyApiKeySignature handles v2 and v1", async () => {
  // Key v2
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

  const verifiedV2 = await verifyApiKeySignature(v2Key, TEST_SECRET);
  assert.ok(verifiedV2);
  assert.equal(verifiedV2.valid, true);
  assert.equal(verifiedV2.keyId, keyId);
  assert.equal(verifiedV2.version, "v2");
  // Key v1
  const machineId = "testmachine12345";
  const v1KeyId = "123456";
  const crc = crypto.pbkdf2Sync(machineId + v1KeyId, TEST_SECRET, 1000, 32, "sha256").toString("hex").slice(0, 8);
  const v1Key = `sk-${machineId}-${v1KeyId}-${crc}`;

  const verifiedV1 = await verifyApiKeySignature(v1Key, TEST_SECRET);
  assert.ok(verifiedV1);
  assert.equal(verifiedV1.valid, true);
  assert.equal(verifiedV1.keyId, v1KeyId);
  assert.equal(verifiedV1.version, "v1");

  // Invalid random token
  assert.equal(await verifyApiKeySignature("sk-random123456", TEST_SECRET), null);
  assert.equal(await verifyApiKeySignature("bearer-invalid", TEST_SECRET), null);
});
