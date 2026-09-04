import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  maybePersistRtkRawOutput,
  readRtkRawOutput,
  redactRtkRawOutput,
  isLikelyFailureOutput,
} from "../../../open-sse/services/compression/engines/rtk/rawOutput.ts";

describe("RTK Raw Output v0.47.0 Extensions", () => {
  it("redacts credentials from tool outputs correctly", () => {
    const raw =
      "Authorization: Bearer sk-ant-api03-12345678901234567890\nBuild failed with token ghp_ABCDEF1234567890abcdef1234567890";
    const redacted = redactRtkRawOutput(raw);
    assert.equal(redacted.redacted, true);
    assert.ok(!redacted.text.includes("sk-ant-api03-12345678901234567890"));
    assert.ok(!redacted.text.includes("ghp_ABCDEF1234567890abcdef1234567890"));
    assert.ok(redacted.text.includes("[REDACTED"));
  });

  it("identifies CTest, Maven, and PHPT failure outputs as likely failures", () => {
    assert.ok(isLikelyFailureOutput("2/3 Test #2: test_string ...***Failed 0.05 sec"));
    assert.ok(isLikelyFailureOutput("2/3 Test #2: test_string ...***Timeout 10.00 sec"));
    assert.ok(isLikelyFailureOutput("[INFO] BUILD FAILURE"));
    assert.ok(isLikelyFailureOutput("FAIL Test string format [tests/002.phpt]"));
    assert.ok(isLikelyFailureOutput("BORK Test syntax [tests/003.phpt]"));
    assert.ok(!isLikelyFailureOutput("[INFO] BUILD SUCCESS"));
  });

  it("persists and reads raw output for new command families under configured retention", () => {
    const ctestRaw = "Test project /build\n 2/3 Test #2: test_string ...***Failed 0.05 sec";
    const pointer = maybePersistRtkRawOutput(ctestRaw, {
      command: "ctest",
      retention: "failures",
    });

    assert.ok(pointer !== null);
    assert.ok(pointer.id.length > 0);

    const readBack = readRtkRawOutput(pointer.id);
    assert.equal(readBack, ctestRaw);
  });
});
