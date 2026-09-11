import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ChatGPTWebCodexVerificationCoordinator,
  buildVerificationKey,
  classifyVerificationError,
  ChatGptWebVerificationError,
  ChatGptWebAuthVerificationError,
  ChatGptWebRuntimeVerificationError,
  ChatGptWebTimeoutVerificationError,
} from "../../open-sse/services/chatgptWebCodexVerification.ts";
import {
  writeVerificationMarker,
  loginVerificationMarkerPath,
  invalidateVerificationMarker,
  LOGIN_VERIFICATION_TTL_MS,
  type BrowserLoginConfig,
} from "../../open-sse/vendor/codex-chatgpt-web/browser-login.ts";
import { validateChatGptWebCodexProvider } from "../../src/lib/providers/validation/chatgptWebCodex.ts";
import { ChatGptWebCodexExecutor } from "../../open-sse/executors/chatgpt-web-codex.ts";
import { encodeChatGptWebCodexSecrets } from "../../open-sse/executors/chatgpt-web-codex/credentials.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";

test.after(() => {
  resetDbInstance();
});

test("VerificationCoordinator: buildVerificationKey creates composite key", () => {
  const key = buildVerificationKey("conn-123", "fp-abc", "http://browser:9223");
  assert.equal(key, "8:conn-123|6:fp-abc|19:http://browser:9223");
  assert.notEqual(buildVerificationKey("a:b", "c", "d"), buildVerificationKey("a", "b:c", "d"));
});

test("VerificationCoordinator: classifyVerificationError preserves typed error categories", () => {
  // 1. Auth errors -> 401
  const authErr1 = classifyVerificationError(new Error("ChatGPT login state is missing"));
  assert.ok(authErr1 instanceof ChatGptWebAuthVerificationError);
  assert.equal(authErr1.statusCode, 401);
  assert.equal(authErr1.code, "chatgpt_web_codex_auth_error");

  const authErr2 = classifyVerificationError(
    new Error("ChatGPT authentication could not be verified: no visible composer is present")
  );
  assert.ok(authErr2 instanceof ChatGptWebAuthVerificationError);
  assert.equal(authErr2.statusCode, 401);

  const authErr3 = classifyVerificationError(
    new Error("The account chooser requires sign-in to ChatGPT")
  );
  assert.ok(authErr3 instanceof ChatGptWebAuthVerificationError);
  assert.equal(authErr3.statusCode, 401);

  // 2. Timeout errors -> 504
  const timeoutErr1 = classifyVerificationError(
    new Error("Navigation timeout of 25000ms exceeded")
  );
  assert.ok(timeoutErr1 instanceof ChatGptWebTimeoutVerificationError);
  assert.equal(timeoutErr1.statusCode, 504);
  assert.equal(timeoutErr1.code, "chatgpt_web_codex_verification_timeout");

  const timeoutCustom = new Error("Verification timed out waiting for page");
  timeoutCustom.name = "TimeoutError";
  const timeoutErr2 = classifyVerificationError(timeoutCustom);
  assert.ok(timeoutErr2 instanceof ChatGptWebTimeoutVerificationError);
  assert.equal(timeoutErr2.statusCode, 504);

  // 3. Runtime errors -> 503
  const runtimeErr1 = classifyVerificationError(
    new Error("ChatGPT browser verification requires Chrome or a CDP endpoint")
  );
  assert.ok(runtimeErr1 instanceof ChatGptWebRuntimeVerificationError);
  assert.equal(runtimeErr1.statusCode, 503);
  assert.equal(runtimeErr1.code, "chatgpt_web_codex_browser_unavailable");

  const runtimeErr2 = classifyVerificationError(new Error("connect ECONNREFUSED 127.0.0.1:9223"));
  assert.ok(runtimeErr2 instanceof ChatGptWebRuntimeVerificationError);
  assert.equal(runtimeErr2.statusCode, 503);

  // 4. Existing typed error is preserved as-is
  const custom = new ChatGptWebVerificationError("custom_code", "custom msg", 418);
  const preserved = classifyVerificationError(custom);
  assert.equal(preserved, custom);
  assert.equal(preserved.statusCode, 418);
  assert.equal(preserved.code, "custom_code");
});

test("VerificationCoordinator: reuses existing valid marker within TTL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coord-ttl-"));
  try {
    const storageStatePath = join(dir, "storage-state.json");
    const stateContent = JSON.stringify({
      cookies: [{ name: "__Secure-next-auth.session-token", value: "tok" }],
      origins: [],
    });
    writeFileSync(storageStatePath, `${stateContent}\n`);

    // Write verified marker with sol: false, pro: false
    writeVerificationMarker(storageStatePath, { solAvailable: false, proAvailable: false });

    const coordinator = new ChatGPTWebCodexVerificationCoordinator();
    let inspectionCalled = false;
    coordinator.setInspectorOverride(async () => {
      inspectionCalled = true;
      return { solAvailable: true, proAvailable: true };
    });

    const loginConfig: BrowserLoginConfig = {
      appName: "test-app",
      storageStatePath,
      headed: false,
      proAvailable: false,
      autoApproveToolCalls: false,
    };

    const result = await coordinator.coordinateVerification({
      connectionId: "test-conn",
      credentialFingerprint: "fp123",
      runtimeIdentity: "http://browser:9223",
      loginConfig,
    });

    assert.equal(result.fromCache, true);
    assert.equal(result.capabilitiesVerified, true);
    assert.equal(result.capabilities.solAvailable, false);
    assert.equal(result.capabilities.proAvailable, false);
    assert.equal(inspectionCalled, false, "Should NOT call inspector when valid marker exists");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("VerificationCoordinator: force option bypasses existing marker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coord-force-"));
  try {
    const storageStatePath = join(dir, "storage-state.json");
    const stateContent = JSON.stringify({
      cookies: [{ name: "__Secure-next-auth.session-token", value: "tok" }],
      origins: [],
    });
    writeFileSync(storageStatePath, `${stateContent}\n`);

    writeVerificationMarker(storageStatePath, { solAvailable: false, proAvailable: false });

    const coordinator = new ChatGPTWebCodexVerificationCoordinator();
    let inspectionCalled = false;
    coordinator.setInspectorOverride(async () => {
      inspectionCalled = true;
      return { solAvailable: true, proAvailable: true };
    });

    const loginConfig: BrowserLoginConfig = {
      appName: "test-app",
      storageStatePath,
      headed: false,
      proAvailable: false,
      autoApproveToolCalls: false,
    };

    const result = await coordinator.coordinateVerification({
      connectionId: "test-conn",
      credentialFingerprint: "fp123",
      runtimeIdentity: "http://browser:9223",
      loginConfig,
      force: true,
    });

    assert.equal(result.fromCache, false);
    assert.equal(inspectionCalled, true);
    assert.equal(result.capabilities.solAvailable, true);
    assert.equal(result.capabilities.proAvailable, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("VerificationCoordinator: concurrent callers deduplicate into single execution", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coord-dedup-"));
  try {
    const storageStatePath = join(dir, "storage-state.json");
    writeFileSync(storageStatePath, `{}\n`);

    const coordinator = new ChatGPTWebCodexVerificationCoordinator();
    let inspectionCount = 0;
    let finishInspection!: () => void;
    const inspectionHold = new Promise<void>((resolve) => {
      finishInspection = resolve;
    });

    coordinator.setInspectorOverride(async () => {
      inspectionCount++;
      await inspectionHold;
      return { solAvailable: true, proAvailable: false };
    });

    const loginConfig: BrowserLoginConfig = {
      appName: "test-app",
      storageStatePath,
      headed: false,
      proAvailable: false,
      autoApproveToolCalls: false,
    };

    const promise1 = coordinator.coordinateVerification({
      connectionId: "conn-shared",
      credentialFingerprint: "fp-same",
      runtimeIdentity: "http://cdp:9223",
      loginConfig,
    });

    const promise2 = coordinator.coordinateVerification({
      connectionId: "conn-shared",
      credentialFingerprint: "fp-same",
      runtimeIdentity: "http://cdp:9223",
      loginConfig,
    });

    // Release inspection
    finishInspection();

    const [res1, res2] = await Promise.all([promise1, promise2]);

    assert.equal(inspectionCount, 1, "Only 1 inspection should have run for identical key");
    assert.equal(res1.capabilities.solAvailable, true);
    assert.equal(res2.capabilities.solAvailable, true);
    assert.equal(res1.fromCache, false);
    assert.equal(res2.fromCache, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("VerificationCoordinator: per-consumer abort isolation preserves surviving consumer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coord-abort-iso-"));
  try {
    const storageStatePath = join(dir, "storage-state.json");
    writeFileSync(storageStatePath, `{}\n`);

    const coordinator = new ChatGPTWebCodexVerificationCoordinator();
    let inspectionStarted = false;
    let finishInspection!: () => void;
    const inspectionHold = new Promise<void>((resolve) => {
      finishInspection = resolve;
    });

    coordinator.setInspectorOverride(async (_config) => {
      inspectionStarted = true;
      await inspectionHold;
      return { solAvailable: true, proAvailable: true };
    });

    const loginConfig: BrowserLoginConfig = {
      appName: "test-app",
      storageStatePath,
      headed: false,
      proAvailable: false,
      autoApproveToolCalls: false,
    };

    const ac1 = new AbortController();
    const ac2 = new AbortController();

    const p1 = coordinator.coordinateVerification({
      connectionId: "conn-abort-iso",
      credentialFingerprint: "fp-iso",
      runtimeIdentity: "http://cdp:9223",
      loginConfig,
      signal: ac1.signal,
    });

    const p2 = coordinator.coordinateVerification({
      connectionId: "conn-abort-iso",
      credentialFingerprint: "fp-iso",
      runtimeIdentity: "http://cdp:9223",
      loginConfig,
      signal: ac2.signal,
    });

    // Consumer 1 aborts while inspection is running
    ac1.abort(new DOMException("Consumer 1 cancelled", "AbortError"));

    await assert.rejects(
      p1,
      (err: unknown) => (err as Error).name === "AbortError" || /cancelled/i.test(String(err))
    );

    // Surviving Consumer 2 should still complete successfully when inspection finishes
    finishInspection();
    const res2 = await p2;

    assert.equal(inspectionStarted, true);
    assert.equal(res2.capabilities.solAvailable, true);
    assert.equal(res2.capabilities.proAvailable, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("VerificationCoordinator: all consumers aborting triggers underlying task cancellation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coord-abort-all-"));
  try {
    const storageStatePath = join(dir, "storage-state.json");
    writeFileSync(storageStatePath, `{}\n`);

    const coordinator = new ChatGPTWebCodexVerificationCoordinator();
    let taskSignalAborted = false;

    coordinator.setInspectorOverride(async (config) => {
      return new Promise((_, reject) => {
        if (config.signal?.aborted) {
          taskSignalAborted = true;
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        config.signal?.addEventListener("abort", () => {
          taskSignalAborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    });

    const loginConfig: BrowserLoginConfig = {
      appName: "test-app",
      storageStatePath,
      headed: false,
      proAvailable: false,
      autoApproveToolCalls: false,
    };

    const ac = new AbortController();
    const p = coordinator.coordinateVerification({
      connectionId: "conn-abort-all",
      credentialFingerprint: "fp-all",
      runtimeIdentity: "http://cdp:9223",
      loginConfig,
      signal: ac.signal,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    ac.abort();

    await assert.rejects(p);
    assert.equal(
      taskSignalAborted,
      true,
      "Underlying task should receive abort signal when all consumers abort"
    );
    assert.equal(coordinator.inFlightCount, 0, "In-flight map must be clean");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("VerificationCoordinator: invalidateConnection clears marker and in-flight", async () => {
  assert.equal(LOGIN_VERIFICATION_TTL_MS, 7 * 24 * 60 * 60 * 1000);
  const dir = mkdtempSync(join(tmpdir(), "coord-inval-"));
  try {
    const storageStatePath = join(dir, "storage-state.json");
    writeFileSync(storageStatePath, `{}\n`);
    writeVerificationMarker(storageStatePath, { solAvailable: true, proAvailable: true });

    assert.equal(existsSync(loginVerificationMarkerPath(storageStatePath)), true);

    const coordinator = new ChatGPTWebCodexVerificationCoordinator();
    coordinator.invalidateConnection("conn-inval", storageStatePath);

    assert.equal(
      existsSync(loginVerificationMarkerPath(storageStatePath)),
      false,
      "Verification marker must be removed after invalidateConnection"
    );

    // Also test direct invalidateVerificationMarker helper
    writeVerificationMarker(storageStatePath, { solAvailable: false, proAvailable: false });
    assert.equal(existsSync(loginVerificationMarkerPath(storageStatePath)), true);
    invalidateVerificationMarker(storageStatePath);
    assert.equal(existsSync(loginVerificationMarkerPath(storageStatePath)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateChatGptWebCodexProvider: validates model route availability when provided", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cgw-model-val-"));
  const prevDataDir = process.env.DATA_DIR;
  try {
    process.env.DATA_DIR = dir;

    const cookie = "__Secure-next-auth.session-token=mock-val-token; path=/; domain=.chatgpt.com";

    // 1. Invalid / unknown model route rejected immediately
    const resInvalidModel = await validateChatGptWebCodexProvider({
      apiKey: cookie,
      providerSpecificData: {
        connectorName: "Test Connector",
        chromeExecutablePath: "disabled",
      },
      model: "non-existent-model",
    });
    assert.equal(resInvalidModel.valid, false);
    assert.equal(resInvalidModel.statusCode, 400);
    assert.match(resInvalidModel.error ?? "", /unsupported chatgpt web/i);

    // 2. Sol model on Luna-only capabilities rejected
    const resSolOnLuna = await validateChatGptWebCodexProvider({
      apiKey: cookie,
      providerSpecificData: {
        connectorName: "Test Connector",
        chromeExecutablePath: "disabled",
        solAvailable: false,
        proAvailable: false,
        browserVerified: true,
        pendingBrowserVerification: false,
      },
      model: "instant",
    });
    assert.equal(resSolOnLuna.valid, false);
    assert.equal(resSolOnLuna.statusCode, 400);
    assert.match(resSolOnLuna.error ?? "", /luna-only/i);

    // 3. Luna model on Luna-only capabilities accepted
    const resLunaOnLuna = await validateChatGptWebCodexProvider({
      apiKey: cookie,
      providerSpecificData: {
        connectorName: "Test Connector",
        chromeExecutablePath: "disabled",
        solAvailable: false,
        proAvailable: false,
        browserVerified: true,
        pendingBrowserVerification: false,
      },
      model: "luna",
    });
    assert.equal(resLunaOnLuna.valid, true);

    // 4. Pro model on non-Pro capabilities rejected
    const resProOnNonPro = await validateChatGptWebCodexProvider({
      apiKey: cookie,
      providerSpecificData: {
        connectorName: "Test Connector",
        chromeExecutablePath: "disabled",
        solAvailable: true,
        proAvailable: false,
        browserVerified: true,
        pendingBrowserVerification: false,
      },
      model: "pro",
    });
    assert.equal(resProOnNonPro.valid, false);
    assert.equal(resProOnNonPro.statusCode, 400);
    assert.match(resProOnNonPro.error ?? "", /non-pro/i);
  } finally {
    process.env.DATA_DIR = prevDataDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ChatGptWebCodexExecutor: preserves typed verification errors instead of blanket 503", async () => {
  const dir = mkdtempSync(join(tmpdir(), "executor-err-"));
  const prevHome = process.env.CODEX_CHATGPT_WEB_HOME;
  const prevCdp = process.env.CHATGPT_WEB_CDP_URL;
  try {
    process.env.CODEX_CHATGPT_WEB_HOME = dir;
    process.env.CHATGPT_WEB_CDP_URL = "http://browser:9223";

    const executor = new ChatGptWebCodexExecutor();
    const { verificationCoordinator } =
      await import("../../open-sse/services/chatgptWebCodexVerification.ts");

    // 1. Auth error test
    verificationCoordinator.setInspectorOverride(async () => {
      throw new Error("ChatGPT login state is missing: account chooser requires sign-in");
    });

    const resAuth = await executor.execute({
      model: "luna",
      stream: false,
      clientResponseFormat: "openai-responses",
      credentials: {
        connectionId: "conn-auth-err",
        apiKey: encodeChatGptWebCodexSecrets({
          cookie: "__Secure-next-auth.session-token=TEST_ONLY",
        }),
        providerSpecificData: {},
      },
      clientHeaders: { originator: "codex_cli_rs" },
      body: {
        model: "gpt-5.6-luna",
        _nativeCodexPassthrough: true,
        client_metadata: {
          "x-codex-turn-metadata": {
            thread_id: "th-1",
            turn_id: "tu-1",
          },
        },
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hi" }],
          },
        ],
      },
    });

    assert.equal(resAuth.response.status, 401, "Auth verification failure must yield 401");
    const authBody = await resAuth.response.json();
    assert.equal(authBody.error.code, "chatgpt_web_codex_auth_error");

    // 2. Timeout error test
    verificationCoordinator.setInspectorOverride(async () => {
      const timeoutErr = new Error("Navigation timeout of 25000ms exceeded");
      timeoutErr.name = "TimeoutError";
      throw timeoutErr;
    });

    const resTimeout = await executor.execute({
      model: "luna",
      stream: false,
      clientResponseFormat: "openai-responses",
      credentials: {
        connectionId: "conn-timeout-err",
        apiKey: encodeChatGptWebCodexSecrets({
          cookie: "__Secure-next-auth.session-token=TEST_ONLY",
        }),
        providerSpecificData: {},
      },
      clientHeaders: { originator: "codex_cli_rs" },
      body: {
        model: "gpt-5.6-luna",
        _nativeCodexPassthrough: true,
        client_metadata: {
          "x-codex-turn-metadata": {
            thread_id: "th-2",
            turn_id: "tu-2",
          },
        },
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hi" }],
          },
        ],
      },
    });

    assert.equal(resTimeout.response.status, 504, "Timeout verification failure must yield 504");
    const timeoutBody = await resTimeout.response.json();
    assert.equal(timeoutBody.error.code, "chatgpt_web_codex_verification_timeout");
  } finally {
    const { verificationCoordinator } =
      await import("../../open-sse/services/chatgptWebCodexVerification.ts");
    verificationCoordinator.setInspectorOverride(null);
    if (prevHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
    else process.env.CODEX_CHATGPT_WEB_HOME = prevHome;
    if (prevCdp === undefined) delete process.env.CHATGPT_WEB_CDP_URL;
    else process.env.CHATGPT_WEB_CDP_URL = prevCdp;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateChatGptWebCodexProvider: preserves typed errors when browser verification fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "val-typed-err-"));
  const prevDataDir = process.env.DATA_DIR;
  const prevCdp = process.env.CHATGPT_WEB_CDP_URL;
  try {
    process.env.DATA_DIR = dir;
    process.env.CHATGPT_WEB_CDP_URL = "http://browser:9223";

    const { verificationCoordinator } =
      await import("../../open-sse/services/chatgptWebCodexVerification.ts");

    // 1. Auth error
    verificationCoordinator.setInspectorOverride(async () => {
      throw new Error("ChatGPT login state is missing");
    });

    const resAuth = await validateChatGptWebCodexProvider({
      apiKey: "__Secure-next-auth.session-token=mock-token",
      providerSpecificData: {
        connectorName: "Test",
        verifyBrowserLogin: true,
      },
    });

    assert.equal(resAuth.valid, false);
    assert.equal(resAuth.statusCode, 401);
    assert.equal(resAuth.errorCode, "chatgpt_web_codex_auth_error");

    // 2. Timeout error
    verificationCoordinator.setInspectorOverride(async () => {
      const err = new Error("Navigation timeout exceeded");
      err.name = "TimeoutError";
      throw err;
    });

    const resTimeout = await validateChatGptWebCodexProvider({
      apiKey: "__Secure-next-auth.session-token=mock-token",
      providerSpecificData: {
        connectorName: "Test",
        verifyBrowserLogin: true,
      },
    });

    assert.equal(resTimeout.valid, false);
    assert.equal(resTimeout.statusCode, 504);
    assert.equal(resTimeout.errorCode, "chatgpt_web_codex_verification_timeout");
  } finally {
    const { verificationCoordinator } =
      await import("../../open-sse/services/chatgptWebCodexVerification.ts");
    verificationCoordinator.setInspectorOverride(null);
    process.env.DATA_DIR = prevDataDir;
    if (prevCdp === undefined) delete process.env.CHATGPT_WEB_CDP_URL;
    else process.env.CHATGPT_WEB_CDP_URL = prevCdp;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("VerificationCoordinator: pre-aborted signal rejects immediately and does not hang", async () => {
  const coordinator = new ChatGPTWebCodexVerificationCoordinator();
  const controller = new AbortController();
  controller.abort(new DOMException("Pre-aborted", "AbortError"));

  const loginConfig: BrowserLoginConfig = {
    appName: "Test",
    storageStatePath: "/tmp/non-existent.json",
  };

  await assert.rejects(
    async () => {
      await coordinator.coordinateVerification({
        connectionId: "conn-pre-abort",
        credentialFingerprint: "fp-1",
        runtimeIdentity: "id-1",
        loginConfig,
        signal: controller.signal,
      });
    },
    { name: "AbortError" }
  );
  assert.equal(coordinator.inFlightCount, 0);
});
