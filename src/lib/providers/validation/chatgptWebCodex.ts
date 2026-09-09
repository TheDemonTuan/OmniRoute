import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";

import {
  CHATGPT_WEB_CODEX_CONNECTOR_NAME,
  CHATGPT_WEB_CODEX_RUNTIME_HEADED,
} from "@/shared/constants/chatgptWebCodex";
import { inspectBrowserLoginCapabilities } from "@omniroute/open-sse/vendor/codex-chatgpt-web/browser-login.ts";
import { decodeChatGptWebCodexSecrets } from "@omniroute/open-sse/executors/chatgpt-web-codex/credentials.ts";
import {
  connectionRuntimePaths,
  ensureConnectionStorageState,
  ensureConnectionStorageStateFromCredential,
} from "@omniroute/open-sse/executors/chatgpt-web-codex/storageState.ts";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";
import { acquireChatGptWebRuntimeAdmission } from "@omniroute/open-sse/utils/chatgptWebRuntimeGuard.ts";

// detectChromeExecutable (executors/chatgpt-web-codex.ts) is imported
// dynamically below, not statically here: this module is re-exported through
// the shared `@/lib/providers/validation` barrel that every provider
// validator's callers pull in, and executors/chatgpt-web-codex.ts's own
// import chain (its vendor browser adapter -> token-estimate.ts -> tiktoken's
// WASM tokenizer) fails to bundle under Turbopack dev mode even with
// `tiktoken` server-externalized -- turning validation of an unrelated
// provider into a route-wide crash for anyone who merely imports the barrel.
// A static import here evaluates that whole chain unconditionally.

export async function validateChatGptWebCodexProvider({
  apiKey,
  providerSpecificData = {},
}: {
  apiKey?: string;
  providerSpecificData?: Record<string, unknown>;
}) {
  try {
    const secrets = decodeChatGptWebCodexSecrets(String(apiKey || ""));
    if (!secrets.cookie && !secrets.storageState) {
      return {
        valid: false,
        error:
          "Für die Browserprüfung ist ein frischer ChatGPT-Cookie oder ein gespeicherter Browserzustand erforderlich.",
      };
    }
    const runtimeKey =
      typeof providerSpecificData.runtimeKey === "string"
        ? providerSpecificData.runtimeKey.trim()
        : secrets.runtimeKey || process.env.CHATGPT_WEB_CODEX_RUNTIME_KEY?.trim();
    const tunnelId =
      typeof providerSpecificData.tunnelId === "string"
        ? providerSpecificData.tunnelId.trim()
        : process.env.CHATGPT_WEB_CODEX_TUNNEL_ID?.trim() || "";
    const connectorName =
      typeof providerSpecificData.connectorName === "string"
        ? providerSpecificData.connectorName.trim()
        : process.env.CHATGPT_WEB_CODEX_CONNECTOR_NAME?.trim() || CHATGPT_WEB_CODEX_CONNECTOR_NAME;
    if (!connectorName) {
      return {
        valid: false,
        error: "Der ChatGPT-Custom-Connector ist erforderlich.",
      };
    }
    const tunnelConfigured = Boolean(runtimeKey || tunnelId);
    if (tunnelConfigured && (!runtimeKey || !/^tunnel_[a-f0-9]{32}$/.test(tunnelId))) {
      return {
        valid: false,
        error: "Tunnel-ID und Runtime-Key müssen gemeinsam gültig konfiguriert werden.",
      };
    }
    const validationId = `validation-${randomBytes(12).toString("hex")}`;
    const paths = connectionRuntimePaths(validationId);
    const freshCookie = Boolean(secrets.cookie);
    try {
      if (secrets.cookie) ensureConnectionStorageState(validationId, secrets.cookie);
      else ensureConnectionStorageStateFromCredential(validationId, secrets);
    } catch (storageError) {
      rmSync(paths.root, { recursive: true, force: true });
      return {
        valid: false,
        error: sanitizeErrorMessage(
          storageError instanceof Error ? storageError.message : storageError
        ),
      };
    }

    const { resolveChatGptWebCodexBrowserRuntime } =
      await import("@omniroute/open-sse/services/chatgptWebCodexAdmin.ts");
    const runtime = resolveChatGptWebCodexBrowserRuntime(providerSpecificData);
    const verifyBrowserLogin = providerSpecificData.verifyBrowserLogin === true;

    // Saving a connection must not wait for a remote ChatGPT page or its volatile UI.
    // An explicit connection test or request performs browser authentication.
    if (verifyBrowserLogin && runtime.available) {
      const connectionId =
        (typeof providerSpecificData.connectionId === "string" &&
          providerSpecificData.connectionId.trim()) ||
        validationId;
      const admission = acquireChatGptWebRuntimeAdmission(connectionId, "verification");
      let capabilities: Awaited<ReturnType<typeof inspectBrowserLoginCapabilities>>;
      try {
        capabilities = await inspectBrowserLoginCapabilities({
          appName: connectorName,
          ...(runtime.chromeExecutablePath
            ? { chromeExecutablePath: runtime.chromeExecutablePath }
            : {}),
          ...(runtime.cdpEndpoint ? { cdpEndpoint: runtime.cdpEndpoint } : {}),
          storageStatePath: paths.storageStatePath,
          headed: CHATGPT_WEB_CODEX_RUNTIME_HEADED,
          proAvailable: false,
          autoApproveToolCalls: false,
          verificationTimeoutMs: 25_000,
        });
      } finally {
        admission.release();
      }
      if (!freshCookie) rmSync(paths.root, { recursive: true, force: true });
      const capabilitiesVerified =
        typeof capabilities.solAvailable === "boolean" &&
        typeof capabilities.proAvailable === "boolean";
      return {
        valid: true,
        error: null,
        pendingBrowserVerification: !capabilitiesVerified,
        method: runtime.cdpEndpoint ? "cdp-browser" : "headed-browser",
        capabilities: {
          browser: "ready",
          storageState: "verified",
          login: "authenticated",
          temporaryChats: "ready",
          solAvailable: capabilities.solAvailable ?? null,
          proAvailable: capabilities.proAvailable ?? null,
        },
        providerSpecificData: {
          solAvailable: capabilities.solAvailable ?? null,
          proAvailable: capabilities.proAvailable ?? null,
          browserVerified: capabilitiesVerified,
          pendingBrowserVerification: !capabilitiesVerified,
          connectorName,
          ...(runtime.chromeExecutablePath
            ? { chromeExecutablePath: runtime.chromeExecutablePath }
            : {}),
          ...(runtime.cdpEndpoint ? { browserCdpEndpoint: runtime.cdpEndpoint } : {}),
          ...(runtimeKey ? { runtimeKey } : {}),
          ...(tunnelId ? { tunnelId } : {}),
          ...(freshCookie ? { validationId } : {}),
        },
        runtime: { available: true, mode: runtime.mode },
      };
    }

    if (!freshCookie) rmSync(paths.root, { recursive: true, force: true });
    return {
      valid: true,
      error: null,
      pendingBrowserVerification: true,
      method: "structural-validation",
      capabilities: {
        browser: runtime.available ? "pending" : "unavailable",
        storageState: "pending",
        login: "pending",
        temporaryChats: "pending",
        solAvailable: null,
        proAvailable: null,
      },
      providerSpecificData: {
        solAvailable: null,
        proAvailable: null,
        browserVerified: false,
        pendingBrowserVerification: true,
        connectorName,
        ...(runtime.chromeExecutablePath
          ? { chromeExecutablePath: runtime.chromeExecutablePath }
          : {}),
        ...(runtime.cdpEndpoint ? { browserCdpEndpoint: runtime.cdpEndpoint } : {}),
        ...(runtimeKey ? { runtimeKey } : {}),
        ...(tunnelId ? { tunnelId } : {}),
        ...(freshCookie ? { validationId } : {}),
      },
      runtime: runtime.available
        ? { available: true, mode: runtime.mode }
        : { available: false, reason: "browser_unavailable" },
    };
  } catch (error) {
    return {
      valid: false,
      error: sanitizeErrorMessage(error instanceof Error ? error.message : error),
    };
  }
}
