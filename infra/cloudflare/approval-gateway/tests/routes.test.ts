import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyRequestPath,
  extractClientCredential,
  maskApiKey,
} from "../src/routes.ts";

test("routes: classifyRequestPath correctly identifies route categories", () => {
  // Public
  assert.equal(classifyRequestPath("/api/health"), "PUBLIC");
  assert.equal(classifyRequestPath("/api/monitoring/health"), "PUBLIC");
  assert.equal(classifyRequestPath("/api/auth/login"), "PUBLIC");
  assert.equal(classifyRequestPath("/_next/static/chunks/main.js"), "PUBLIC");
  assert.equal(classifyRequestPath("/favicon.ico"), "PUBLIC");

  // Telegram webhook
  assert.equal(classifyRequestPath("/tg-ops/secret123"), "TELEGRAM_WEBHOOK");
  assert.equal(classifyRequestPath("/tg-ops"), "TELEGRAM_WEBHOOK");

  // Edge control
  assert.equal(classifyRequestPath("/__edge-control/decision"), "EDGE_CONTROL");

  // Dashboard
  assert.equal(classifyRequestPath("/dashboard"), "DASHBOARD");
  assert.equal(classifyRequestPath("/dashboard/settings"), "DASHBOARD");

  // Client API
  assert.equal(classifyRequestPath("/v1/chat/completions"), "CLIENT_API");
  assert.equal(classifyRequestPath("/v1/responses"), "CLIENT_API");
  assert.equal(classifyRequestPath("/api/v1/models"), "CLIENT_API");
  assert.equal(classifyRequestPath("/api/v1/vscode/sk-test/models"), "CLIENT_API");
  assert.equal(classifyRequestPath("/api/cursor-cli/aiserver.v1.BidiService/BidiAppend"), "CLIENT_API");
});

test("routes: extractClientCredential extracts from all supported transports", () => {
  // Bearer
  const req1 = new Request("http://localhost/v1/responses", {
    headers: { Authorization: "Bearer sk-v2-123456-abcdef" },
  });
  assert.deepEqual(extractClientCredential(req1), {
    apiKey: "sk-v2-123456-abcdef",
    transport: "bearer",
  });

  // x-api-key
  const req2 = new Request("http://localhost/v1/messages", {
    headers: { "x-api-key": "sk-v2-789012-ghijkl" },
  });
  assert.deepEqual(extractClientCredential(req2), {
    apiKey: "sk-v2-789012-ghijkl",
    transport: "x-api-key",
  });

  // x-goog-api-key
  const req3 = new Request("http://localhost/v1beta/models", {
    headers: { "x-goog-api-key": "sk-v2-345678-mnopqr" },
  });
  assert.deepEqual(extractClientCredential(req3), {
    apiKey: "sk-v2-345678-mnopqr",
    transport: "x-goog-api-key",
  });

  // VS Code tokenized path
  const req4 = new Request("http://localhost/api/v1/vscode/sk-v2-901234-stuvwx/models");
  assert.deepEqual(extractClientCredential(req4), {
    apiKey: "sk-v2-901234-stuvwx",
    transport: "path-token",
  });
});

test("routes: maskApiKey masks key while keeping prefixes readable", () => {
  assert.equal(maskApiKey("sk-v2-abcdef-12345678901234567890123456789012"), "sk-v2-abcd****9012");
  assert.equal(maskApiKey(""), "sk-unknown");
});
