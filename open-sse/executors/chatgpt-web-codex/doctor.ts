import { existsSync, readFileSync } from "node:fs";

import { browserLoginStateExists } from "../../vendor/codex-chatgpt-web/browser-login.ts";
import { sanitizeErrorMessage } from "../../utils/error.ts";
import { resolveChatGptWebCodexBrowserRuntime } from "./browserRuntime.ts";
import { decodeChatGptWebCodexSecrets } from "./credentials.ts";
import { getChatGptWebCodexRuntimeCounts } from "./runtime.ts";
import { connectionRuntimePaths } from "./storageState.ts";
import {
  getTunnelRuntimeStatus,
  tunnelClientPaths,
  tunnelSupervisorLeaseStatus,
} from "./tunnelClient.ts";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function getChatGptWebCodexDoctorStatus(connection: {
  id?: unknown;
  apiKey?: unknown;
  providerSpecificData?: unknown;
  lastError?: unknown;
}) {
  const connectionId = typeof connection.id === "string" ? connection.id : "";
  const data = record(connection.providerSpecificData);
  const paths = connectionRuntimePaths(connectionId);
  const tunnelPaths = tunnelClientPaths();
  const browserRuntime = resolveChatGptWebCodexBrowserRuntime(data);
  let storageState = false;
  let login = false;
  let solAvailable: boolean | null =
    data.solAvailable === true ? true : data.solAvailable === false ? false : null;
  let proAvailable: boolean | null =
    data.proAvailable === true ? true : data.proAvailable === false ? false : null;
  let credential = false;
  let hasStorageState = false;
  let hasCookie = false;
  let pendingBrowserVerification = data.pendingBrowserVerification === true;
  let capabilitiesVerified = false;
  try {
    const secrets = decodeChatGptWebCodexSecrets(String(connection.apiKey || ""));
    hasStorageState = Boolean(secrets.storageState);
    hasCookie = Boolean(secrets.cookie);
    credential = hasStorageState || hasCookie;
    storageState = existsSync(paths.storageStatePath);
    login = browserLoginStateExists({ storageStatePath: paths.storageStatePath });
    const markerPath = `${paths.storageStatePath}.verified.json`;
    if (existsSync(markerPath)) {
      try {
        const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
        pendingBrowserVerification = marker.pendingBrowserVerification === true;
        capabilitiesVerified = marker.capabilitiesVerified === true;
        if (capabilitiesVerified) {
          if (typeof marker.solAvailable === "boolean") solAvailable = marker.solAvailable;
          if (typeof marker.proAvailable === "boolean") proAvailable = marker.proAvailable;
        } else {
          solAvailable = null;
          proAvailable = null;
        }
      } catch {
        // Marker detail is optional.
      }
    }
  } catch {
    credential = false;
  }

  let tunnel = {
    ok: false,
    processRunning: false,
    healthy: false,
    ready: false,
    detail: "not checked",
  };
  try {
    if (existsSync(tunnelPaths.binary)) tunnel = await getTunnelRuntimeStatus({});
  } catch (error) {
    tunnel.detail = sanitizeErrorMessage(error instanceof Error ? error.message : error);
  }

  const runtime = getChatGptWebCodexRuntimeCounts();
  const lease = tunnelSupervisorLeaseStatus();
  return {
    browser: {
      ready: browserRuntime.available,
      mode: browserRuntime.mode,
    },
    credential: {
      ready: credential,
      kind: hasStorageState ? "storage_state" : hasCookie ? "cookie" : "none",
    },
    verification: {
      pending: pendingBrowserVerification,
      verified: login && !pendingBrowserVerification && capabilitiesVerified,
    },
    storageState: { ready: storageState && credential },
    login: { ready: login && !pendingBrowserVerification && capabilitiesVerified },
    temporaryChats: { ready: login && !pendingBrowserVerification && capabilitiesVerified },
    tunnelBinary: { ready: existsSync(tunnelPaths.binary) },
    tunnel: {
      ready: tunnel.ok,
      processRunning: tunnel.processRunning,
      healthy: tunnel.healthy,
      detail: tunnel.detail,
    },
    connector: {
      ready: typeof data.connectorName === "string" && data.connectorName.trim().length > 0,
    },
    toolRoundtrip: { ready: tunnel.ok && runtime.brokers > 0 },
    runtime,
    lease,
    solAvailable,
    proAvailable,
    recovery: {
      interactiveLoginRequired: storageState && !login,
    },
    lastError:
      typeof connection.lastError === "string" && connection.lastError.trim()
        ? sanitizeErrorMessage(connection.lastError)
        : null,
  };
}
