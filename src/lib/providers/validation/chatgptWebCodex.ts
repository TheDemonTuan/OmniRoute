import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";

import {
  CHATGPT_WEB_CODEX_CONNECTOR_NAME,
  CHATGPT_WEB_CODEX_RUNTIME_HEADED,
} from "@/shared/constants/chatgptWebCodex";
import {
  decodeChatGptWebCodexSecrets,
  chatGptWebCodexCredentialFingerprint,
} from "@omniroute/open-sse/executors/chatgpt-web-codex/credentials.ts";
import {
  connectionRuntimePaths,
  ensureConnectionStorageState,
  ensureConnectionStorageStateFromCredential,
} from "@omniroute/open-sse/executors/chatgpt-web-codex/storageState.ts";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";

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
  connectionId,
  signal,
  model,
  forceVerification,
}: {
  apiKey?: string;
  providerSpecificData?: Record<string, unknown>;
  connectionId?: string;
  signal?: AbortSignal;
  model?: string;
  forceVerification?: boolean;
}) {
  let usesTemporaryValidationState = false;
  let paths: ReturnType<typeof connectionRuntimePaths> | undefined;
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

    const {
      resolveChatGptWebCodexBrowserRuntime,
      verificationCoordinator,
      requireChatGptWebCodexRoute,
      assertChatGptWebCodexRouteAvailable,
    } = await import("@omniroute/open-sse/services/chatgptWebCodexAdmin.ts");

    if (model) {
      try {
        requireChatGptWebCodexRoute(model);
      } catch (modelError) {
        return {
          valid: false,
          error: sanitizeErrorMessage(
            modelError instanceof Error ? modelError.message : modelError
          ),
          statusCode: 400,
          errorCode: "unsupported_model",
        };
      }
    }

    const validationId = `validation-${randomBytes(12).toString("hex")}`;
    const runtimeConnectionId = connectionId?.trim() || validationId;
    usesTemporaryValidationState = runtimeConnectionId === validationId;
    paths = connectionRuntimePaths(runtimeConnectionId);
    const freshCookie = Boolean(secrets.cookie);
    try {
      if (secrets.cookie) ensureConnectionStorageState(runtimeConnectionId, secrets.cookie);
      else ensureConnectionStorageStateFromCredential(runtimeConnectionId, secrets);
    } catch (storageError) {
      if (usesTemporaryValidationState) rmSync(paths.root, { recursive: true, force: true });
      return {
        valid: false,
        error: sanitizeErrorMessage(
          storageError instanceof Error ? storageError.message : storageError
        ),
      };
    }

    const runtime = resolveChatGptWebCodexBrowserRuntime(providerSpecificData);
    const verifyBrowserLogin = providerSpecificData.verifyBrowserLogin === true;

    // Saving a connection must not wait for a remote ChatGPT page or its volatile UI.
    // An explicit connection test or request performs browser authentication.
    if (verifyBrowserLogin && runtime.available) {
      const verification = await verificationCoordinator.coordinateVerification({
        connectionId: runtimeConnectionId,
        credentialFingerprint: chatGptWebCodexCredentialFingerprint(String(apiKey || "")),
        runtimeIdentity: runtime.cdpEndpoint ?? runtime.chromeExecutablePath ?? "unavailable",
        loginConfig: {
          appName: connectorName,
          ...(runtime.chromeExecutablePath
            ? { chromeExecutablePath: runtime.chromeExecutablePath }
            : {}),
          ...(runtime.cdpEndpoint ? { cdpEndpoint: runtime.cdpEndpoint } : {}),
          storageStatePath: paths.storageStatePath,
          headed: CHATGPT_WEB_CODEX_RUNTIME_HEADED,
          proAvailable: false,
          autoApproveToolCalls: false,
          // Connection tests must cover cold navigation plus capability discovery.
          verificationTimeoutMs: 60_000,
          signal,
        },
        signal,
        force: forceVerification === true,
      });

      if (usesTemporaryValidationState && !freshCookie) {
        rmSync(paths.root, { recursive: true, force: true });
      }
      const capabilities = verification.capabilities;
      const capabilitiesVerified = verification.capabilitiesVerified;

      if (model && capabilitiesVerified) {
        try {
          assertChatGptWebCodexRouteAvailable(model, {
            solAvailable: capabilities.solAvailable,
            proAvailable: capabilities.proAvailable,
          });
        } catch (routeErr) {
          return {
            valid: false,
            error: sanitizeErrorMessage(routeErr instanceof Error ? routeErr.message : routeErr),
            statusCode: 400,
            errorCode: "unsupported_model_route",
            pendingBrowserVerification: !capabilitiesVerified,
          };
        }
      }

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

    if (usesTemporaryValidationState && !freshCookie) {
      rmSync(paths.root, { recursive: true, force: true });
    }

    if (
      model &&
      (providerSpecificData.browserVerified === true ||
        typeof providerSpecificData.solAvailable === "boolean")
    ) {
      try {
        assertChatGptWebCodexRouteAvailable(model, providerSpecificData);
      } catch (routeErr) {
        return {
          valid: false,
          error: sanitizeErrorMessage(routeErr instanceof Error ? routeErr.message : routeErr),
          statusCode: 400,
          errorCode: "unsupported_model_route",
        };
      }
    }

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
    if (usesTemporaryValidationState && paths) {
      try {
        rmSync(paths.root, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    const { classifyVerificationError, ChatGptWebVerificationError } =
      await import("@omniroute/open-sse/services/chatgptWebCodexAdmin.ts");
    if (!(error instanceof ChatGptWebVerificationError)) {
      const msg = sanitizeErrorMessage(error instanceof Error ? error.message : error);
      const isRouteError =
        msg.includes("route") ||
        msg.includes("model") ||
        msg.includes("Luna") ||
        msg.includes("Sol") ||
        msg.includes("Pro");
      return {
        valid: false,
        error: msg,
        statusCode: 400,
        errorCode: isRouteError ? "unsupported_model_route" : "chatgpt_web_codex_validation_failed",
      };
    }
    const typed = classifyVerificationError(error);
    return {
      valid: false,
      error: sanitizeErrorMessage(typed.message),
      statusCode: typed.statusCode,
      errorCode: typed.code,
    };
  }
}
