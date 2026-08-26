import type { DecisionInput, DecisionResult, Env } from "./types";

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const val = parseInt(hex.substring(i, i + 2), 16);
    if (Number.isNaN(val)) return null;
    bytes[i / 2] = val;
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Verify HMAC-SHA256 signature on incoming control-plane requests
 */
export async function verifyControlSignature(
  rawBody: string,
  timestampStr: string | null,
  nonce: string | null,
  signatureHex: string | null,
  secret: string
): Promise<{ valid: boolean; error?: string }> {
  if (!timestampStr || !nonce || !signatureHex) {
    return { valid: false, error: "Missing required control headers (timestamp, nonce, signature)" };
  }

  const timestamp = parseInt(timestampStr, 10);
  if (Number.isNaN(timestamp)) {
    return { valid: false, error: "Invalid timestamp header" };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  // Max 5 minutes replay window
  if (Math.abs(nowSeconds - timestamp) > 300) {
    return { valid: false, error: "Control request timestamp outside allowed window (±300s)" };
  }

  if (nonce.length < 16) {
    return { valid: false, error: "Control request nonce too short" };
  }

  try {
    const stringToSign = `${timestampStr}.${nonce}.${rawBody}`;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const expectedSigBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(stringToSign));
    const expectedSigHex = bytesToHex(new Uint8Array(expectedSigBuffer));

    if (!constantTimeEqual(signatureHex.toLowerCase(), expectedSigHex.toLowerCase())) {
      return { valid: false, error: "Invalid HMAC signature" };
    }

    return { valid: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { valid: false, error: `Signature verification error: ${msg}` };
  }
}

/**
 * Handle POST /__edge-control/decision requests from Ops Bot
 */
export async function handleControlDecisionRequest(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const timestampStr = request.headers.get("x-edge-timestamp") || request.headers.get("X-Edge-Timestamp");
  const nonce = request.headers.get("x-edge-nonce") || request.headers.get("X-Edge-Nonce");
  const signature = request.headers.get("x-edge-signature") || request.headers.get("X-Edge-Signature");

  const rawBody = await request.text();
  const auth = await verifyControlSignature(
    rawBody,
    timestampStr,
    nonce,
    signature,
    env.EDGE_CONTROL_SECRET
  );

  if (!auth.valid) {
    return new Response(JSON.stringify({ error: auth.error || "Unauthorized control request" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let decisionInput: DecisionInput;
  try {
    decisionInput = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!decisionInput.clientId || !decisionInput.action) {
    return new Response(JSON.stringify({ error: "Missing clientId or action" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Forward decision to the specific Durable Object instance
  const doId = env.APPROVAL_DO.idFromName(decisionInput.clientId);
  const stub = env.APPROVAL_DO.get(doId);

  const doResponse = await stub.fetch("http://do/decision", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(decisionInput),
  });

  const result = (await doResponse.json()) as DecisionResult;
  return new Response(JSON.stringify(result), {
    status: result.success ? 200 : 400,
    headers: { "Content-Type": "application/json" },
  });
}
