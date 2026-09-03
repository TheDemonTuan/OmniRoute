import test from "node:test";
import assert from "node:assert/strict";

import { openaiToGeminiRequest } from "../../open-sse/translator/request/openai-to-gemini.ts";
import { claudeToGeminiRequest } from "../../open-sse/translator/request/claude-to-gemini.ts";
import {
  getGeminiThinkingLevel,
  applyAntigravityGenerationDefaults,
} from "../../open-sse/translator/request/openai-to-gemini/helpers.ts";

type TranslatedRequest = {
  generationConfig: {
    thinkingConfig?: {
      thinkingLevel?: string;
      thinkingBudget?: number;
      includeThoughts?: boolean;
    };
  };
};

test("getGeminiThinkingLevel maps 3.8 tiers and reasoning efforts correctly", () => {
  assert.equal(getGeminiThinkingLevel("gemini-3.8-flash-high"), "HIGH");
  assert.equal(getGeminiThinkingLevel("gemini-3.8-flash-medium"), "MEDIUM");
  assert.equal(getGeminiThinkingLevel("gemini-3.8-flash-low"), "LOW");
  assert.equal(getGeminiThinkingLevel("gemini-3.8-flash"), "MEDIUM");
  assert.equal(getGeminiThinkingLevel("gemini-3.8-flash", "high"), "HIGH");
  assert.equal(getGeminiThinkingLevel("gemini-3.8-flash", "low"), "LOW");
  assert.equal(getGeminiThinkingLevel("gemini-3.7-flash-high"), null);
});

test("openaiToGemini translates Gemini 3.8 to thinkingLevel and strips sampling defaults", () => {
  const tiers = [
    { model: "gemini-3.8-flash-high", expectedLevel: "HIGH" },
    { model: "gemini-3.8-flash-medium", expectedLevel: "MEDIUM" },
    { model: "gemini-3.8-flash-low", expectedLevel: "LOW" },
    { model: "gemini-3.8-flash", expectedLevel: "MEDIUM" },
  ];

  for (const { model, expectedLevel } of tiers) {
    const body = {
      model,
      messages: [{ role: "user", content: "Hello" }],
    };

    const result = openaiToGeminiRequest(model, body, false) as TranslatedRequest;
    const config = result.generationConfig;

    assert.ok(config.thinkingConfig, `thinkingConfig must be defined for ${model}`);
    assert.equal(config.thinkingConfig.thinkingLevel, expectedLevel);
    assert.equal(config.thinkingConfig.includeThoughts, true);
    assert.equal(config.thinkingConfig.thinkingBudget, undefined, "must NOT inject thinkingBudget");
  }
});

test("openaiToGemini respects explicit reasoning_effort for Gemini 3.8", () => {
  const body = {
    model: "gemini-3.8-flash",
    messages: [{ role: "user", content: "Hello" }],
    reasoning_effort: "low",
  };

  const result = openaiToGeminiRequest("gemini-3.8-flash", body, false) as TranslatedRequest;
  const config = result.generationConfig;
  assert.equal(config.thinkingConfig.thinkingLevel, "LOW");
  assert.equal(config.thinkingConfig.includeThoughts, true);
  assert.equal(config.thinkingConfig.thinkingBudget, undefined);
});

test("claudeToGeminiRequest translates Gemini 3.8 with thinkingLevel", () => {
  const body = {
    model: "gemini-3.8-flash-high",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Hello" }],
    output_config: { effort: "high" },
  };

  const result = claudeToGeminiRequest("gemini-3.8-flash-high", body, false) as TranslatedRequest;
  const config = result.generationConfig;
  assert.ok(config.thinkingConfig);
  assert.equal(config.thinkingConfig.thinkingLevel, "HIGH");
  assert.equal(config.thinkingConfig.includeThoughts, true);
  assert.equal(config.thinkingConfig.thinkingBudget, undefined);
});

test("applyAntigravityGenerationDefaults strips topK, topP, temperature for Gemini 3.8", () => {
  const inputConfig = {
    temperature: 0.7,
    topK: 40,
    topP: 0.9,
    maxOutputTokens: 2048,
    thinkingConfig: {
      thinkingLevel: "HIGH" as const,
      includeThoughts: true,
    },
  };

  const outputConfig = applyAntigravityGenerationDefaults(inputConfig, "gemini-3.8-flash-high");
  assert.equal(outputConfig.topK, undefined, "topK must be removed for 3.8");
  assert.equal(outputConfig.topP, undefined, "topP must be removed for 3.8");
  assert.equal(outputConfig.temperature, undefined, "temperature must be removed for 3.8");
  assert.equal(outputConfig.maxOutputTokens, 2048);

  // 3.7 should retain defaults
  const output37 = applyAntigravityGenerationDefaults(
    { maxOutputTokens: 2048 },
    "gemini-3.7-flash-high"
  );
  assert.equal(output37.topK, 40);
  assert.equal(output37.topP, 1);
});
