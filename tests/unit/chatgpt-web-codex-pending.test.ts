import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";
import { ChatGptWebCodexExecutor } from "../../open-sse/executors/chatgpt-web-codex.ts";
import { encodeChatGptWebCodexSecrets } from "../../open-sse/executors/chatgpt-web-codex/credentials.ts";
import { ChatGptBrowserWorker } from "../../open-sse/vendor/codex-chatgpt-web/adapters/chatgpt-web/browser-worker.ts";
import { AsyncEventQueue } from "../../open-sse/vendor/codex-chatgpt-web/event-queue.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";

test.after(() => resetDbInstance());

test("new Codex connection verifies Luna before dispatch and reuses marker with pending metadata", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "codex-pending-"));
  const previousHome = process.env.CODEX_CHATGPT_WEB_HOME;
  const previousCdp = process.env.CHATGPT_WEB_CDP_URL;
  process.env.CODEX_CHATGPT_WEB_HOME = home;
  process.env.CHATGPT_WEB_CDP_URL = "http://browser:9223";
  let probes = 0;
  let sends = 0;
  const locator = {
    first() {
      return this;
    },
    last() {
      return this;
    },
    nth() {
      return this;
    },
    filter() {
      return this;
    },
    async waitFor() {},
    async count() {
      return 1;
    },
    async isVisible() {
      return true;
    },
    locator(selector: string): unknown {
      return selector.startsWith("xpath")
        ? this
        : { last: () => ({ isVisible: async () => false }) };
    },
  };
  const page = {
    url: () => "https://chatgpt.com/?temporary-chat=true",
    async goto() {},
    async evaluate() {
      return true;
    },
    locator: (selector: string) =>
      selector.includes('role="dialog"') ? { filter: () => ({ count: async () => 0 }) } : locator,
  };
  t.mock.method(chromium, "connectOverCDP", async () => {
    probes++;
    return {
      newContext: async () => ({ newPage: async () => page, close: async () => {} }),
      close: async () => {},
    };
  });
  t.mock.method(ChatGptBrowserWorker.prototype, "run", async (turn) => {
    sends++;
    turn.onTextDelta?.("Luna verified");
    return "Luna verified";
  });
  const emittedErrors: unknown[] = [];
  const push = AsyncEventQueue.prototype.push;
  t.mock.method(AsyncEventQueue.prototype, "push", function (event: { type: string }) {
    if (event.type === "error") emittedErrors.push(event);
    return push.call(this, event);
  });
  const updates: Record<string, unknown>[] = [];
  const executor = new ChatGptWebCodexExecutor();
  try {
    for (const turnId of ["first", "second"]) {
      const result = await executor.execute({
        model: "luna",
        stream: false,
        clientResponseFormat: "openai-responses",
        credentials: {
          connectionId: "pending-luna",
          apiKey: encodeChatGptWebCodexSecrets({
            cookie: "__Secure-next-auth.session-token=TEST_ONLY",
          }),
          providerSpecificData: { pendingBrowserVerification: true, browserVerified: false },
        },
        onCredentialsRefreshed: async (value) => {
          updates.push(value);
        },
        clientHeaders: { originator: "codex_cli_rs" },
        body: {
          model: "gpt-5.6-luna",
          _nativeCodexPassthrough: true,
          client_metadata: {
            "x-codex-turn-metadata": JSON.stringify({
              thread_id: "pending-thread",
              turn_id: turnId,
            }),
          },
          input: [
            {
              id: `msg-${turnId}`,
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "hello" }],
            },
          ],
        },
      });
      const body = await result.response.json();
      assert.equal(result.response.status, 200, JSON.stringify(body));
      assert.equal(body.status, "completed", JSON.stringify({ body, emittedErrors }));
    }
    assert.equal(probes, 1);
    assert.equal(sends, 2);
    assert.ok(
      updates.some((update) => {
        const data = update.providerSpecificData as Record<string, unknown> | undefined;
        return (
          data?.solAvailable === false &&
          data?.proAvailable === false &&
          data?.browserVerified === true &&
          data?.pendingBrowserVerification === false
        );
      })
    );
  } finally {
    t.mock.restoreAll();
    if (previousHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
    else process.env.CODEX_CHATGPT_WEB_HOME = previousHome;
    if (previousCdp === undefined) delete process.env.CHATGPT_WEB_CDP_URL;
    else process.env.CHATGPT_WEB_CDP_URL = previousCdp;
    rmSync(home, { recursive: true, force: true });
  }
});
