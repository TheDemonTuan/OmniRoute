import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dockerfile = readFileSync(new URL("../../../Dockerfile.bun", import.meta.url), "utf8");
const workflow = readFileSync(
  new URL("../../../.github/workflows/prod-deploy.yml", import.meta.url),
  "utf8"
);

test("Bun runner excludes every better-sqlite3 native addon", () => {
  assert.match(
    dockerfile,
    /find \/app[\s\S]*-path '\*\/node_modules\/better-sqlite3'[\s\S]*-prune[\s\S]*-exec rm -rf '\{\}' \+/
  );
  assert.match(
    dockerfile,
    /test -z "\$\(find \/app -type f -name 'better_sqlite3\.node' -print -quit\)"/
  );
});

test("production deploy smoke-starts the immutable image before touching the VPS", () => {
  assert.match(workflow, /name: 1\.9 Smoke final Bun image startup/);
  assert.match(workflow, /docker run --detach/);
  assert.match(workflow, /"\$\{IMAGE\}@\$\{DIGEST\}"/);
  assert.match(workflow, /docker inspect --format '\{\{\.State\.Running\}\}'/);
  assert.match(workflow, /curl --fail --silent --show-error/);
  assert.match(workflow, /\/healthz/);
});
