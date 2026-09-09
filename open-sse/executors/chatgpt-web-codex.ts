import {
  CHATGPT_WEB_CODEX_CONNECTOR_NAME,
  CHATGPT_WEB_CODEX_RUNTIME_HEADED,
} from "@/shared/constants/chatgptWebCodex";

import { isVerifiedNativeCodexRequest } from "../config/codexIdentity.ts";
import { FORMATS } from "../translator/formats.ts";
import { buildErrorBody, sanitizeErrorMessage } from "../utils/error.ts";
import { ChatGptWebAdapterError } from "../vendor/codex-chatgpt-web/adapters/chatgpt-web/adapter-error.ts";
import { acquireChatGptWebRuntimeAdmission } from "../utils/chatgptWebRuntimeGuard.ts";
import { createChatGptWebAdapter } from "../vendor/codex-chatgpt-web/adapters/chatgpt-web/index.ts";
import { ChatGptBrowserWorker } from "../vendor/codex-chatgpt-web/adapters/chatgpt-web/browser-worker.ts";
import {
  browserLoginStateExists,
  inspectBrowserLoginCapabilities,
} from "../vendor/codex-chatgpt-web/browser-login.ts";
import { extractChatGptTurnIdentity } from "../vendor/codex-chatgpt-web/adapters/chatgpt-web/environment.ts";
import { bridgeToResponsesSSE, buildResponseJSON } from "../vendor/codex-chatgpt-web/bridge.ts";
import { AsyncEventQueue } from "../vendor/codex-chatgpt-web/event-queue.ts";
import { parseRequest } from "../vendor/codex-chatgpt-web/responses/parser.ts";
import {
  expandPreviousResponseInput,
  rememberResponseState,
} from "../vendor/codex-chatgpt-web/responses/state.ts";
import type {
  AdapterEvent,
  CodexParsedRequest,
  CodexProviderConfig,
} from "../vendor/codex-chatgpt-web/types.ts";
import { BaseExecutor, type ExecuteInput, type ExecutorExecuteResult } from "./base.ts";
import { reasoningEffortOf, requireChatGptWebCodexRoute } from "./chatgpt-web-codex/models.ts";
import {
  connectionRuntimePaths,
  ensureConnectionStorageStateFromCredential,
  readConnectionStorageState,
} from "./chatgpt-web-codex/storageState.ts";
import {
  decodeChatGptWebCodexSecrets,
  encodeChatGptWebCodexSecrets,
} from "./chatgpt-web-codex/credentials.ts";
import { ensureTunnelRuntimeReady } from "./chatgpt-web-codex/tunnelClient.ts";
import { trackChatGptWebCodexRuntime } from "./chatgpt-web-codex/runtime.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };
const SSE_HEADERS = {
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "Content-Type": "text/event-stream; charset=utf-8",
};

function errorResponse(status: number, message: unknown, code = "chatgpt_web_codex_error") {
  return new Response(
    JSON.stringify(
      buildErrorBody(status, sanitizeErrorMessage(message), undefined, {
        type: status >= 500 ? "provider_error" : "invalid_request_error",
        code,
      })
    ),
    { status, headers: JSON_HEADERS }
  );
}

function wrapped(response: Response, body: unknown): ExecutorExecuteResult {
  return {
    response,
    url: "https://chatgpt.com/?temporary-chat=true",
    headers: {},
    transformedBody: body,
    transport: "chatgpt-web-browser",
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nativeBody(body: unknown): Record<string, unknown> {
  const source = record(body);
  const copy = { ...source };
  delete copy._nativeCodexPassthrough;
  return copy;
}

function headersFromRecord(values?: Record<string, string> | null): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(values ?? {})) headers.set(name, value);
  return headers;
}

function configuredString(data: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

import {
  ChatGptWebCodexRuntimeError,
  detectChromeExecutable,
  resolveChatGptWebCodexBrowserRuntime,
} from "./chatgpt-web-codex/browserRuntime.ts";

export {
  ChatGptWebCodexRuntimeError,
  detectChromeExecutable,
  resolveChatGptWebCodexBrowserRuntime,
};

function responseStateNamespace(connectionId: string, parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.threadId || !identity.turnId) {
    throw new Error("Native Codex thread_id and turn_id are required");
  }
  return `${connectionId}:${identity.threadId}:${identity.turnId}`;
}

function itemType(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const type = (value as Record<string, unknown>).type;
  return typeof type === "string" ? type : "";
}

function itemRole(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const role = (value as Record<string, unknown>).role;
  return typeof role === "string" ? role : "";
}

export function inputHasSelfContainedCodexContinuation(body: Record<string, unknown>): boolean {
  const input = Array.isArray(body.input) ? body.input : [];
  let hasUser = false;
  let hasToolOutput = false;
  for (const item of input) {
    if (itemRole(item) === "user" || itemType(item) === "message") hasUser = true;
    if (itemType(item) === "function_call_output" || itemType(item) === "custom_tool_call_output") {
      hasToolOutput = true;
    }
  }
  return hasUser && hasToolOutput;
}

export function resolveChatGptWebCodexPreviousResponse(
  body: Record<string, unknown>,
  namespace: string
): { body: Record<string, unknown>; ok: boolean } {
  if (typeof body.previous_response_id !== "string" || !body.previous_response_id.trim()) {
    return { body, ok: true };
  }
  const expanded = expandPreviousResponseInput(body, namespace);
  if (expanded !== body) return { body: record(expanded), ok: true };
  if (!inputHasSelfContainedCodexContinuation(body)) return { body, ok: false };
  const next = { ...body };
  delete next.previous_response_id;
  return { body: next, ok: true };
}

function toolModeRequired(parsed: CodexParsedRequest): boolean {
  if (parsed.options.toolChoice === "none") return false;
  return (parsed.context.tools?.length ?? 0) > 0;
}

function requireVerifiedRouteCapabilities(
  route: ReturnType<typeof requireChatGptWebCodexRoute>,
  data: Record<string, unknown>
): void {
  const solAvailable = data.solAvailable;
  const proAvailable = data.proAvailable;
  if (route.sol && solAvailable !== true) {
    throw new Error(
      solAvailable === false
        ? "ChatGPT Sol models are not available for this Luna-only connection"
        : "ChatGPT Sol model availability has not been verified for this connection"
    );
  }
  if (!route.sol && solAvailable !== false) {
    throw new Error(
      solAvailable === true
        ? "ChatGPT Luna models are only available for Luna-only connections"
        : "ChatGPT Luna model availability has not been verified for this connection"
    );
  }
  if (route.pro && proAvailable !== true) {
    throw new Error(
      proAvailable === false
        ? `${route.id} is not available for this non-Pro connection`
        : `${route.id} availability has not been verified for this connection`
    );
  }
}

export function assertChatGptWebCodexRouteAvailable(
  model: string,
  data: Record<string, unknown>
): void {
  requireVerifiedRouteCapabilities(requireChatGptWebCodexRoute(model), data);
}

function buildProviderConfig(
  input: ExecuteInput,
  parsed: CodexParsedRequest,
  storageStatePath: string,
  connectionId: string
): CodexProviderConfig {
  const data = record(input.credentials.providerSpecificData);
  const route = requireChatGptWebCodexRoute(input.model);
  const paths = connectionRuntimePaths(connectionId);
  const browserRuntime = resolveChatGptWebCodexBrowserRuntime(data);
  if (!browserRuntime.available) {
    throw new ChatGptWebCodexRuntimeError(
      "chatgpt_web_codex_browser_unavailable",
      "ChatGPT Web (Codex) browser runtime is unavailable",
      503
    );
  }
  const cdpEndpoint = browserRuntime.cdpEndpoint;
  const chromeExecutablePath = browserRuntime.chromeExecutablePath;

  requireVerifiedRouteCapabilities(route, data);
  const solAvailable = data.solAvailable as boolean;
  const proAvailable = data.proAvailable as boolean;

  const hasTools = toolModeRequired(parsed);
  const connector =
    configuredString(data, "connectorName", "appName") ??
    (process.env.CHATGPT_WEB_CODEX_CONNECTOR_NAME?.trim() || CHATGPT_WEB_CODEX_CONNECTOR_NAME);

  parsed.modelId = route.backendModel;
  parsed.options.reasoning = route.effort;

  return {
    adapter: "chatgpt-web",
    baseUrl: "https://chatgpt.com",
    defaultModel: route.backendModel,
    models: [route.backendModel],
    chatgptWeb: {
      appName: connector,
      storageStatePath,
      ...(chromeExecutablePath ? { chromeExecutablePath } : {}),
      ...(cdpEndpoint ? { cdpEndpoint } : {}),
      brokerSocketPath: paths.brokerSocketPath,
      threadEnvironmentStatePath: paths.threadEnvironmentStatePath,
      lunaCheckpointStatePath: paths.lunaCheckpointStatePath,
      headed: CHATGPT_WEB_CODEX_RUNTIME_HEADED,
      localToolsEnabled: hasTools,
      solAvailable,
      proAvailable,
      experimentalBiggerContext: data.experimentalBiggerContext === true,
      autoApproveToolCalls: hasTools,
    },
  };
}

function toolMaps(parsed: CodexParsedRequest) {
  const namespace = new Map<string, { namespace: string; name: string }>();
  const freeform = new Set<string>();
  const toolSearch = new Set<string>();
  for (const tool of parsed.context.tools ?? []) {
    const wireName = tool.namespace ? `${tool.namespace}__${tool.name}` : tool.name;
    if (tool.namespace) namespace.set(wireName, { namespace: tool.namespace, name: tool.name });
    if (tool.freeform) freeform.add(wireName);
    if (tool.toolSearch) toolSearch.add(wireName);
  }
  return { namespace, freeform, toolSearch };
}

export class ChatGptWebCodexExecutor extends BaseExecutor {
  constructor() {
    super("chatgpt-web-codex", {
      id: "chatgpt-web-codex",
      baseUrl: "https://chatgpt.com",
      format: FORMATS.OPENAI_RESPONSES,
    });
  }

  override async execute(input: ExecuteInput): Promise<ExecutorExecuteResult> {
    try {
      const body = record(input.body);
      if (
        input.clientResponseFormat !== FORMATS.OPENAI_RESPONSES ||
        body._nativeCodexPassthrough !== true
      ) {
        return wrapped(
          errorResponse(
            400,
            "ChatGPT Web (Codex) supports only native /v1/responses requests",
            "unsupported_endpoint"
          ),
          input.body
        );
      }
      if (!isVerifiedNativeCodexRequest(body, input.clientHeaders)) {
        return wrapped(
          errorResponse(
            400,
            "ChatGPT Web (Codex) requires a verified Codex client request with thread_id and turn_id",
            "unverified_codex_client"
          ),
          input.body
        );
      }

      const connectionId = input.credentials.connectionId?.trim();
      const encodedCredentials = input.credentials.apiKey?.trim();
      if (!connectionId || !encodedCredentials) {
        return wrapped(
          errorResponse(401, "ChatGPT Web (Codex) connection credentials are missing"),
          input.body
        );
      }
      const secrets = decodeChatGptWebCodexSecrets(encodedCredentials);

      const initialBody = nativeBody(input.body);
      const initialParsed = parseRequest(initialBody);
      const namespace = responseStateNamespace(connectionId, initialParsed);
      const resolvedPrevious = resolveChatGptWebCodexPreviousResponse(initialBody, namespace);
      if (!resolvedPrevious.ok) {
        return wrapped(
          errorResponse(
            409,
            "previous_response_id does not belong to this verified Codex turn",
            "invalid_previous_response_binding"
          ),
          initialBody
        );
      }
      const expandedBody = resolvedPrevious.body;
      const parsed = parseRequest(expandedBody);
      responseStateNamespace(connectionId, parsed);

      const route = requireChatGptWebCodexRoute(input.model);
      const explicitEffort = reasoningEffortOf(initialBody);
      const normalizedEffort = explicitEffort === "ultra" ? "max" : explicitEffort;
      if (normalizedEffort && normalizedEffort !== route.effort) {
        return wrapped(
          errorResponse(
            400,
            `Requested reasoning effort ${explicitEffort} is incompatible with model ${route.id}`,
            "incompatible_reasoning_effort"
          ),
          initialBody
        );
      }

      const storageStatePath = ensureConnectionStorageStateFromCredential(connectionId, secrets);
      const providerData = record(input.credentials.providerSpecificData);
      const browserRuntime = resolveChatGptWebCodexBrowserRuntime(providerData);
      if (!browserRuntime.available) {
        throw new ChatGptWebCodexRuntimeError(
          "chatgpt_web_codex_browser_unavailable",
          "ChatGPT Web (Codex) browser runtime is unavailable",
          503
        );
      }
      requireVerifiedRouteCapabilities(route, providerData);
      const cdpEndpoint = browserRuntime.cdpEndpoint;
      const chromeExecutablePath = browserRuntime.chromeExecutablePath;
      const runtimePaths = connectionRuntimePaths(connectionId);
      const loginConfig = {
        mode: "browser-only" as const,
        appName:
          configuredString(providerData, "connectorName", "appName") ??
          CHATGPT_WEB_CODEX_CONNECTOR_NAME,
        ...(chromeExecutablePath ? { chromeExecutablePath } : {}),
        ...(cdpEndpoint ? { cdpEndpoint } : {}),
        storageStatePath,
        brokerSocketPath: runtimePaths.brokerSocketPath,
        headed: CHATGPT_WEB_CODEX_RUNTIME_HEADED,
        proAvailable: providerData.proAvailable === true,
        autoApproveToolCalls: false,
      };
      if (!browserLoginStateExists(loginConfig)) {
        const verificationAdmission = acquireChatGptWebRuntimeAdmission(
          connectionId,
          "verification"
        );
        let capabilities: Awaited<ReturnType<typeof inspectBrowserLoginCapabilities>>;
        try {
          capabilities = await inspectBrowserLoginCapabilities(loginConfig);
        } finally {
          verificationAdmission.release();
        }
        const capabilitiesVerified =
          typeof capabilities.solAvailable === "boolean" &&
          typeof capabilities.proAvailable === "boolean";
        providerData.solAvailable = capabilities.solAvailable;
        providerData.proAvailable = capabilities.proAvailable;
        providerData.browserVerified = capabilitiesVerified;
        providerData.pendingBrowserVerification = !capabilitiesVerified;
        if (chromeExecutablePath) providerData.chromeExecutablePath = chromeExecutablePath;
        await input.onCredentialsRefreshed?.({
          providerSpecificData: {
            ...record(input.credentials.providerSpecificData),
            solAvailable: capabilities.solAvailable,
            proAvailable: capabilities.proAvailable,
            browserVerified: capabilitiesVerified,
            pendingBrowserVerification: !capabilitiesVerified,
            ...(chromeExecutablePath ? { chromeExecutablePath } : {}),
          },
        });
      }
      const provider = buildProviderConfig(
        { ...input, credentials: { ...input.credentials, providerSpecificData: providerData } },
        parsed,
        storageStatePath,
        connectionId
      );
      const routeUsesTools = toolModeRequired(parsed);
      if (routeUsesTools) {
        const tunnelId =
          configuredString(providerData, "tunnelId") ??
          process.env.CHATGPT_WEB_CODEX_TUNNEL_ID?.trim();
        const runtimeKey = secrets.runtimeKey ?? process.env.CHATGPT_WEB_CODEX_RUNTIME_KEY?.trim();
        if (!tunnelId || !runtimeKey) {
          throw new Error("ChatGPT Web (Codex) tools require Tunnel-ID and Runtime-Key");
        }
        await ensureTunnelRuntimeReady({
          tunnelId,
          runtimeKey,
          brokerSocketPath: connectionRuntimePaths(connectionId).brokerSocketPath,
        });
      }
      const adapter = createChatGptWebAdapter(provider);
      const worker = ChatGptBrowserWorker.forProvider(provider);
      trackChatGptWebCodexRuntime(worker, connectionRuntimePaths(connectionId).brokerSocketPath);
      const maps = toolMaps(parsed);
      const events = new AsyncEventQueue<AdapterEvent>();
      const incoming = {
        headers: headersFromRecord(input.clientHeaders),
        abortSignal: input.signal ?? undefined,
      };
      const run = async () => {
        let admission: ReturnType<typeof acquireChatGptWebRuntimeAdmission> | undefined;
        try {
          admission = acquireChatGptWebRuntimeAdmission(connectionId, "codex");
          await adapter.runTurn(parsed, incoming, (event) => events.push(event));
        } catch (error) {
          if (error instanceof ChatGptWebAdapterError) {
            events.push({
              type: "error",
              message: sanitizeErrorMessage(error.message),
              status: error.status,
              errorType: error.errorType,
              code: error.code,
            });
          } else {
            events.push({
              type: "error",
              message: sanitizeErrorMessage(error instanceof Error ? error.message : error),
              status: 502,
              errorType: "provider_error",
              code: "chatgpt_web_codex_turn_failed",
            });
          }
        } finally {
          try {
            const storageState = readConnectionStorageState(storageStatePath);
            await input.onCredentialsRefreshed?.({
              apiKey: encodeChatGptWebCodexSecrets({
                storageState,
                runtimeKey: secrets.runtimeKey,
              }),
            });
          } catch (refreshError) {
            input.log?.warn?.(
              "CHATGPT_WEB_CODEX",
              sanitizeErrorMessage(
                refreshError instanceof Error ? refreshError.message : refreshError
              )
            );
          }
          admission?.release();
          events.close();
        }
      };

      if (!input.stream) {
        const running = run();
        const collected = await events.collect();
        await running;
        const response = buildResponseJSON(collected, input.model, {
          hideThinkingSummary: parsed.options.hideThinkingSummary,
          toolNsMap: maps.namespace,
          freeformToolNames: maps.freeform,
          toolSearchToolNames: maps.toolSearch,
          compaction: parsed._compactionRequest,
        });
        rememberResponseState(expandedBody, response, { force: true, namespace });
        return wrapped(
          new Response(JSON.stringify(response), { status: 200, headers: JSON_HEADERS }),
          expandedBody
        );
      }

      void run();
      const stream = bridgeToResponsesSSE(
        events,
        input.model,
        maps.namespace,
        maps.freeform,
        maps.toolSearch,
        undefined,
        2_000,
        {
          hideThinkingSummary: parsed.options.hideThinkingSummary,
          compaction: parsed._compactionRequest,
          onCompletedResponse: (response) =>
            rememberResponseState(expandedBody, response, { force: true, namespace }),
        }
      );
      return wrapped(new Response(stream, { status: 200, headers: SSE_HEADERS }), expandedBody);
    } catch (error) {
      input.log?.warn?.(
        "CHATGPT_WEB_CODEX",
        sanitizeErrorMessage(error instanceof Error ? error.message : error)
      );
      if (error instanceof ChatGptWebCodexRuntimeError) {
        return wrapped(errorResponse(error.statusCode, error.message, error.code), input.body);
      }
      return wrapped(
        errorResponse(400, error instanceof Error ? error.message : error),
        input.body
      );
    }
  }
}
