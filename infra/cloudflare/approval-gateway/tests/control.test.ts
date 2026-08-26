import test from "node:test";
import assert from "node:assert/strict";

import { verifyControlSignature } from "../src/control.ts";

const CONTROL_SECRET = "test-edge-control-secret-abcdef123456";

test("control: verifyControlSignature accepts valid HMAC within timestamp window", async () => {
  const rawBody = JSON.stringify({ clientId: "test1234", action: "allow", durationSeconds: 86400 });
  const timestampStr = String(Math.floor(Date.now() / 1000));
  const nonce = "0123456789abcdef0123456789abcdef";

  const stringToSign = `${timestampStr}.${nonce}.${rawBody}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(CONTROL_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(stringToSign));
  const signatureHex = Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");

  const result = await verifyControlSignature(
    rawBody,
    timestampStr,
    nonce,
    signatureHex,
    CONTROL_SECRET
  );

  assert.equal(result.valid, true);
});

test("control: verifyControlSignature rejects expired timestamp", async () => {
  const rawBody = JSON.stringify({ clientId: "test1234", action: "allow" });
  const expiredTimestampStr = String(Math.floor(Date.now() / 1000) - 400); // 400s ago (>300s)
  const nonce = "0123456789abcdef0123456789abcdef";

  const stringToSign = `${expiredTimestampStr}.${nonce}.${rawBody}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(CONTROL_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(stringToSign));
  const signatureHex = Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");

  const result = await verifyControlSignature(
    rawBody,
    expiredTimestampStr,
    nonce,
    signatureHex,
    CONTROL_SECRET
  );

  assert.equal(result.valid, false);
  assert.match(result.error || "", /timestamp outside allowed window/i);
});

test("control: verifyControlSignature rejects altered body", async () => {
  const rawBody = JSON.stringify({ clientId: "test1234", action: "allow" });
  const timestampStr = String(Math.floor(Date.now() / 1000));
  const nonce = "0123456789abcdef0123456789abcdef";

  const stringToSign = `${timestampStr}.${nonce}.${rawBody}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(CONTROL_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(stringToSign));
  const signatureHex = Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");

  const tamperedBody = JSON.stringify({ clientId: "test1234", action: "deny" });
  const result = await verifyControlSignature(
    tamperedBody,
    timestampStr,
    nonce,
    signatureHex,
    CONTROL_SECRET
  );

  assert.equal(result.valid, false);
});
