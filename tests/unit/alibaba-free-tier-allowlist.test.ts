/**
 * @file alibaba-free-tier-allowlist.test.ts
 * @description Tests for built-in Alibaba free-tier text model allowlists.
 *
 * @changes
 * - [2026-07-25] [Composer] - Add built-in allowlist regression tests
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ALIBABA_FREE_TIER_TEXT_CAPABLE_MODELS,
  ALIBABA_NO_FREE_TIER_TEXT_MODELS,
  isAlibabaBuiltinFreeTierTextModel,
  isAlibabaBuiltinNoFreeTierTextModel,
  isAlibabaFreeTierAllowlistPackValid,
  loadAlibabaFreeTierAllowlistPack,
  resetAlibabaFreeTierAllowlistCache,
} from "../../open-sse/services/alibabaFreeTierAllowlist.ts";

test("built-in allowlist includes operator free models and excludes paid blocklist", () => {
  assert.ok(ALIBABA_FREE_TIER_TEXT_CAPABLE_MODELS.includes("qwen3.6-plus"));
  assert.ok(ALIBABA_FREE_TIER_TEXT_CAPABLE_MODELS.includes("glm-5.2"));
  assert.ok(ALIBABA_NO_FREE_TIER_TEXT_MODELS.includes("qwen3.7-max"));
  assert.ok(ALIBABA_NO_FREE_TIER_TEXT_MODELS.includes("glm-5.2-fast-preview"));
  assert.equal(isAlibabaBuiltinFreeTierTextModel("qwen3.6-plus"), true);
  assert.equal(isAlibabaBuiltinNoFreeTierTextModel("kimi-k2.7-code"), true);
  assert.equal(isAlibabaBuiltinFreeTierTextModel("qwen3.7-max"), false);
});

test("allowlist JSON pack overrides embedded lists when valid", () => {
  const previousPath = process.env.ALIBABA_FREE_TIER_ALLOWLIST_PATH;
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-alibaba-allowlist-"));
  const packPath = path.join(fixtureDir, "allowlist.json");

  try {
    fs.writeFileSync(
      packPath,
      JSON.stringify({
        asOf: "2026-08-27",
        capable: ["qwen3.6-plus"],
        noFreeTier: ["qwen3.7-max"],
      })
    );
    process.env.ALIBABA_FREE_TIER_ALLOWLIST_PATH = packPath;
    resetAlibabaFreeTierAllowlistCache();

    const pack = loadAlibabaFreeTierAllowlistPack();
    assert.ok(pack);
    assert.ok(isAlibabaFreeTierAllowlistPackValid(pack));
    assert.ok(pack.capable.includes("qwen3.6-plus"));
  } finally {
    if (previousPath) process.env.ALIBABA_FREE_TIER_ALLOWLIST_PATH = previousPath;
    else delete process.env.ALIBABA_FREE_TIER_ALLOWLIST_PATH;
    resetAlibabaFreeTierAllowlistCache();
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});
