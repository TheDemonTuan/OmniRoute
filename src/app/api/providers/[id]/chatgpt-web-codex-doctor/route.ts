import { existsSync, rmSync } from "node:fs";
import { NextResponse } from "next/server";
import { z } from "zod";

import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getProviderConnectionById, updateProviderConnection } from "@/lib/db/providers";
import { validateChatGptWebCodexProvider } from "@/lib/providers/validation/chatgptWebCodex";
import {
  connectionRuntimePaths,
  getChatGptWebCodexDoctorStatus,
} from "@omniroute/open-sse/services/chatgptWebCodexAdmin.ts";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";

const DoctorActionSchema = z.object({
  action: z.enum(["retry_verification", "reset_runtime", "reset_credentials"]),
  confirm: z.literal(true).optional(),
});

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const { id } = await params;
  const connection = await getProviderConnectionById(id);
  if (!connection || connection.provider !== "chatgpt-web-codex") {
    return NextResponse.json(
      { error: "ChatGPT Web (Codex) connection not found" },
      { status: 404 }
    );
  }
  return NextResponse.json({ status: await getChatGptWebCodexDoctorStatus(connection) });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const { id } = await params;
  const connection = await getProviderConnectionById(id);
  if (!connection || connection.provider !== "chatgpt-web-codex") {
    return NextResponse.json(
      { error: "ChatGPT Web (Codex) connection not found" },
      { status: 404 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = DoctorActionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid action", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const providerSpecificData =
    connection.providerSpecificData && typeof connection.providerSpecificData === "object"
      ? (connection.providerSpecificData as Record<string, unknown>)
      : {};

  try {
    switch (parsed.data.action) {
      case "retry_verification": {
        const validation = await validateChatGptWebCodexProvider({
          apiKey: connection.apiKey,
          connectionId: id,
          providerSpecificData: { ...providerSpecificData, verifyBrowserLogin: true },
        });
        if (validation.valid && validation.pendingBrowserVerification !== true) {
          const updateData: Record<string, unknown> = {
            testStatus: "active",
            providerSpecificData: {
              ...providerSpecificData,
              ...(validation.providerSpecificData ?? {}),
              browserVerified: true,
              pendingBrowserVerification: false,
            },
          };
          await updateProviderConnection(id, updateData);
          const updated = await getProviderConnectionById(id);
          return NextResponse.json({
            success: true,
            status: await getChatGptWebCodexDoctorStatus(updated ?? connection),
          });
        }
        return NextResponse.json(
          {
            success: false,
            error:
              validation.error ??
              (validation.pendingBrowserVerification === true
                ? "Browser verification is still pending because the browser runtime is unavailable."
                : "Verification failed"),
            status: await getChatGptWebCodexDoctorStatus(connection),
          },
          { status: validation.pendingBrowserVerification === true ? 503 : 400 }
        );
      }
      case "reset_runtime": {
        return NextResponse.json(
          {
            success: false,
            error:
              "Reset Runtime is unavailable because browser workers are process-wide. Restart OmniRoute to reset this connection without interrupting other connections.",
          },
          { status: 409 }
        );
      }
      case "reset_credentials": {
        if (parsed.data.confirm !== true) {
          return NextResponse.json(
            { error: "Reset Credentials requires confirm: true" },
            { status: 400 }
          );
        }
        const paths = connectionRuntimePaths(id);
        if (existsSync(paths.storageStatePath)) {
          rmSync(paths.storageStatePath, { force: true });
        }
        const markerPath = `${paths.storageStatePath}.verified.json`;
        if (existsSync(markerPath)) {
          rmSync(markerPath, { force: true });
        }
        await updateProviderConnection(id, {
          apiKey: null,
          testStatus: "pending",
          providerSpecificData: {
            ...providerSpecificData,
            browserVerified: false,
            pendingBrowserVerification: true,
          },
        });
        const updated = await getProviderConnectionById(id);
        return NextResponse.json({
          success: true,
          message: "Credentials reset successfully",
          status: await getChatGptWebCodexDoctorStatus(updated ?? connection),
        });
      }
    }
  } catch (error) {
    return NextResponse.json(
      { error: sanitizeErrorMessage(error instanceof Error ? error.message : error) },
      { status: 500 }
    );
  }
}
