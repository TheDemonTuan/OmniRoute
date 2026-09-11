import { sanitizeErrorMessage } from "../utils/error.ts";
import {
  browserLoginStateExists,
  inspectBrowserLoginCapabilities,
  storedBrowserLoginCapabilities,
  invalidateVerificationMarker,
  type BrowserLoginConfig,
} from "../vendor/codex-chatgpt-web/browser-login.ts";
import type { ChatGptWebAccountCapabilities } from "../vendor/codex-chatgpt-web/chatgpt-web-models.ts";
import {
  acquireQueuedChatGptWebRuntimeAdmission,
  type ChatGptWebRuntimeAdmission,
} from "../utils/chatgptWebRuntimeGuard.ts";

export class ChatGptWebVerificationError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 500, cause?: unknown) {
    super(message);
    this.name = "ChatGptWebVerificationError";
    this.code = code;
    this.statusCode = statusCode;
    if (cause !== undefined) this.cause = cause;
  }
}

export class ChatGptWebAuthVerificationError extends ChatGptWebVerificationError {
  constructor(message = "ChatGPT Web authentication verification failed", cause?: unknown) {
    super("chatgpt_web_codex_auth_error", message, 401, cause);
    this.name = "ChatGptWebAuthVerificationError";
  }
}

export class ChatGptWebRuntimeVerificationError extends ChatGptWebVerificationError {
  constructor(message = "ChatGPT Web browser runtime unavailable", cause?: unknown) {
    super("chatgpt_web_codex_browser_unavailable", message, 503, cause);
    this.name = "ChatGptWebRuntimeVerificationError";
  }
}

export class ChatGptWebTimeoutVerificationError extends ChatGptWebVerificationError {
  constructor(message = "ChatGPT Web verification timed out", cause?: unknown) {
    super("chatgpt_web_codex_verification_timeout", message, 504, cause);
    this.name = "ChatGptWebTimeoutVerificationError";
  }
}

export function classifyVerificationError(error: unknown): ChatGptWebVerificationError {
  if (error instanceof ChatGptWebVerificationError) {
    return error;
  }

  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = sanitizeErrorMessage(rawMessage);
  const lower = rawMessage.toLowerCase();

  if (
    (error instanceof Error && error.name === "AbortError") ||
    lower.includes("aborted") ||
    lower.includes("operation aborted")
  ) {
    return new ChatGptWebVerificationError("aborted", "Verification request aborted", 499, error);
  }

  if (
    lower.includes("login state is missing") ||
    lower.includes("authentication could not be verified") ||
    lower.includes("account chooser requires sign-in") ||
    lower.includes("not authenticated") ||
    lower.includes("unauthenticated") ||
    lower.includes("unauthorized") ||
    lower.includes("invalid_api_key") ||
    (lower.includes("session-token") &&
      (lower.includes("missing") || lower.includes("invalid") || lower.includes("expired"))) ||
    lower.includes("sign in to chatgpt")
  ) {
    return new ChatGptWebAuthVerificationError(message, error);
  }

  if (
    (error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AppTimeoutError")) ||
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("exceeded timeout")
  ) {
    return new ChatGptWebTimeoutVerificationError(message, error);
  }

  if (
    lower.includes("requires chrome or a cdp endpoint") ||
    lower.includes("browser runtime is unavailable") ||
    lower.includes("chatgpt_browser_display_missing") ||
    lower.includes("browser_unavailable") ||
    lower.includes("econnrefused") ||
    lower.includes("target closed") ||
    lower.includes("browser has been closed") ||
    lower.includes("no supported chrome") ||
    lower.includes("connect over cdp")
  ) {
    return new ChatGptWebRuntimeVerificationError(message, error);
  }

  return new ChatGptWebVerificationError(
    "chatgpt_capability_verification_failed",
    message || "ChatGPT browser capability verification did not complete",
    503,
    error
  );
}

export function buildVerificationKey(
  connectionId: string,
  credentialFingerprint: string,
  runtimeIdentity: string
): string {
  return [connectionId, credentialFingerprint, runtimeIdentity]
    .map((part) => `${part.length}:${part}`)
    .join("|");
}

export interface VerificationCapabilities {
  solAvailable?: boolean;
  proAvailable?: boolean;
}

export interface VerificationOptions {
  connectionId: string;
  credentialFingerprint: string;
  runtimeIdentity: string;
  loginConfig: BrowserLoginConfig;
  signal?: AbortSignal;
  force?: boolean;
  onCapabilitiesUpdated?: (caps: VerificationCapabilities) => Promise<void> | void;
}

export interface VerificationResult {
  capabilities: VerificationCapabilities;
  capabilitiesVerified: boolean;
  fromCache: boolean;
  key: string;
}

interface Consumer {
  resolve: (res: VerificationResult) => void;
  reject: (err: unknown) => void;
  signal?: AbortSignal;
  cleanupSignal?: () => void;
}

interface InFlightTask {
  key: string;
  connectionId: string;
  controller: AbortController;
  consumers: Set<Consumer>;
  promise: Promise<VerificationResult>;
}

export class ChatGPTWebCodexVerificationCoordinator {
  private readonly inFlight = new Map<string, InFlightTask>();
  private inspectorOverride:
    ((config: BrowserLoginConfig) => Promise<Partial<ChatGptWebAccountCapabilities>>) | null = null;

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  setInspectorOverride(
    override:
      ((config: BrowserLoginConfig) => Promise<Partial<ChatGptWebAccountCapabilities>>) | null
  ): void {
    this.inspectorOverride = override;
  }

  async coordinateVerification(options: VerificationOptions): Promise<VerificationResult> {
    if (options.signal?.aborted) {
      throw (
        options.signal.reason ?? new DOMException("Verification consumer aborted", "AbortError")
      );
    }

    const key = buildVerificationKey(
      options.connectionId,
      options.credentialFingerprint,
      options.runtimeIdentity
    );

    if (!options.force && browserLoginStateExists(options.loginConfig)) {
      const stored = storedBrowserLoginCapabilities(options.loginConfig);
      const capabilitiesVerified =
        typeof stored.solAvailable === "boolean" && typeof stored.proAvailable === "boolean";
      return {
        capabilities: stored,
        capabilitiesVerified,
        fromCache: true,
        key,
      };
    }

    let task = this.inFlight.get(key);
    if (!task) {
      const controller = new AbortController();
      const consumers = new Set<Consumer>();

      const run = async (): Promise<VerificationResult> => {
        let admission: ChatGptWebRuntimeAdmission | undefined;
        try {
          admission = await acquireQueuedChatGptWebRuntimeAdmission(
            options.connectionId,
            "verification",
            { signal: controller.signal }
          );

          if (controller.signal.aborted) {
            throw (
              controller.signal.reason ??
              new DOMException("Verification task aborted", "AbortError")
            );
          }

          const inspector = this.inspectorOverride ?? inspectBrowserLoginCapabilities;
          const inspected = await inspector({
            ...options.loginConfig,
            signal: controller.signal,
          });

          const capabilities: VerificationCapabilities = {
            ...(typeof inspected.solAvailable === "boolean"
              ? { solAvailable: inspected.solAvailable }
              : {}),
            ...(typeof inspected.proAvailable === "boolean"
              ? { proAvailable: inspected.proAvailable }
              : {}),
          };
          const capabilitiesVerified =
            typeof capabilities.solAvailable === "boolean" &&
            typeof capabilities.proAvailable === "boolean";

          const result: VerificationResult = {
            capabilities,
            capabilitiesVerified,
            fromCache: false,
            key,
          };

          if (options.onCapabilitiesUpdated) {
            try {
              await options.onCapabilitiesUpdated(capabilities);
            } catch {
              // Non-blocking callback failure
            }
          }

          return result;
        } catch (rawError) {
          throw classifyVerificationError(rawError);
        } finally {
          try {
            admission?.release();
          } finally {
            this.inFlight.delete(key);
          }
        }
      };

      const taskPromise = run();
      task = {
        key,
        connectionId: options.connectionId,
        controller,
        consumers,
        promise: taskPromise,
      };
      this.inFlight.set(key, task);

      taskPromise
        .then((result) => {
          for (const consumer of task.consumers) {
            consumer.cleanupSignal?.();
            consumer.resolve(result);
          }
          task.consumers.clear();
        })
        .catch((error) => {
          for (const consumer of task.consumers) {
            consumer.cleanupSignal?.();
            consumer.reject(error);
          }
          task.consumers.clear();
        });
    }

    const currentTask = task;
    return new Promise<VerificationResult>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(
          options.signal.reason ?? new DOMException("Verification consumer aborted", "AbortError")
        );
        return;
      }

      const consumer: Consumer = {
        resolve,
        reject,
        signal: options.signal,
      };

      if (options.signal) {
        const onAbort = () => {
          consumer.cleanupSignal?.();
          currentTask.consumers.delete(consumer);
          reject(
            options.signal?.reason ??
              new DOMException("Verification consumer aborted", "AbortError")
          );

          if (currentTask.consumers.size === 0) {
            currentTask.controller.abort(
              options.signal?.reason ??
                new DOMException("All consumers aborted verification task", "AbortError")
            );
          }
        };

        options.signal.addEventListener("abort", onAbort, { once: true });
        consumer.cleanupSignal = () => {
          options.signal?.removeEventListener("abort", onAbort);
        };
      }

      currentTask.consumers.add(consumer);
    });
  }

  invalidate(key: string): void {
    const task = this.inFlight.get(key);
    if (task) {
      task.controller.abort(new DOMException("Verification key invalidated", "AbortError"));
      this.inFlight.delete(key);
    }
  }

  invalidateConnection(connectionId: string, storageStatePath?: string): void {
    if (storageStatePath) {
      invalidateVerificationMarker(storageStatePath);
    }
    for (const [key, task] of this.inFlight.entries()) {
      if (task.connectionId === connectionId) {
        task.controller.abort(
          new DOMException("Verification connection invalidated", "AbortError")
        );
        this.inFlight.delete(key);
      }
    }
  }

  clearAll(): void {
    for (const task of this.inFlight.values()) {
      task.controller.abort(new DOMException("Verification coordinator cleared", "AbortError"));
    }
    this.inFlight.clear();
  }
}

export const verificationCoordinator = new ChatGPTWebCodexVerificationCoordinator();

export function getVerificationCoordinator(): ChatGPTWebCodexVerificationCoordinator {
  return verificationCoordinator;
}
