import test from "node:test";
import assert from "node:assert/strict";

import {
  ANTIGRAVITY_PUBLIC_MODELS,
  ANTIGRAVITY_MODEL_ALIASES,
  resolveAntigravityModelId,
  isDiscoverableAntigravityModelId,
  isUserCallableAntigravityModelId,
} from "../../open-sse/config/antigravityModelAliases.ts";

import {
  AGY_PUBLIC_MODELS,
  isDiscoverableAgyModelId,
  isUserCallableAgyModelId,
} from "../../open-sse/config/agyModels.ts";

import { MODEL_SPECS } from "../../src/shared/constants/modelSpecs.ts";

test("Gemini 3.8 Flash tiers exist in ANTIGRAVITY_PUBLIC_MODELS", () => {
  const ids = ANTIGRAVITY_PUBLIC_MODELS.map((m) => m.id);
  assert.ok(ids.includes("gemini-3.8-flash-high"), "must include gemini-3.8-flash-high");
  assert.ok(ids.includes("gemini-3.8-flash-medium"), "must include gemini-3.8-flash-medium");
  assert.ok(ids.includes("gemini-3.8-flash-low"), "must include gemini-3.8-flash-low");
});

test("Gemini 3.8 Flash tiers exist in AGY_PUBLIC_MODELS", () => {
  const ids = AGY_PUBLIC_MODELS.map((m) => m.id);
  assert.ok(ids.includes("gemini-3.8-flash-high"), "must include gemini-3.8-flash-high");
  assert.ok(ids.includes("gemini-3.8-flash-medium"), "must include gemini-3.8-flash-medium");
  assert.ok(ids.includes("gemini-3.8-flash-low"), "must include gemini-3.8-flash-low");
});

test("Gemini 3.8 Flash tier resolution keeps per-effort upstream ids verbatim (no -tiered mapping)", () => {
  // 3.8 tiers MUST NOT be mapped to gemini-3.8-flash-tiered or gemini-3.7-flash-tiered
  assert.equal(resolveAntigravityModelId("gemini-3.8-flash-high"), "gemini-3.8-flash-high");
  assert.equal(resolveAntigravityModelId("gemini-3.8-flash-medium"), "gemini-3.8-flash-medium");
  assert.equal(resolveAntigravityModelId("gemini-3.8-flash-low"), "gemini-3.8-flash-low");

  // Bare gemini-3.8-flash defaults to medium
  assert.equal(resolveAntigravityModelId("gemini-3.8-flash"), "gemini-3.8-flash-medium");
  assert.equal(ANTIGRAVITY_MODEL_ALIASES["gemini-3.8-flash"], "gemini-3.8-flash-medium");
});

test("Gemini 3.8 Flash discoverability and static callability", () => {
  for (const tier of ["gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low"]) {
    assert.equal(isDiscoverableAntigravityModelId(tier), true, `antigravity discoverable: ${tier}`);
    assert.equal(isUserCallableAntigravityModelId(tier), true, `antigravity callable: ${tier}`);
    assert.equal(isDiscoverableAgyModelId(tier), true, `agy discoverable: ${tier}`);
    assert.equal(isUserCallableAgyModelId(tier), true, `agy callable: ${tier}`);
  }
});

test("MODEL_SPECS declares Gemini 3.8 Flash with full context and without thinking budget", () => {
  for (const tier of [
    "gemini-3.8-flash-high",
    "gemini-3.8-flash-medium",
    "gemini-3.8-flash-low",
    "gemini-3.8-flash",
  ]) {
    const spec = MODEL_SPECS[tier];
    assert.ok(spec, `spec for ${tier} must exist`);
    assert.equal(spec.maxOutputTokens, 65536);
    assert.equal(spec.contextWindow, 1048576);
    assert.equal(spec.supportsThinking, true);
    assert.equal(spec.supportsTools, true);
    assert.equal(spec.supportsVision, true);
    // Crucial: 3.8 uses thinkingLevel, NOT token thinkingBudget like 3.7
    assert.equal(spec.defaultThinkingBudget, undefined, "must not declare defaultThinkingBudget");
    assert.equal(spec.thinkingBudgetCap, undefined, "must not declare thinkingBudgetCap");
  }
});
