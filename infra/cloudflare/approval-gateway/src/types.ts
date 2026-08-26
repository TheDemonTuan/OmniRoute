export type ApprovalStatus = "UNKNOWN" | "PENDING" | "APPROVED" | "DENIED";

export interface ApprovalRow {
  client_id: string;
  key_id: string;
  key_prefix: string;
  status: ApprovalStatus;
  epoch: number;
  notified_epoch: number;
  approved_until: number;
  telegram_message_id: number | null;
  first_seen_at: number;
  last_seen_at: number;
  first_ip: string | null;
  last_ip: string | null;
  country: string | null;
  user_agent: string | null;
  last_path: string | null;
}

export interface RequestMetadata {
  clientId: string;
  keyId: string;
  keyPrefix: string;
  ip: string | null;
  country: string | null;
  userAgent: string | null;
  path: string;
}

export interface EvaluationResult {
  status: ApprovalStatus;
  epoch: number;
  shouldNotify: boolean;
  approvedUntil: number;
  record: ApprovalRow;
}

export interface DecisionInput {
  clientId: string;
  action: "allow" | "deny" | "reset";
  durationSeconds?: number;
  telegramMessageId?: number | null;
  actor?: string;
}

export interface DecisionResult {
  success: boolean;
  status: ApprovalStatus;
  approvedUntil?: number;
  error?: string;
}

export type RouteType =
  | "PUBLIC"
  | "DASHBOARD"
  | "TELEGRAM_WEBHOOK"
  | "EDGE_CONTROL"
  | "CLIENT_API";

export interface ExtractedCredential {
  apiKey: string;
  transport: "bearer" | "x-api-key" | "x-goog-api-key" | "path-token";
}

export interface Env {
  APPROVAL_DO: DurableObjectNamespace;
  EDGE_API_KEY_SIGNING_SECRET: string;
  EDGE_CONTROL_SECRET: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  ENFORCE_APPROVAL?: string;
  ALLOW_LEGACY_V1?: string;
  FAIL_CLOSED?: string;
  DEFAULT_APPROVAL_DURATION_SECONDS?: string;
}
