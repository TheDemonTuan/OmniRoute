import assert from "node:assert/strict";
import test from "node:test";

import {
  acquireChatGptWebCdpLease,
  chatGptWebCdpEndpoint,
  ChatGptWebRuntimeGuardError,
  requireChatGptWebDisplay,
} from "../../open-sse/utils/chatgptWebRuntimeGuard.ts";

const fakeCookie = {
  name: "__Secure-next-auth.session-token",
  value: "TEST_ONLY_NOT_A_CREDENTIAL",
  domain: ".chatgpt.com",
  path: "/",
  expires: -1,
  httpOnly: true,
  secure: true,
  sameSite: "Lax" as const,
};

const createStorageState = () => ({
  cookies: [{ ...fakeCookie }],
  origins: [],
});

function assertThrowsCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    return error instanceof ChatGptWebRuntimeGuardError && error.code === code;
  });
}

test("local headed Linux needs DISPLAY", () => {
  assertThrowsCode(
    () => requireChatGptWebDisplay(undefined, { platform: "linux", env: {} }),
    "CHATGPT_BROWSER_DISPLAY_MISSING"
  );
});

test("CDP bypasses local display requirement", () => {
  requireChatGptWebDisplay("http://browser:9223", { platform: "linux", env: {} });
});

test("local Xvfb DISPLAY accepted", () => {
  requireChatGptWebDisplay(undefined, { platform: "linux", env: { DISPLAY: ":99" } });
});

test("CDP resolver accepts the Codex compatibility alias", () => {
  assert.equal(
    chatGptWebCdpEndpoint({ CHATGPT_WEB_CODEX_CDP_URL: "http://browser:9223" }),
    "http://browser:9223"
  );
});

test("CDP resolver prefers the generic server-admin endpoint", () => {
  assert.equal(
    chatGptWebCdpEndpoint({
      CHATGPT_WEB_CDP_URL: "http://generic-browser:9223",
      CHATGPT_WEB_CODEX_CDP_URL: "http://legacy-browser:9223",
    }),
    "http://generic-browser:9223"
  );
});

test("invalid CDP endpoint fails without echoing credentials", () => {
  assert.throws(
    () => chatGptWebCdpEndpoint({ CHATGPT_WEB_CDP_URL: "http://secret:password@host" }),
    (error: unknown) => {
      const err = error as ChatGptWebRuntimeGuardError;
      return !err.message.includes("password") && err.code === "CHATGPT_CDP_CONFIG_INVALID";
    }
  );
});

function createMockDriver(failAt?: "connect" | "context" | "page") {
  const events: string[] = [];
  const page = { name: "fake-page" };
  const context = {
    async newPage() {
      events.push("newPage");
      if (failAt === "page") throw new Error("SECRET_STDERR");
      return page;
    },
    async close() {
      events.push("context.close");
    },
  };
  const browser = {
    async newContext(opts: { storageState?: unknown }) {
      events.push("newContext");
      assert.deepEqual(opts.storageState, createStorageState());
      if (failAt === "context") throw new Error("SECRET_STDERR");
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
      if (failAt === "connect") throw new Error("SECRET_STDERR");
      return browser;
    },
  };
}

const createLeaseOpts = (id: string, extra: Record<string, unknown> = {}) => ({
  connectionId: id,
  contextOptions: { storageState: createStorageState() },
  queueTimeoutMs: 0,
  ...extra,
});

test("CDP lease only creates owned context and disposes once", async () => {
  const driver = createMockDriver();
  const lease = await acquireChatGptWebCdpLease(
    driver as unknown as import("playwright").ChromiumBrowserContext,
    "http://browser:9223",
    createLeaseOpts("conn-a")
  );
  await Promise.all([lease.dispose(), lease.dispose()]);
  assert.deepEqual(driver.events, [
    "connect",
    "newContext",
    "newPage",
    "context.close",
    "browser.close",
  ]);
});

test("one active lease per connection; releases slot on completion", async () => {
  const driver = createMockDriver();
  const lease = await acquireChatGptWebCdpLease(
    driver as unknown as import("playwright").ChromiumBrowserContext,
    "http://browser:9223",
    createLeaseOpts("conn-a")
  );
  await assert.rejects(
    acquireChatGptWebCdpLease(
      createMockDriver() as unknown as import("playwright").ChromiumBrowserContext,
      "http://browser:9223",
      createLeaseOpts("conn-a")
    ),
    (error: unknown) => (error as ChatGptWebRuntimeGuardError).code === "CHATGPT_BROWSER_BUSY"
  );
  await lease.dispose();
  const nextLease = await acquireChatGptWebCdpLease(
    createMockDriver() as unknown as import("playwright").ChromiumBrowserContext,
    "http://browser:9223",
    createLeaseOpts("conn-a")
  );
  await nextLease.dispose();
});

test("global lease cap is two per process", async () => {
  const leaseA = await acquireChatGptWebCdpLease(
    createMockDriver() as unknown as import("playwright").ChromiumBrowserContext,
    "http://browser:9223",
    createLeaseOpts("conn-a")
  );
  const leaseB = await acquireChatGptWebCdpLease(
    createMockDriver() as unknown as import("playwright").ChromiumBrowserContext,
    "http://browser:9223",
    createLeaseOpts("conn-b")
  );
  await assert.rejects(
    acquireChatGptWebCdpLease(
      createMockDriver() as unknown as import("playwright").ChromiumBrowserContext,
      "http://browser:9223",
      createLeaseOpts("conn-c")
    ),
    (error: unknown) => (error as ChatGptWebRuntimeGuardError).code === "CHATGPT_BROWSER_BUSY"
  );
  await leaseA.dispose();
  await leaseB.dispose();
});

test("failed CDP creation releases resources and redacts errors", async () => {
  for (const phase of ["connect", "context", "page"] as const) {
    const driver = createMockDriver(phase);
    await assert.rejects(
      acquireChatGptWebCdpLease(
        driver as unknown as import("playwright").ChromiumBrowserContext,
        "http://browser:9223",
        createLeaseOpts("conn-a")
      ),
      (error: unknown) => !(error as Error).message.includes("SECRET_STDERR")
    );
    const nextLease = await acquireChatGptWebCdpLease(
      createMockDriver() as unknown as import("playwright").ChromiumBrowserContext,
      "http://browser:9223",
      createLeaseOpts("conn-a")
    );
    await nextLease.dispose();
    if (phase === "page") {
      assert.deepEqual(driver.events.slice(-2), ["context.close", "browser.close"]);
    }
  }
});

test("already cancelled work never connects", async () => {
  const controller = new AbortController();
  controller.abort();
  const driver = createMockDriver();
  await assert.rejects(
    acquireChatGptWebCdpLease(
      driver as unknown as import("playwright").ChromiumBrowserContext,
      "http://browser:9223",
      { ...createLeaseOpts("conn-a"), signal: controller.signal }
    ),
    (error: unknown) => (error as Error).name === "AbortError"
  );
  assert.equal(driver.events.length, 0);
});

test("same connection waits for in-flight disposal and acquires without CHATGPT_BROWSER_BUSY", async () => {
  const driver = createMockDriver();
  const lease1 = await acquireChatGptWebCdpLease(
    driver as unknown as import("playwright").ChromiumBrowserContext,
    "http://browser:9223",
    createLeaseOpts("conn-wait")
  );

  // Trigger disposal in background (simulating in-flight context.close during rapid follow-up turn)
  const disposePromise = lease1.dispose();

  // Second acquire for the same connection arrives while dispose is settling
  const lease2 = await acquireChatGptWebCdpLease(
    createMockDriver() as unknown as import("playwright").ChromiumBrowserContext,
    "http://browser:9223",
    createLeaseOpts("conn-wait")
  );
  await disposePromise;

  assert.ok(lease2);
  await lease2.dispose();
});

test("concurrent requests queue in FIFO order and acquire when slot frees", async () => {
  const driver = createMockDriver();
  const lease1 = await acquireChatGptWebCdpLease(
    driver as unknown as import("playwright").ChromiumBrowserContext,
    "http://browser:9223",
    createLeaseOpts("conn-fifo", { queueTimeoutMs: 5_000 })
  );

  let lease2Acquired = false;
  const lease2Promise = acquireChatGptWebCdpLease(
    createMockDriver() as unknown as import("playwright").ChromiumBrowserContext,
    "http://browser:9223",
    createLeaseOpts("conn-fifo", { queueTimeoutMs: 5_000 })
  ).then((l) => {
    lease2Acquired = true;
    return l;
  });

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(lease2Acquired, false, "lease2 must wait in queue while lease1 is active");

  await lease1.dispose();
  const lease2 = await lease2Promise;
  assert.equal(lease2Acquired, true, "lease2 acquired after lease1 disposes");
  await lease2.dispose();
});

test("global capacity wakes a different connection when either slot frees", async () => {
  const leaseA = await acquireChatGptWebCdpLease(
    createMockDriver() as unknown as import("playwright").ChromiumBrowserContext,
    "http://browser:9223",
    createLeaseOpts("conn-global-a", { queueTimeoutMs: 5_000 })
  );
  const leaseB = await acquireChatGptWebCdpLease(
    createMockDriver() as unknown as import("playwright").ChromiumBrowserContext,
    "http://browser:9223",
    createLeaseOpts("conn-global-b", { queueTimeoutMs: 5_000 })
  );

  const queuedLease = acquireChatGptWebCdpLease(
    createMockDriver() as unknown as import("playwright").ChromiumBrowserContext,
    "http://browser:9223",
    createLeaseOpts("conn-global-c", { queueTimeoutMs: 5_000 })
  );

  await leaseA.dispose();
  const leaseC = await queuedLease;
  await Promise.all([leaseB.dispose(), leaseC.dispose()]);
});

test("queued request aborts cleanly via AbortSignal without holding slot", async () => {
  const driver = createMockDriver();
  const lease1 = await acquireChatGptWebCdpLease(
    driver as unknown as import("playwright").ChromiumBrowserContext,
    "http://browser:9223",
    createLeaseOpts("conn-abort", { queueTimeoutMs: 5_000 })
  );

  const controller = new AbortController();
  const lease2Promise = acquireChatGptWebCdpLease(
    createMockDriver() as unknown as import("playwright").ChromiumBrowserContext,
    "http://browser:9223",
    createLeaseOpts("conn-abort", { signal: controller.signal, queueTimeoutMs: 5_000 })
  );

  await new Promise((r) => setTimeout(r, 20));
  controller.abort();

  await assert.rejects(lease2Promise, (err: unknown) => {
    return (err as Error).name === "AbortError";
  });

  await lease1.dispose();
});

test("queued request times out when queueTimeoutMs expires", async () => {
  const driver = createMockDriver();
  const lease1 = await acquireChatGptWebCdpLease(
    driver as unknown as import("playwright").ChromiumBrowserContext,
    "http://browser:9223",
    createLeaseOpts("conn-timeout", { queueTimeoutMs: 50 })
  );

  await assert.rejects(
    acquireChatGptWebCdpLease(
      createMockDriver() as unknown as import("playwright").ChromiumBrowserContext,
      "http://browser:9223",
      createLeaseOpts("conn-timeout", { queueTimeoutMs: 50 })
    ),
    (err: unknown) => (err as ChatGptWebRuntimeGuardError).code === "CHATGPT_BROWSER_BUSY"
  );

  await lease1.dispose();
});
