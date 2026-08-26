import type { ApprovalRow } from "./types";

function escapeHtml(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatDateIso(timestampMs: number): string {
  try {
    return new Date(timestampMs).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  } catch {
    return String(timestampMs);
  }
}

/**
 * Build HTML notification body and inline keyboard for Telegram
 */
export function buildTelegramAlertPayload(
  record: ApprovalRow,
  chatId: string
): {
  chat_id: string;
  text: string;
  parse_mode: string;
  disable_web_page_preview: boolean;
  reply_markup: {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
  };
} {
  const shortClientId = record.client_id.slice(0, 16) + "...";
  const flag = record.country ? `${record.country} ` : "";

  const text = [
    "🔐 <b>New OmniRoute API Access Request</b>",
    "",
    `<b>Client:</b> <code>${escapeHtml(record.key_prefix)}</code>`,
    `<b>Key ID:</b> <code>${escapeHtml(record.key_id)}</code>`,
    `<b>Client Hash:</b> <code>${escapeHtml(shortClientId)}</code>`,
    "",
    `<b>IP:</b> <code>${escapeHtml(record.first_ip || "unknown")}</code>`,
    `<b>Country:</b> ${escapeHtml(flag || "Unknown")}`,
    `<b>Endpoint:</b> <code>${escapeHtml(record.last_path || "/v1/chat/completions")}</code>`,
    `<b>User-Agent:</b> <code>${escapeHtml(record.user_agent || "unknown")}</code>`,
    `<b>First Seen:</b> <code>${escapeHtml(formatDateIso(record.first_seen_at))}</code>`,
    "",
    "<b>Status:</b> ⏳ <b>PENDING APPROVAL</b>",
  ].join("\n");

  // Keep callback_data well under Telegram's 64-byte limit:
  // e.g. "access:allow:73698dc75cbda123:1" (~34 bytes)
  const idPrefix = record.client_id.slice(0, 16);
  const allowData = `access:allow:${idPrefix}:${record.epoch}`;
  const denyData = `access:deny:${idPrefix}:${record.epoch}`;
  const infoData = `access:info:${idPrefix}`;
  const resetData = `access:reset:${idPrefix}`;

  return {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Allow 24h", callback_data: allowData },
          { text: "❌ Deny", callback_data: denyData },
        ],
        [
          { text: "🔍 Metadata", callback_data: infoData },
          { text: "♻️ Reset", callback_data: resetData },
        ],
      ],
    },
  };
}

/**
 * Send Telegram notification directly to api.telegram.org
 */
export async function sendTelegramPendingAlert(
  record: ApprovalRow,
  botToken: string,
  chatId: string
): Promise<{ success: boolean; messageId?: number; error?: string }> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const payload = buildTelegramAlertPayload(record, chatId);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text();
      return { success: false, error: `Telegram HTTP ${response.status}: ${errText}` };
    }

    const data = (await response.json()) as { ok: boolean; result?: { message_id: number } };
    if (data.ok && data.result?.message_id) {
      return { success: true, messageId: data.result.message_id };
    }

    return { success: false, error: "Telegram API response missing message_id" };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}
