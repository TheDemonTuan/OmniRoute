import test from "node:test";
import assert from "node:assert/strict";

process.env.API_KEY_SECRET = "test-api-key-secret-1234567890";
process.env.EDGE_API_KEY_SIGNING_SECRET = "test-edge-signing-secret-0987654321";

const apiKeyUtils = await import("../../src/shared/utils/apiKey.ts");

test("Key v2 format generation and parsing with 128-bit MAC", () => {
  const { key, keyId } = apiKeyUtils.generateApiKeyV2();

  assert.equal(typeof key, "string");
  assert.equal(typeof keyId, "string");
  assert.match(key, /^sk-v2-[a-f0-9]{12}-[a-f0-9]{32}$/);

  const parsed = apiKeyUtils.parseApiKey(key);
  assert.deepEqual(parsed, {
    machineId: null,
    keyId,
    isNewFormat: true,
  });
});

test("Key v2 rejects altered MAC or altered keyId", () => {
  const { key, keyId } = apiKeyUtils.generateApiKeyV2();
  const parts = key.split("-");

  // Tamper MAC
  const tamperedMac = parts[3].slice(0, -1) + (parts[3].endsWith("a") ? "b" : "a");
  const tamperedKey = `sk-v2-${keyId}-${tamperedMac}`;
  assert.equal(apiKeyUtils.parseApiKey(tamperedKey), null);

  // Tamper keyId
  const tamperedKeyId = "f" + keyId.slice(1);
  const tamperedKey2 = `sk-v2-${tamperedKeyId}-${parts[3]}`;
  assert.equal(apiKeyUtils.parseApiKey(tamperedKey2), null);
});

test("Key v2 supports custom secret override", () => {
  const customSecret = "custom-signing-secret-abcdef123456";
  const { key, keyId } = apiKeyUtils.generateApiKeyV2(customSecret);

  // Valid with custom secret
  const mac = apiKeyUtils.generateMacV2(keyId, customSecret);
  assert.equal(key, `sk-v2-${keyId}-${mac}`);

  // Default parseApiKey uses env secret, so this custom one fails under env secret
  assert.equal(apiKeyUtils.parseApiKey(key), null);
});

test("Key v1 (CRC format) remains fully supported", () => {
  const machineId = "testmachine";
  const { key, keyId } = apiKeyUtils.generateApiKeyWithMachine(machineId);

  assert.match(key, new RegExp(`^sk-${machineId}-${keyId}-[a-f0-9]{8}$`));
  assert.deepEqual(apiKeyUtils.parseApiKey(key), {
    machineId,
    keyId,
    isNewFormat: true,
  });
});

test("Legacy key format (sk-{random8}) remains parsed", () => {
  assert.deepEqual(apiKeyUtils.parseApiKey("sk-legacy123"), {
    machineId: null,
    keyId: "legacy123",
    isNewFormat: false,
  });
  assert.equal(apiKeyUtils.parseApiKey("invalid-token"), null);
});
