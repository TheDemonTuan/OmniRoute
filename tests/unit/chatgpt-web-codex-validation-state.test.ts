import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ChatGptWebCodexRuntimeError,
  detectChromeExecutable,
  resolveChatGptWebCodexBrowserRuntime,
} from "../../open-sse/executors/chatgpt-web-codex/browserRuntime.ts";
import {
  decodeChatGptWebCodexSecrets,
  encodeChatGptWebCodexSecrets,
} from "../../open-sse/executors/chatgpt-web-codex/credentials.ts";
import { getChatGptWebCodexDoctorStatus } from "../../open-sse/executors/chatgpt-web-codex/doctor.ts";
import { ChatGptWebCodexExecutor } from "../../open-sse/executors/chatgpt-web-codex.ts";
import {
  cookieHeaderValue,
  finalizeValidatedChatGptWebCodexSecrets,
  parseCookies,
} from "../../open-sse/executors/chatgpt-web-codex/storageState.ts";
import { validateChatGptWebCodexProvider } from "../../src/lib/providers/validation/chatgptWebCodex.ts";
import { classifyFailure } from "../../src/app/api/providers/[id]/test/publicErrorBoundary.ts";
import { validationBadgeProps } from "../../src/app/(dashboard)/dashboard/providers/[id]/providerPageHelpers.ts";

const VALID_COOKIE =
  "__Secure-next-auth.session-token=mock-valid-session-token-abc123xyz; path=/; domain=.chatgpt.com";
const MALFORMED_COOKIE = "foo=bar; abc=xyz";

test("Test A — cookie structurally valid, browser/CDP offline", async () => {
  const prevCdp = process.env.CHATGPT_WEB_CODEX_CDP_URL;
  const prevChrome = process.env.CHATGPT_WEB_CODEX_CHROME_PATH;
  const prevPath = process.env.CHROME_PATH;
  const prevDefaultPaths = process.env.CHATGPT_WEB_CODEX_DEFAULT_CHROME_PATHS;
  const root = mkdtempSync(join(tmpdir(), "omniroute-cgw-testa-"));
  const prevDataDir = process.env.DATA_DIR;

  try {
    delete process.env.CHATGPT_WEB_CODEX_CDP_URL;
    process.env.CHATGPT_WEB_CODEX_DEFAULT_CHROME_PATHS = "0";
    process.env.CHATGPT_WEB_CODEX_CHROME_PATH = "disabled";
    delete process.env.CHROME_PATH;
    process.env.DATA_DIR = root;

    // 1. Validation detects browser offline but accepts structurally valid cookie
    const result = await validateChatGptWebCodexProvider({
      apiKey: VALID_COOKIE,
      providerSpecificData: {
        connectorName: "OmniRoute Test Connector",
        chromeExecutablePath: "disabled",
      },
    });

    assert.equal(result.valid, true);
    assert.equal(result.pendingBrowserVerification, true);
    assert.equal(result.runtime?.available, false);
    assert.equal(result.runtime?.reason, "browser_unavailable");
    assert.equal(result.providerSpecificData?.pendingBrowserVerification, true);
    assert.equal(result.providerSpecificData?.browserVerified, false);
    assert.ok(typeof result.providerSpecificData?.validationId === "string");

    // 2. Finalize credential saves cookie with pendingBrowserVerification marker
    const finalized = finalizeValidatedChatGptWebCodexSecrets(
      JSON.stringify({ version: 1, cookie: VALID_COOKIE }),
      result.providerSpecificData?.validationId as string
    );

    assert.equal(finalized.pendingBrowserVerification, true);
    const decoded = decodeChatGptWebCodexSecrets(finalized.encodedCredential);
    assert.ok(decoded.cookie);
    assert.match(decoded.cookie, /mock-valid-session-token/);

    // 3. Doctor reports credential ready but browser offline and verification pending
    const doctor = await getChatGptWebCodexDoctorStatus({
      id: "conn-test-a",
      apiKey: finalized.encodedCredential,
      providerSpecificData: {
        connectorName: "OmniRoute Test Connector",
        chromeExecutablePath: "disabled",
        pendingBrowserVerification: true,
      },
    });

    assert.equal(doctor.credential.ready, true);
    assert.equal(doctor.credential.kind, "cookie");
    assert.equal(doctor.browser.ready, false);
    assert.equal(doctor.verification.pending, true);
    assert.equal(doctor.login.ready, false);
  } finally {
    if (prevCdp !== undefined) process.env.CHATGPT_WEB_CODEX_CDP_URL = prevCdp;
    else delete process.env.CHATGPT_WEB_CODEX_CDP_URL;
    if (prevChrome !== undefined) process.env.CHATGPT_WEB_CODEX_CHROME_PATH = prevChrome;
    else delete process.env.CHATGPT_WEB_CODEX_CHROME_PATH;
    if (prevPath !== undefined) process.env.CHROME_PATH = prevPath;
    else delete process.env.CHROME_PATH;
    if (prevDefaultPaths !== undefined)
      process.env.CHATGPT_WEB_CODEX_DEFAULT_CHROME_PATHS = prevDefaultPaths;
    else delete process.env.CHATGPT_WEB_CODEX_DEFAULT_CHROME_PATHS;
    if (prevDataDir !== undefined) process.env.DATA_DIR = prevDataDir;
    else delete process.env.DATA_DIR;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Test B — cookie malformed missing __Secure-next-auth.session-token", async () => {
  // 1. Validation fails with specific missing session token error
  const result = await validateChatGptWebCodexProvider({
    apiKey: MALFORMED_COOKIE,
    providerSpecificData: {
      connectorName: "OmniRoute Test Connector",
    },
  });

  assert.equal(result.valid, false);
  assert.match(result.error ?? "", /missing __Secure-next-auth\.session-token/i);

  // 2. Finalization directly throws error
  assert.throws(
    () =>
      finalizeValidatedChatGptWebCodexSecrets(
        JSON.stringify({ version: 1, cookie: MALFORMED_COOKIE })
      ),
    /missing __Secure-next-auth\.session-token/i
  );
});

test("Test C — browser runtime detection via CDP or Chrome", () => {
  const customErr = new ChatGptWebCodexRuntimeError();
  assert.equal(customErr.statusCode, 503);
  assert.equal(customErr.code, "CHATGPT_WEB_CODEX_BROWSER_UNAVAILABLE");

  assert.equal(detectChromeExecutable("disabled"), undefined);
  assert.equal(cookieHeaderValue("Cookie: " + VALID_COOKIE), VALID_COOKIE);
  assert.ok(parseCookies(VALID_COOKIE).length > 0);

  const prevDefault = process.env.CHATGPT_WEB_CODEX_DEFAULT_CHROME_PATHS;
  const prevCdp = process.env.CHATGPT_WEB_CODEX_CDP_URL;
  try {
    process.env.CHATGPT_WEB_CODEX_DEFAULT_CHROME_PATHS = "0";
    delete process.env.CHATGPT_WEB_CODEX_CDP_URL;

    // Offline when paths disabled
    const offline = resolveChatGptWebCodexBrowserRuntime({
      chromeExecutablePath: "disabled",
    });
    assert.equal(offline.available, false);
    assert.equal(offline.mode, "unavailable");
    assert.equal(offline.reason, "browser_unavailable");

    // Internal CDP
    const cdp = resolveChatGptWebCodexBrowserRuntime({
      browserCdpEndpoint: "http://chatgpt-web-codex-browser:9223",
    });
    assert.equal(cdp.available, true);
    assert.equal(cdp.mode, "internal-cdp");
    assert.equal(cdp.cdpEndpoint, "http://chatgpt-web-codex-browser:9223");
  } finally {
    if (prevDefault !== undefined)
      process.env.CHATGPT_WEB_CODEX_DEFAULT_CHROME_PATHS = prevDefault;
    else delete process.env.CHATGPT_WEB_CODEX_DEFAULT_CHROME_PATHS;
    if (prevCdp !== undefined) process.env.CHATGPT_WEB_CODEX_CDP_URL = prevCdp;
    else delete process.env.CHATGPT_WEB_CODEX_CDP_URL;
  }
});

test("Test D — failure classification maps browser unavailability to runtime_error not auth_error", () => {
  const diagnosis = classifyFailure({
    error: "ChatGPT Web (Codex) browser runtime is unavailable",
    provider: "chatgpt-web-codex",
  });

  assert.equal(diagnosis.type, "runtime_error");
  assert.equal(diagnosis.source, "local");
  assert.equal(diagnosis.code, "browser_unavailable");

  const chromeMissingDiagnosis = classifyFailure({
    error: "No supported Chrome or Chromium executable was found",
    provider: "chatgpt-web-codex",
  });

  assert.equal(chromeMissingDiagnosis.type, "runtime_error");
  assert.equal(chromeMissingDiagnosis.source, "local");
});

test("Test E — executor returns 503 chatgpt_web_codex_browser_unavailable when runtime is missing", async () => {
  const executor = new ChatGptWebCodexExecutor();
  const prevCdp = process.env.CHATGPT_WEB_CODEX_CDP_URL;
  const prevChrome = process.env.CHATGPT_WEB_CODEX_CHROME_PATH;
  const prevPath = process.env.CHROME_PATH;
  const prevDefault = process.env.CHATGPT_WEB_CODEX_DEFAULT_CHROME_PATHS;

  try {
    delete process.env.CHATGPT_WEB_CODEX_CDP_URL;
    process.env.CHATGPT_WEB_CODEX_DEFAULT_CHROME_PATHS = "0";
    process.env.CHATGPT_WEB_CODEX_CHROME_PATH = "disabled";
    delete process.env.CHROME_PATH;

    const encoded = encodeChatGptWebCodexSecrets({
      cookie: VALID_COOKIE,
    });

    const result = await executor.execute({
      model: "chatgpt-web-codex/high",
      clientResponseFormat: "openai-responses",
      credentials: {
        connectionId: "test-conn-e",
        apiKey: encoded,
        providerSpecificData: {
          chromeExecutablePath: "disabled",
        },
      },
      clientHeaders: {
        originator: "codex_cli_rs",
      },
      body: {
        model: "gpt-5.6-sol",
        _nativeCodexPassthrough: true,
        client_metadata: {
          "x-codex-turn-metadata": JSON.stringify({
            thread_id: "thread-test-e",
            turn_id: "turn-test-e",
          }),
        },
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
        ],
      },
    });

    assert.equal(result.response.status, 503);
    const json = (await result.response.json()) as { error?: { code?: string; message?: string } };
    assert.equal(json.error?.code, "chatgpt_web_codex_browser_unavailable");
    assert.match(json.error?.message ?? "", /browser runtime is unavailable/i);
  } finally {
    if (prevCdp !== undefined) process.env.CHATGPT_WEB_CODEX_CDP_URL = prevCdp;
    else delete process.env.CHATGPT_WEB_CODEX_CDP_URL;
    if (prevChrome !== undefined) process.env.CHATGPT_WEB_CODEX_CHROME_PATH = prevChrome;
    else delete process.env.CHATGPT_WEB_CODEX_CHROME_PATH;
    if (prevPath !== undefined) process.env.CHROME_PATH = prevPath;
    else delete process.env.CHROME_PATH;
    if (prevDefault !== undefined)
      process.env.CHATGPT_WEB_CODEX_DEFAULT_CHROME_PATHS = prevDefault;
    else delete process.env.CHATGPT_WEB_CODEX_DEFAULT_CHROME_PATHS;
  }
});

test("Test F — UI validation badge maps pending to warning Pending Verification", () => {
  const pendingBadge = validationBadgeProps("pending");
  assert.equal(pendingBadge.variant, "warning");
  assert.equal(pendingBadge.fallback, "Pending Verification");

  const successBadge = validationBadgeProps("success");
  assert.equal(successBadge.variant, "success");
  assert.equal(successBadge.fallback, "Valid");

  const failedBadge = validationBadgeProps("failed");
  assert.equal(failedBadge.variant, "error");
  assert.equal(failedBadge.fallback, "Invalid");
});
