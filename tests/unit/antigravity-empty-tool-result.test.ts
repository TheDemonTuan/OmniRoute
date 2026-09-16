import test from "node:test";
import assert from "node:assert/strict";
import { openaiToAntigravityRequest } from "../../open-sse/translator/request/openai-to-gemini.ts";

test("OpenAI -> Antigravity retains an empty tool result", () => {
  const result = openaiToAntigravityRequest(
    "gemini-3.8-flash-high",
    {
      messages: [
        { role: "user", content: "Look up the value" },
        {
          role: "assistant",
          tool_calls: [
            { type: "function", id: "empty-id", function: { name: "lookup", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "empty-id", content: "" },
        { role: "user", content: "Continue" },
      ],
    },
    true
  );
  const responses = result.request.contents
    .flatMap((turn) => turn.parts)
    .flatMap((part) => (part.functionResponse ? [part.functionResponse] : []));
  assert.equal(responses.length, 1);
  assert.deepEqual(responses[0].response, { result: "" });
});
