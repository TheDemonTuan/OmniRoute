import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RtkBudgetWriter } from "../../../open-sse/services/compression/engines/rtk/processors/budget.ts";

describe("RtkBudgetWriter Priority and Hard Budget Guarantees", () => {
  it("preserves all lines without truncation marker when within budget", () => {
    const writer = new RtkBudgetWriter({ maxLines: 10, maxChars: 500 });
    writer.push("line 1");
    writer.pushImportant("line 2");
    writer.pushRequired("line 3");
    const output = writer.finish(["summary 1"]);
    assert.equal(output, "line 1\nline 2\nline 3\nsummary 1");
    assert.ok(!output.includes("truncated"));
  });

  it("evicts normal lines before important lines and never drops required summary lines", () => {
    const writer = new RtkBudgetWriter({ maxLines: 4 });
    writer.push("normal noise 1");
    writer.push("normal noise 2");
    writer.pushImportant("important failure detail");
    writer.pushRequired("REQUIRED: Test failed");
    const output = writer.finish(["REQUIRED: SUMMARY 100%"]);

    // Output must fit within maxLines (4 lines)
    const outLines = output.split("\n");
    assert.ok(outLines.length <= 4, `Expected <= 4 lines, got ${outLines.length}:\n${output}`);

    // Required lines MUST be preserved
    assert.ok(output.includes("REQUIRED: Test failed"));
    assert.ok(output.includes("REQUIRED: SUMMARY 100%"));

    // Normal lines must have been evicted
    assert.ok(!output.includes("normal noise 1"));
    assert.ok(!output.includes("normal noise 2"));

    // Truncation marker must be present
    assert.ok(output.includes("... output truncated by RTK processor budget"));
  });

  it("strictly enforces maxChars budget limit without accounting drift", () => {
    const writer = new RtkBudgetWriter({ maxLines: 20, maxChars: 120 });
    for (let i = 0; i < 15; i++) {
      writer.push(`normal line ${i} with some long text to fill up the budget`);
    }
    writer.pushRequired("REQUIRED: FINAL SUMMARY");

    const output = writer.finish();
    assert.ok(output.length <= 120, `Expected <= 120 chars, got ${output.length}`);
    assert.ok(output.includes("REQUIRED: FINAL SUMMARY"));
    assert.ok(output.includes("... output truncated by RTK processor budget"));
  });

  it("handles extremely constrained budget by prioritizing required lines", () => {
    const writer = new RtkBudgetWriter({ maxLines: 2, maxChars: 100 });
    writer.push("normal 1");
    writer.push("normal 2");
    writer.pushRequired("CRITICAL SUMMARY");
    const output = writer.finish();
    assert.ok(output.split("\n").length <= 2);
    assert.ok(output.includes("CRITICAL SUMMARY"));
  });
});
