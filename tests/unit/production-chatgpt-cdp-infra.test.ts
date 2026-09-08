import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../..", import.meta.url));
const compose = readFileSync(`${root}/infra/compose.yml`, "utf8");
const deploy = readFileSync(`${root}/infra/deploy.sh`, "utf8");
const productionWorkflow = readFileSync(`${root}/.github/workflows/prod-deploy.yml`, "utf8");

const INTERNAL_CDP_ENDPOINT = "http://chatgpt-web-codex-browser:9223";

test("production app slots use the managed ChatGPT browser sidecar", () => {
  assert.match(compose, new RegExp(`CHATGPT_WEB_CDP_URL: ["']${INTERNAL_CDP_ENDPOINT}["']`));
  assert.match(compose, new RegExp(`CHATGPT_WEB_CODEX_CDP_URL: ["']${INTERNAL_CDP_ENDPOINT}["']`));
  assert.match(compose, /chatgpt-web-codex-browser:\s*\n\s+image: \$\{CHATGPT_BROWSER_IMAGE:\?/);
  assert.match(compose, /chatgpt_browser_data:\/browser-profile/);
  assert.match(compose, /\nvolumes:\s*\n\s+chatgpt_browser_data:/);

  const browserService = compose.match(
    /\n  chatgpt-web-codex-browser:\n([\s\S]*?)(?=\n  [a-z][a-z0-9-]+:\n)/
  )?.[1];
  assert.ok(browserService, "managed browser service must be declared");
  assert.doesNotMatch(browserService, /\n\s+ports:/);
  assert.match(browserService, /\n\s+expose:\s*\n\s+- ["']9223["']/);
  assert.match(browserService, /\n\s+networks:\s*\n\s+- backend/);
  assert.match(browserService, /\n\s+cap_drop:\s*\n\s+- ALL/);
  assert.match(browserService, /\n\s+security_opt:\s*\n\s+- no-new-privileges:true/);
  assert.match(browserService, /\n\s+healthcheck:/);
});

test("production workflow builds and deploys an immutable browser image", () => {
  assert.match(productionWorkflow, /file: docker\/chatgpt-web-codex-browser\/Dockerfile/);
  assert.match(productionWorkflow, /id: browser-build/);
  assert.match(
    productionWorkflow,
    /browser_digest: \$\{\{ steps\.browser-build\.outputs\.digest \}\}/
  );
  assert.match(productionWorkflow, /name: 1\.9 Smoke ChatGPT browser image/);
  assert.match(
    productionWorkflow,
    /BROWSER_IMAGE_REF: \$\{\{ needs\.build\.outputs\.browser_image \}\}@\$\{\{ needs\.build\.outputs\.browser_digest \}\}/
  );
  assert.match(
    productionWorkflow,
    /\/opt\/omniroute\/deploy\.sh '\$IMAGE_REF' '\$BROWSER_IMAGE_REF'/
  );
});

test("blue-green deployment gates traffic on CDP health and an isolated context smoke", () => {
  const browserStart = deploy.indexOf("dc up -d --no-deps chatgpt-web-codex-browser");
  const targetStart = deploy.indexOf('dc up -d --no-deps "$TARGET_SERVICE"');

  assert.ok(browserStart >= 0, "deploy must explicitly start the browser despite --no-deps");
  assert.ok(targetStart >= 0, "target app start anchor must remain present");
  assert.ok(browserStart < targetStart, "browser must be ready before the target app starts");
  assert.match(deploy, /wait_container_healthy chatgpt-web-codex-browser 120/);
  assert.match(deploy, /CHATGPT_BROWSER_IMAGE=%s/);
  assert.match(deploy, /NEW_BROWSER_IMAGE="\$\{2:-\}"/);
  assert.match(deploy, /probe_chatgpt_runtime\(\)/);
  assert.match(deploy, /OMNI_CHATGPT_SMOKE=1/);
  assert.match(deploy, /browser\.newContext\(\{ storageState: undefined \}\)/);
  assert.match(
    deploy,
    /wait_app_ready "\$TARGET_SERVICE" 60 \\\n\s+\|\| ! probe_chatgpt_runtime "\$TARGET_SERVICE"; then/
  );
});
