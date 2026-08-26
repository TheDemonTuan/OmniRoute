import { ApprovalDurableObject } from "./approval-object";
import { handleControlDecisionRequest } from "./control";
import { computeSha256Hex, verifyApiKeySignature } from "./key-verifier";
import { classifyRequestPath, extractClientCredential, maskApiKey } from "./routes";
import { sendTelegramPendingAlert } from "./telegram";
import type { ApprovalRow, Env, EvaluationResult, RequestMetadata } from "./types";

export { ApprovalDurableObject };

function jsonError(
  status: number,
  type: string,
  code: string,
  message: string
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

    // 2. Telegram Webhook, Public routes, Assets, or Dashboard pages -> pass through to origin
    if (
      routeType === "TELEGRAM_WEBHOOK" ||
      routeType === "PUBLIC" ||
      routeType === "DASHBOARD"
    ) {
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
        return jsonError(
          403,
          "invalid_request_error",
          "unauthorized",
          "A valid OmniRoute API key is required."
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
        return jsonError(
          403,
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

      // Case B: Explicitly DENIED -> Reject immediately
      if (evalResult.status === "DENIED") {
        return jsonError(
          403,
          "access_denied",
          "access_denied",
          "This API key is not authorized for access."
        );
      }

      // Case C: PENDING -> Hold and wait for operator approval on Telegram!
      const waitSeconds = parseInt(env.APPROVAL_WAIT_SECONDS || "45", 10);
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
                return jsonError(
                  403,
                  "access_denied",
                  "access_denied",
                  "This API key is not authorized for access."
                );
              }
            }
          } catch {
            /* retry polling until timeout */
          }
        }
      }

      // Default when timeout expires without approval
      return jsonError(
        403,
        "access_pending",
        "approval_required",
        "This API key is awaiting operator approval. Tap Allow on Telegram to grant access."
      );
    } catch (err: unknown) {
      const failClosed = env.FAIL_CLOSED !== "false";
      if (failClosed) {
        return jsonError(
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
