import { test } from "node:test";
import assert from "node:assert/strict";

import { FETCH_TIMEOUT_MS } from "../../open-sse/config/constants.ts";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.ts";

test("client abort cancels a pending Antigravity SSE read and releases the lock", async () => {
  const reading = Promise.withResolvers<void>();
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        reading.resolve();
      },
      cancel() {
        cancellations++;
      },
    },
    { highWaterMark: 0 }
  );
  const caller = new AbortController();
  const upstream = new Response(body);
  const result = new AntigravityExecutor().collectStreamToResponse(
    upstream,
    "antigravity-model",
    "https://example.invalid/sse",
    {},
    {},
    null,
    caller.signal
  );
  await reading.promise;
  caller.abort();
  assert.equal((await result).response.status, 499);
  assert.equal(cancellations, 1);
  assert.equal(body.locked, false);
});

test("an Antigravity SSE transport error after content does not return partial success", async () => {
  let first = true;
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        if (first) {
          first = false;
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"response":{"candidates":[{"content":{"parts":[{"text":"partial text"}]}}]}}\n\n'
            )
          );
        } else {
          controller.error(new Error("unexpected EOF"));
        }
      },
    })
  );
  const result = await new AntigravityExecutor().collectStreamToResponse(
    response,
    "antigravity-model",
    "https://example.invalid/sse",
    {},
    {}
  );
  assert.equal(result.response.status, 502);
  assert.doesNotMatch(await result.response.text(), /partial text/);
  assert.equal(response.body?.locked, false);
});

test("Antigravity collection deadline cancels a stalled upstream body", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let cancelled = false;
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  const result = new AntigravityExecutor().collectStreamToResponse(
    new Response(body),
    "antigravity-model",
    "https://example.invalid/sse",
    {},
    {}
  );
  t.mock.timers.tick(FETCH_TIMEOUT_MS);
  assert.equal((await result).response.status, 504);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});
