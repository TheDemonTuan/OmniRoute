import { ApprovalDurableObject } from "./approval-object.ts";
import { handleControlDecisionRequest } from "./control.ts";
import { computeSha256Hex, verifyApiKeySignature } from "./key-verifier.ts";
import {
  classifyRequestPath,
  extractClientCredential,
  isApiHostname,
  maskApiKey,
  shouldBypassApprovalForPreflight,
} from "./routes.ts";
import { sendTelegramPendingAlert } from "./telegram.ts";
import type { ApprovalRow, Env, EvaluationResult, RequestMetadata } from "./types.ts";

export { ApprovalDurableObject };

function jsonResponse(
  status: number,
  type: string,
  code: string,
  message: string,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(
    JSON.stringify({
      error: {
        type,
        code,
        message,
      },
    }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "X-Edge-Gateway": "OmniRoute-Approval-v1",
        ...extraHeaders,
      },
    }
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const routeType = classifyRequestPath(url.pathname);

    // 1. Control-plane endpoint (Ops Bot -> Edge)
    if (routeType === "EDGE_CONTROL") {
      return handleControlDecisionRequest(request, env);
    }

    // 2. Split-Domain Hardening: Block Management UI / Admin routes when accessed via API Host
    if (routeType === "DASHBOARD" && isApiHostname(url.hostname, env.API_HOST)) {
      return jsonResponse(
        404,
        "invalid_request_error",
        "not_found",
        "Not Found: Management and dashboard routes are disabled on the API gateway hostname."
      );
    }

    // 3. Telegram Webhook, Public routes, Assets, or Dashboard pages (on Management host) -> pass through to origin
    if (routeType === "TELEGRAM_WEBHOOK" || routeType === "PUBLIC" || routeType === "DASHBOARD") {
      return fetch(request);
    }

    // Browser CORS preflight carries no API credential by design. The origin
    // remains authoritative for allowed origins/headers; only actual model
    // requests enter the API-key approval gate below.
    if (shouldBypassApprovalForPreflight(routeType, request.method)) {
      return fetch(request);
    }

    // 3. Client API Gate
    const enforceApproval = env.ENFORCE_APPROVAL !== "false";
    if (!enforceApproval) {
      return fetch(request);
    }

    try {
      const extracted = extractClientCredential(request);
      if (!extracted) {
        return jsonResponse(
          401,
          "invalid_request_error",
          "unauthorized",
          "A valid OmniRoute API key (Bearer sk-...) is required for client API endpoints."
        );
      }

      // Cryptographic signature check
      const allowLegacyV1 = env.ALLOW_LEGACY_V1 !== "false";
      const keyProof = await verifyApiKeySignature(
        extracted.apiKey,
        env.EDGE_API_KEY_SIGNING_SECRET,
        allowLegacyV1
      );

      // Invalid signature / random token -> Block silent at edge (0 Telegram, 0 Origin)
      if (!keyProof || !keyProof.valid) {
        return jsonResponse(
          401,
          "invalid_request_error",
          "invalid_api_key",
          "Invalid or unverified API key signature."
        );
      }

      // Key signature valid -> 32-character client hash fits within Telegram 64-byte callback limit
      const fullHash = await computeSha256Hex(extracted.apiKey);
      const clientId = fullHash.slice(0, 32);

      const doId = env.APPROVAL_DO.idFromName(clientId);
      const stub = env.APPROVAL_DO.get(doId);

      const cf = (request as unknown as { cf?: { country?: string } }).cf;
      const meta: RequestMetadata = {
        clientId,
        keyId: keyProof.keyId,
        keyPrefix: maskApiKey(extracted.apiKey),
        ip: request.headers.get("cf-connecting-ip") || request.headers.get("x-real-ip"),
        country: cf?.country || null,
        userAgent: request.headers.get("user-agent"),
        path: `${request.method} ${url.pathname}`,
      };

      const doRes = await stub.fetch("http://do/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(meta),
      });

      if (!doRes.ok) {
        throw new Error(`Durable Object returned HTTP ${doRes.status}`);
      }

      const evalResult = (await doRes.json()) as EvaluationResult;

      // At-most-once notification dispatch in background
      if (evalResult.shouldNotify && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
        ctx.waitUntil(
          sendTelegramPendingAlert(
            evalResult.record,
            env.TELEGRAM_BOT_TOKEN,
            env.TELEGRAM_CHAT_ID
          ).then((alertRes) => {
            if (alertRes.success && alertRes.messageId) {
              void stub.fetch("http://do/decision", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  clientId,
                  action: "allow",
                  durationSeconds: 0,
                  telegramMessageId: alertRes.messageId,
                }),
              });
            }
          })
        );
      }

      // Case A: Already APPROVED -> Forward immediately to origin
      if (evalResult.status === "APPROVED") {
        return fetch(request);
      }

      // Case B: Explicitly DENIED -> Reject immediately with 403
      if (evalResult.status === "DENIED") {
        return jsonResponse(
          403,
          "access_denied",
          "access_denied",
          "❌ OmniRoute Access Denied: This API key was denied access by the owner.",
          { "X-OmniRoute-Approval": "denied" }
        );
      }

      // Case C: PENDING -> Brief hold window (default 10s), then return retryable 429
      const waitSeconds = parseInt(env.APPROVAL_WAIT_SECONDS || "10", 10);
      if (waitSeconds > 0) {
        const deadline = Date.now() + waitSeconds * 1000;
        while (Date.now() < deadline) {
          if (request.signal?.aborted) {
            break;
          }

          await new Promise((resolve) => setTimeout(resolve, 800));

          try {
            const statusRes = await stub.fetch(`http://do/status?clientId=${clientId}`);
            if (statusRes.ok) {
              const data = (await statusRes.json()) as { record: ApprovalRow | null };
              const currentStatus = data.record?.status;

              if (currentStatus === "APPROVED") {
                // Operator approved on Telegram! Stream request immediately to origin!
                return fetch(request);
              }

              if (currentStatus === "DENIED") {
                return jsonResponse(
                  403,
                  "access_denied",
                  "access_denied",
                  "❌ OmniRoute Access Denied: This API key was denied access by the owner.",
                  { "X-OmniRoute-Approval": "denied" }
                );
              }
            }
          } catch {
            /* retry polling until timeout */
          }
        }
      }

      // Return 429 with Retry-After and a clear message for CLI agents
      return jsonResponse(
        429,
        "access_pending",
        "approval_required",
        "⏳ OmniRoute Access Pending: Your API key is awaiting owner approval on Telegram. Tap [Allow 24h] on Telegram, then retry.",
        {
          "Retry-After": "5",
          "X-OmniRoute-Approval": "pending",
        }
      );
    } catch (err: unknown) {
      const failClosed = env.FAIL_CLOSED !== "false";
      if (failClosed) {
        return jsonResponse(
          503,
          "edge_gateway_error",
          "edge_unavailable",
          "Edge Approval Gateway encountered a temporary failure."
        );
      }
      return fetch(request);
    }
  },
};
