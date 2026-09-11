import assert from "node:assert/strict";
import test from "node:test";

import {
  acquireChatGptWebCdpLease,
  acquireQueuedChatGptWebRuntimeAdmission,
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

const createLeaseOpts = (id: string) => ({
  connectionId: id,
  contextOptions: { storageState: createStorageState() },
});

test("runtime admission blocks overlapping owner types on the same connection", async () => {
  const { acquireChatGptWebRuntimeAdmission } =
    await import("../../open-sse/utils/chatgptWebRuntimeGuard.ts");
  const cleanRoom = acquireChatGptWebRuntimeAdmission("shared-connection", "clean-room");

  assert.throws(
    () => acquireChatGptWebRuntimeAdmission("shared-connection", "codex"),
    (error: unknown) =>
      error instanceof ChatGptWebRuntimeGuardError && error.code === "CHATGPT_BROWSER_BUSY"
  );

  cleanRoom.release();
  const codex = acquireChatGptWebRuntimeAdmission("shared-connection", "codex");
  codex.release();
});

test("runtime admission and a direct CDP lease share the global browser capacity", async () => {
  const { acquireChatGptWebRuntimeAdmission } =
    await import("../../open-sse/utils/chatgptWebRuntimeGuard.ts");
  const previous = process.env.CHATGPT_WEB_MAX_BROWSER_TABS;
  process.env.CHATGPT_WEB_MAX_BROWSER_TABS = "1";
  const admission = acquireChatGptWebRuntimeAdmission("capacity-admission", "codex");
  try {
    await assert.rejects(
      acquireChatGptWebCdpLease(
        createMockDriver() as unknown as import("playwright").ChromiumBrowserContext,
        "http://browser:9223",
        createLeaseOpts("capacity-other-connection")
      ),
      (error: unknown) =>
        error instanceof ChatGptWebRuntimeGuardError && error.code === "CHATGPT_BROWSER_BUSY"
    );
  } finally {
    admission.release();
    if (previous === undefined) delete process.env.CHATGPT_WEB_MAX_BROWSER_TABS;
    else process.env.CHATGPT_WEB_MAX_BROWSER_TABS = previous;
  }
});

test("runtime admission applies the global browser capacity across owner types", async () => {
  const { acquireChatGptWebRuntimeAdmission } =
    await import("../../open-sse/utils/chatgptWebRuntimeGuard.ts");
  const previous = process.env.CHATGPT_WEB_MAX_BROWSER_TABS;
  process.env.CHATGPT_WEB_MAX_BROWSER_TABS = "2";
  const first = acquireChatGptWebRuntimeAdmission("capacity-clean-room", "clean-room");
  const second = acquireChatGptWebRuntimeAdmission("capacity-codex", "codex");
  try {
    assert.throws(
      () => acquireChatGptWebRuntimeAdmission("capacity-verification", "verification"),
      (error: unknown) =>
        error instanceof ChatGptWebRuntimeGuardError && error.code === "CHATGPT_BROWSER_BUSY"
    );
  } finally {
    first.release();
    second.release();
    if (previous === undefined) delete process.env.CHATGPT_WEB_MAX_BROWSER_TABS;
    else process.env.CHATGPT_WEB_MAX_BROWSER_TABS = previous;
  }
});

test("queued admissions are FIFO and release capacity without dropping waiters", async () => {
  const previous = process.env.CHATGPT_WEB_MAX_BROWSER_TABS;
  process.env.CHATGPT_WEB_MAX_BROWSER_TABS = "1";
  const first = await acquireQueuedChatGptWebRuntimeAdmission("queue-first", "clean-room");
  const order: string[] = [];
  const second = acquireQueuedChatGptWebRuntimeAdmission("queue-second", "codex").then(
    (admission) => {
      order.push("second");
      return admission;
    }
  );
  const third = acquireQueuedChatGptWebRuntimeAdmission("queue-third", "verification").then(
    (admission) => {
      order.push("third");
      return admission;
    }
  );
  try {
    first.release();
    const secondAdmission = await second;
    assert.deepEqual(order, ["second"]);
    secondAdmission.release();
    const thirdAdmission = await third;
    assert.deepEqual(order, ["second", "third"]);
    thirdAdmission.release();
  } finally {
    if (previous === undefined) delete process.env.CHATGPT_WEB_MAX_BROWSER_TABS;
    else process.env.CHATGPT_WEB_MAX_BROWSER_TABS = previous;
  }
});

test("queued admission abort removes its waiter and preserves capacity", async () => {
  const previous = process.env.CHATGPT_WEB_MAX_BROWSER_TABS;
  process.env.CHATGPT_WEB_MAX_BROWSER_TABS = "1";
  const first = await acquireQueuedChatGptWebRuntimeAdmission("abort-active", "clean-room");
  const controller = new AbortController();
  const aborted = acquireQueuedChatGptWebRuntimeAdmission("abort-waiter", "codex", {
    signal: controller.signal,
  });
  const next = acquireQueuedChatGptWebRuntimeAdmission("abort-next", "verification");
  try {
    controller.abort();
    await assert.rejects(aborted, (error: unknown) => (error as Error).name === "AbortError");
    first.release();
    const nextAdmission = await next;
    nextAdmission.release();
  } finally {
    if (previous === undefined) delete process.env.CHATGPT_WEB_MAX_BROWSER_TABS;
    else process.env.CHATGPT_WEB_MAX_BROWSER_TABS = previous;
  }
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

test("queue head-of-line: capacity=2 with active A and B; when A2 and C queue and B releases, C must run while A2 waits for A", async () => {
  const previous = process.env.CHATGPT_WEB_MAX_BROWSER_TABS;
  process.env.CHATGPT_WEB_MAX_BROWSER_TABS = "2";
  try {
    const admissionA = await acquireQueuedChatGptWebRuntimeAdmission("conn-a", "clean-room");
    const admissionB = await acquireQueuedChatGptWebRuntimeAdmission("conn-b", "codex");

    let a2Started = false;
    const a2Promise = acquireQueuedChatGptWebRuntimeAdmission("conn-a", "clean-room", {
      timeoutMs: 1000,
    }).then((adm) => {
      a2Started = true;
      return adm;
    });

    let cStarted = false;
    const cPromise = acquireQueuedChatGptWebRuntimeAdmission("conn-c", "verification", {
      timeoutMs: 1000,
    }).then((adm) => {
      cStarted = true;
      return adm;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(a2Started, false, "A2 should not run yet because connection A is active");
    assert.equal(cStarted, false, "C should not run yet because capacity (2) is saturated");

    // B releases: C must run! (A2 must remain waiting because connection A is still active)
    admissionB.release();

    const admissionC = await cPromise;
    assert.equal(cStarted, true, "C must run when B releases capacity");
    assert.equal(a2Started, false, "A2 must still wait because connection A is still active");

    // When A releases, A2 must run
    admissionA.release();
    const admissionA2 = await a2Promise;
    assert.equal(a2Started, true, "A2 must run after connection A releases");

    admissionC.release();
    admissionA2.release();
  } finally {
    if (previous === undefined) delete process.env.CHATGPT_WEB_MAX_BROWSER_TABS;
    else process.env.CHATGPT_WEB_MAX_BROWSER_TABS = previous;
  }
});

test("same-connection FIFO: multiple waiters for same connection are served in FIFO order", async () => {
  const previous = process.env.CHATGPT_WEB_MAX_BROWSER_TABS;
  process.env.CHATGPT_WEB_MAX_BROWSER_TABS = "2";
  try {
    const admA = await acquireQueuedChatGptWebRuntimeAdmission("conn-a", "clean-room");
    const admB = await acquireQueuedChatGptWebRuntimeAdmission("conn-b", "codex");

    const order: string[] = [];
    const pA2 = acquireQueuedChatGptWebRuntimeAdmission("conn-a", "clean-room").then((adm) => {
      order.push("A2");
      return adm;
    });
    const pC = acquireQueuedChatGptWebRuntimeAdmission("conn-c", "verification").then((adm) => {
      order.push("C");
      return adm;
    });
    const pA3 = acquireQueuedChatGptWebRuntimeAdmission("conn-a", "clean-room").then((adm) => {
      order.push("A3");
      return adm;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    // Release B: C should run (HOL bypass for C). A2 and A3 must wait for connection A.
    admB.release();
    const admC = await pC;
    assert.deepEqual(order, ["C"]);

    // Release A: A2 must run next, not A3!
    admA.release();
    const admA2 = await pA2;
    assert.deepEqual(order, ["C", "A2"]);

    // Release A2: now A3 can run!
    admA2.release();
    const admA3 = await pA3;
    assert.deepEqual(order, ["C", "A2", "A3"]);

    admC.release();
    admA3.release();
  } finally {
    if (previous === undefined) delete process.env.CHATGPT_WEB_MAX_BROWSER_TABS;
    else process.env.CHATGPT_WEB_MAX_BROWSER_TABS = previous;
  }
});

test("abort draining: aborted waiter at queue head triggers drain for next eligible waiter", async () => {
  const previous = process.env.CHATGPT_WEB_MAX_BROWSER_TABS;
  process.env.CHATGPT_WEB_MAX_BROWSER_TABS = "2";
  try {
    const admA = await acquireQueuedChatGptWebRuntimeAdmission("conn-a", "clean-room");
    const admB = await acquireQueuedChatGptWebRuntimeAdmission("conn-b", "codex");

    const abortController = new AbortController();
    const pA2 = acquireQueuedChatGptWebRuntimeAdmission("conn-a", "clean-room", {
      signal: abortController.signal,
    });
    const pC = acquireQueuedChatGptWebRuntimeAdmission("conn-c", "verification");

    await new Promise((resolve) => setTimeout(resolve, 20));

    // Abort A2: C must still be scheduled when B releases
    abortController.abort();
    await assert.rejects(pA2, (err: unknown) => (err as Error).name === "AbortError");

    admB.release();
    const admC = await pC;
    assert.ok(admC);

    admA.release();
    admC.release();
  } finally {
    if (previous === undefined) delete process.env.CHATGPT_WEB_MAX_BROWSER_TABS;
    else process.env.CHATGPT_WEB_MAX_BROWSER_TABS = previous;
  }
});

test("timeout draining: timed-out waiter in queue triggers drain for next eligible waiter", async () => {
  const previous = process.env.CHATGPT_WEB_MAX_BROWSER_TABS;
  process.env.CHATGPT_WEB_MAX_BROWSER_TABS = "2";
  try {
    const admA = await acquireQueuedChatGptWebRuntimeAdmission("conn-a", "clean-room");
    const admB = await acquireQueuedChatGptWebRuntimeAdmission("conn-b", "codex");

    const pA2 = acquireQueuedChatGptWebRuntimeAdmission("conn-a", "clean-room", {
      timeoutMs: 30,
    });
    const pC = acquireQueuedChatGptWebRuntimeAdmission("conn-c", "verification", {
      timeoutMs: 5000,
    });

    await assert.rejects(
      pA2,
      (err: unknown) => (err as ChatGptWebRuntimeGuardError).code === "CHATGPT_BROWSER_BUSY"
    );

    admB.release();
    const admC = await pC;
    assert.ok(admC);

    admA.release();
    admC.release();
  } finally {
    if (previous === undefined) delete process.env.CHATGPT_WEB_MAX_BROWSER_TABS;
    else process.env.CHATGPT_WEB_MAX_BROWSER_TABS = previous;
  }
});

test("queue fairness: new incoming request does not bypass eligible queued waiter", async () => {
  const previous = process.env.CHATGPT_WEB_MAX_BROWSER_TABS;
  process.env.CHATGPT_WEB_MAX_BROWSER_TABS = "1";
  try {
    const admA = await acquireQueuedChatGptWebRuntimeAdmission("conn-a", "clean-room");

    const order: string[] = [];
    const pB = acquireQueuedChatGptWebRuntimeAdmission("conn-b", "codex").then((adm) => {
      order.push("B");
      return adm;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    // When A releases, B is queued and eligible.
    // If request D arrives, it should not jump ahead of B.
    const pD = acquireQueuedChatGptWebRuntimeAdmission("conn-d", "verification").then((adm) => {
      order.push("D");
      return adm;
    });

    admA.release();

    const admB = await pB;
    assert.deepEqual(order, ["B"]);

    admB.release();
    const admD = await pD;
    assert.deepEqual(order, ["B", "D"]);

    admD.release();
  } finally {
    if (previous === undefined) delete process.env.CHATGPT_WEB_MAX_BROWSER_TABS;
    else process.env.CHATGPT_WEB_MAX_BROWSER_TABS = previous;
  }
});

test("multi-slot drain: multiple eligible waiters in queue drain up to available capacity", async () => {
  const previous = process.env.CHATGPT_WEB_MAX_BROWSER_TABS;
  process.env.CHATGPT_WEB_MAX_BROWSER_TABS = "2";
  try {
    const admA = await acquireQueuedChatGptWebRuntimeAdmission("conn-a", "clean-room");
    const admB = await acquireQueuedChatGptWebRuntimeAdmission("conn-b", "codex");

    const order: string[] = [];
    const pC = acquireQueuedChatGptWebRuntimeAdmission("conn-c", "clean-room").then((adm) => {
      order.push("C");
      return adm;
    });
    const pD = acquireQueuedChatGptWebRuntimeAdmission("conn-d", "verification").then((adm) => {
      order.push("D");
      return adm;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    // Release both A and B: both C and D should be admitted concurrently
    admA.release();
    admB.release();

    const [admC, admD] = await Promise.all([pC, pD]);
    assert.ok(admC);
    assert.ok(admD);
    assert.equal(order.length, 2);

    admC.release();
    admD.release();
  } finally {
    if (previous === undefined) delete process.env.CHATGPT_WEB_MAX_BROWSER_TABS;
    else process.env.CHATGPT_WEB_MAX_BROWSER_TABS = previous;
  }
});
