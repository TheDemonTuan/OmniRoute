import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dockerfile = readFileSync(new URL("../../Dockerfile.bun", import.meta.url), "utf8");
const runnerWeb = dockerfile.match(/FROM runner-base AS runner-web([\s\S]*)$/);

test("Dockerfile.bun runner-web uses Debian trixie Chromium packages", () => {
  assert.ok(runnerWeb, "expected runner-web stage");
  assert.match(runnerWeb[1], /\bchromium\b/);
  assert.match(runnerWeb[1], /\blibstdc\+\+6\b/);
  assert.doesNotMatch(runnerWeb[1], /\bgconf-service\b/);
  assert.doesNotMatch(runnerWeb[1], /\bfonts-kacst\b/);
});
