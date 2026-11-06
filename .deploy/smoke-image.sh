#!/usr/bin/env bash
set -euo pipefail
[[ $# == 1 && "$1" =~ ^ghcr\.io/thedemontuan/omniroute-vps@sha256:[0-9a-f]{64}$ ]] || { echo 'Expected immutable OmniRoute image digest' >&2; exit 2; }
docker pull "$1"
cid=$(docker run -d \
  -e DEPLOY_SLOT=blue \
  -e INITIAL_PASSWORD="$(openssl rand -hex 24)" \
  -e JWT_SECRET="$(openssl rand -hex 48)" \
  -e API_KEY_SECRET="$(openssl rand -hex 32)" \
  -e REQUIRE_API_KEY=true \
  -e NEXT_PUBLIC_BASE_URL=https://admin.smoke.invalid \
  -e OMNIROUTE_PUBLIC_BASE_URL=https://api.smoke.invalid \
  "$1")
trap 'docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT
healthy=false
for ((attempt=0; attempt<60; attempt++)); do
  if docker exec "$cid" wget -qO- http://127.0.0.1:20128/api/health >/dev/null 2>&1; then
    healthy=true
    break
  fi
  sleep 1
done
[[ $healthy == true ]] || { echo 'Published image did not become healthy within 60s' >&2; exit 1; }
docker exec "$cid" node --input-type=module -e '
import assert from "node:assert/strict";
import { hostname } from "node:os";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const db = new Database(":memory:");
assert.equal(db.prepare("SELECT 123 AS value").get().value, 123);
db.close();
assert.equal(typeof require("wreq-js").createTransport, "function");
assert.equal(typeof require("onnxruntime-node").InferenceSession.create, "function");
const base = "http://127.0.0.1:20128";
const response = await fetch(base + "/api/health");
assert.equal(response.status, 200);
assert.match(response.headers.get("cache-control"), /no-store/);
const health = await response.json();
assert.equal(health.ok, true);
assert.equal(health.status, "ok");
assert.equal(health.deployment_slot, "blue");
assert.ok(health.instance_id.startsWith(hostname() + "-"));
assert.equal(health.active_requests_known, true);
assert.equal(health.active_requests, 0);
const ready = await fetch(base + "/api/health/ping");
assert.equal(ready.status, 200, "database readiness must succeed on fresh storage");
const login = await fetch(base + "/login");
assert.equal(login.status, 200, "native login must render with separate runtime API/admin origins");
assert.match(login.headers.get("content-type"), /text\/html/);
const unauthorized = await fetch(base + "/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "smoke/no-provider", messages: [{ role: "user", content: "smoke" }] }),
});
assert.equal(unauthorized.status, 401, "anonymous inference must be rejected before calling a provider");
const settings = await fetch(base + "/api/settings", { redirect: "manual" });
assert.ok([401, 403].includes(settings.status), "management settings must require authentication");
'
[[ "$(docker exec "$cid" id -u)" == 1000 ]] || { echo 'Image must run non-root' >&2; exit 1; }
echo 'Immutable image smoke passed: slot identity, idle drain, native UI, SQLite readiness, auth and non-root runtime.'
