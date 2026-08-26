import { DurableObject } from "cloudflare:workers";
import type {
  ApprovalRow,
  DecisionInput,
  DecisionResult,
  EvaluationResult,
  RequestMetadata,
  Env,
} from "./types.ts";

export class ApprovalDurableObject extends DurableObject {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.initSchema();
  }

  private initSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS approval_record (
        client_id TEXT PRIMARY KEY,
        key_id TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('PENDING', 'APPROVED', 'DENIED')),
        epoch INTEGER NOT NULL DEFAULT 1,
        notified_epoch INTEGER NOT NULL DEFAULT 0,
        approved_until INTEGER NOT NULL DEFAULT 0,
        telegram_message_id INTEGER,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        first_ip TEXT,
        last_ip TEXT,
        country TEXT,
        user_agent TEXT,
        last_path TEXT
      );
    `);
  }

  private getRecord(clientId: string): ApprovalRow | null {
    const cursor = this.sql.exec<ApprovalRow>(
      "SELECT * FROM approval_record WHERE client_id = ?",
      clientId
    );
    const rows = [...cursor];
    return rows.length > 0 ? rows[0] : null;
  }

  async evaluate(meta: RequestMetadata): Promise<EvaluationResult> {
    const now = Date.now();
    const existing = this.getRecord(meta.clientId);

    // Case 1: First time seen -> Record as PENDING and trigger notification
    if (!existing) {
      this.sql.exec(
        `INSERT INTO approval_record (
          client_id, key_id, key_prefix, status, epoch, notified_epoch,
          approved_until, first_seen_at, last_seen_at, first_ip, last_ip,
          country, user_agent, last_path
        ) VALUES (?, ?, ?, 'PENDING', 1, 1, 0, ?, ?, ?, ?, ?, ?, ?)`,
        meta.clientId,
        meta.keyId,
        meta.keyPrefix,
        now,
        now,
        meta.ip,
        meta.ip,
        meta.country,
        meta.userAgent,
        meta.path
      );

      const record = this.getRecord(meta.clientId)!;
      return {
        status: "PENDING",
        epoch: 1,
        shouldNotify: true,
        approvedUntil: 0,
        record,
      };
    }

    // Case 2: Currently APPROVED
    if (existing.status === "APPROVED") {
      if (now <= existing.approved_until) {
        this.sql.exec(
          "UPDATE approval_record SET last_seen_at = ?, last_ip = ?, last_path = ? WHERE client_id = ?",
          now,
          meta.ip,
          meta.path,
          meta.clientId
        );
        return {
          status: "APPROVED",
          epoch: existing.epoch,
          shouldNotify: false,
          approvedUntil: existing.approved_until,
          record: existing,
        };
      }

      // Expired: Roll over to next epoch atomically
      const newEpoch = existing.epoch + 1;
      this.sql.exec(
        `UPDATE approval_record SET
          status = 'PENDING',
          epoch = ?,
          notified_epoch = ?,
          approved_until = 0,
          last_seen_at = ?,
          last_ip = ?,
          last_path = ?
        WHERE client_id = ?`,
        newEpoch,
        newEpoch,
        now,
        meta.ip,
        meta.path,
        meta.clientId
      );

      const record = this.getRecord(meta.clientId)!;
      return {
        status: "PENDING",
        epoch: newEpoch,
        shouldNotify: true,
        approvedUntil: 0,
        record,
      };
    }

    // Case 3: Currently PENDING
    if (existing.status === "PENDING") {
      this.sql.exec(
        "UPDATE approval_record SET last_seen_at = ?, last_ip = ?, last_path = ? WHERE client_id = ?",
        now,
        meta.ip,
        meta.path,
        meta.clientId
      );

      // Only notify if this epoch hasn't notified yet (e.g. prior notify attempt failed)
      let shouldNotify = false;
      if (existing.notified_epoch < existing.epoch) {
        this.sql.exec(
          "UPDATE approval_record SET notified_epoch = ? WHERE client_id = ?",
          existing.epoch,
          meta.clientId
        );
        shouldNotify = true;
      }

      return {
        status: "PENDING",
        epoch: existing.epoch,
        shouldNotify,
        approvedUntil: 0,
        record: existing,
      };
    }

    // Case 4: DENIED
    this.sql.exec(
      "UPDATE approval_record SET last_seen_at = ?, last_ip = ?, last_path = ? WHERE client_id = ?",
      now,
      meta.ip,
      meta.path,
      meta.clientId
    );
    return {
      status: "DENIED",
      epoch: existing.epoch,
      shouldNotify: false,
      approvedUntil: 0,
      record: existing,
    };
  }

  async applyDecision(decision: DecisionInput): Promise<DecisionResult> {
    const now = Date.now();
    const existing = this.getRecord(decision.clientId);

    if (decision.action === "reset") {
      this.sql.exec("DELETE FROM approval_record WHERE client_id = ?", decision.clientId);
      return { success: true, status: "UNKNOWN" };
    }

    if (!existing) {
      return { success: false, status: "UNKNOWN", error: "client_not_found" };
    }

    if (decision.action === "allow") {
      const durationSec = decision.durationSeconds && decision.durationSeconds > 0
        ? decision.durationSeconds
        : 86400;
      const approvedUntil = now + durationSec * 1000;

      this.sql.exec(
        `UPDATE approval_record SET
          status = 'APPROVED',
          approved_until = ?,
          telegram_message_id = COALESCE(?, telegram_message_id)
        WHERE client_id = ?`,
        approvedUntil,
        decision.telegramMessageId ?? null,
        decision.clientId
      );

      return { success: true, status: "APPROVED", approvedUntil };
    }

    if (decision.action === "deny") {
      this.sql.exec(
        `UPDATE approval_record SET
          status = 'DENIED',
          approved_until = 0,
          telegram_message_id = COALESCE(?, telegram_message_id)
        WHERE client_id = ?`,
        decision.telegramMessageId ?? null,
        decision.clientId
      );

      return { success: true, status: "DENIED" };
    }

    return { success: false, status: existing.status, error: "unsupported_action" };
  }

  async getRecordState(clientId: string): Promise<ApprovalRow | null> {
    return this.getRecord(clientId);
  }

  /**
   * Standard HTTP fetch interface for Durable Object
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.slice(1);

    if (request.method === "POST" && action === "evaluate") {
      const meta = (await request.json()) as RequestMetadata;
      const result = await this.evaluate(meta);
      return Response.json(result);
    }

    if (request.method === "POST" && action === "decision") {
      const decision = (await request.json()) as DecisionInput;
      const result = await this.applyDecision(decision);
      return Response.json(result);
    }

    if (request.method === "GET" && action === "status") {
      const clientId = url.searchParams.get("clientId") || "";
      const record = this.getRecord(clientId);
      return Response.json({ record });
    }

    return new Response("Not found", { status: 404 });
  }
}
