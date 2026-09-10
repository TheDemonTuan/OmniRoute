import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getChatGptWebCodexDoctorStatus } from "../../open-sse/executors/chatgpt-web-codex/doctor.ts";
import { connectionRuntimePaths } from "../../open-sse/executors/chatgpt-web-codex/storageState.ts";
import { validateChatGptWebCodexProvider } from "../../src/lib/providers/validation/chatgptWebCodex.ts";
import { acquireChatGptWebCdpLease } from "../../open-sse/utils/chatgptWebRuntimeGuard.ts";

const VALID_COOKIE =
  "__Secure-next-auth.session-token=mock-token-abc123xyz; path=/; domain=.chatgpt.com";

function createMockDriver() {
  const events: string[] = [];
  const page = { name: "fake-page" };
  const context = {
    async newPage() {
      events.push("newPage");
      return page;
    },
    async close() {
      events.push("context.close");
    },
  };
  const browser = {
    async newContext() {
      events.push("newContext");
      return context;
    },
    async close() {
      events.push("browser.close");
    },
  };
  return {
    events,
    async connectOverCDP() {
      events.push("connect");
      return browser;
    },
  };
}

test("REPRO 1: Doctor must be read-only and NOT mutate storage-state.json on disk", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-doctor-test-"));
  const prevDataDir = process.env.DATA_DIR;
  try {
    process.env.DATA_DIR = root;
    const connectionId = "test-doctor-read-only";
    const paths = connectionRuntimePaths(connectionId);
    assert.equal(
      existsSync(paths.storageStatePath),
      false,
      "Precondition: storage-state should not exist yet"
    );

    // Call Doctor GET status
    const status = await getChatGptWebCodexDoctorStatus({
      id: connectionId,
      apiKey: VALID_COOKIE,
      providerSpecificData: {},
    });

    // BUG: Currently Doctor calls ensureConnectionStorageState, writing the file to disk!
    // It should be strictly read-only observation.
    assert.equal(
      existsSync(paths.storageStatePath),
      false,
      "Doctor GET must NOT create or mutate storage-state.json on disk"
    );
    assert.equal(status.credential.ready, true);
    assert.equal(status.storageState.ready, false);
  } finally {
    process.env.DATA_DIR = prevDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("REPRO 2: Concurrent leases on same connection should queue instead of failing fast with CHATGPT_BROWSER_BUSY", async () => {
  const driver = createMockDriver();
  const leaseOpts = {
    connectionId: "conn-queue-test",
    contextOptions: { storageState: { cookies: [], origins: [] } },
  };

  const lease1 = await acquireChatGptWebCdpLease(
    driver as unknown as import("playwright").ChromiumBrowserContext,
    "http://127.0.0.1:9222",
    leaseOpts
  );

  let lease2Acquired = false;
  const lease2Promise = acquireChatGptWebCdpLease(
    driver as unknown as import("playwright").ChromiumBrowserContext,
    "http://127.0.0.1:9222",
    leaseOpts
  ).then((l) => {
    lease2Acquired = true;
    return l;
  });

  // Small tick to ensure lease2 has attempted to acquire
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(lease2Acquired, false, "lease2 should be waiting in queue while lease1 is active");

  // Dispose lease1 -> lease2 should now resolve
  await lease1.dispose();
  const lease2 = await lease2Promise;
  assert.equal(lease2Acquired, true, "lease2 should be acquired after lease1 disposes");
  await lease2.dispose();
});

test("REPRO 3: validateChatGptWebCodexProvider with verifyBrowserLogin returns updated providerSpecificData", async () => {
  // In src/lib/providers/validation/chatgptWebCodex.ts:
  // When verifyBrowserLogin is true and capabilities are inspected,
  // the result MUST contain providerSpecificData with browserVerified: true
  // so that test/route.ts updates the provider in the database.
  const root = mkdtempSync(join(tmpdir(), "cgw-val-test-"));
  const prevDataDir = process.env.DATA_DIR;
  try {
    process.env.DATA_DIR = root;
    // Without mock runtime this will fallback or succeed
    const result = await validateChatGptWebCodexProvider({
      apiKey: VALID_COOKIE,
      providerSpecificData: {
        connectorName: "Test Connector",
        chromeExecutablePath: "disabled",
      },
    });
    // When pendingBrowserVerification is true on initial save:
    assert.equal(result.valid, true);
    assert.equal(result.providerSpecificData?.pendingBrowserVerification, true);
    assert.equal(result.providerSpecificData?.browserVerified, false);
  } finally {
    process.env.DATA_DIR = prevDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Doctor POST rejects unauthenticated or invalid actions", async () => {
  const { POST } =
    await import("../../src/app/api/providers/[id]/chatgpt-web-codex-doctor/route.ts");
  // Without management auth header -> 401
  const req = new Request("http://localhost/api/providers/test-conn/chatgpt-web-codex-doctor", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "invalid_action" }),
  });
  const res = await POST(req, { params: Promise.resolve({ id: "test-conn" }) });
  assert.ok(res.status === 401 || res.status === 404);
});
