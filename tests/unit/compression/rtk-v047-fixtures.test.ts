import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { processRtkText } from "../../../open-sse/services/compression/index.ts";

describe("RTK v0.47 Stateful Fixture Semantics", () => {
  it("bounds CTest failure detail while preserving trailer summary", () => {
    const diagnostic = Array.from({ length: 30 }, (_, i) => `detail-${i}`).join("\n");
    const raw = `Test project /build
 1/1 Test #1: worker ....................***Failed    0.10 sec
${diagnostic}
0% tests passed, 1 tests failed out of 1
The following tests FAILED:
  1 - worker (Failed)
`;
    const result = processRtkText(raw, { command: "ctest" });
    assert.ok(result.text.includes("Test #1: worker ...***Failed"));
    assert.ok(result.text.includes("detail-0"));
    assert.ok(result.text.includes("... [failure diagnostics truncated]"));
    assert.ok(result.text.includes("The following tests FAILED:"));
  });

  it("preserves Maven compiler symbol and location continuations with bounded stack trace", () => {
    const frames = Array.from(
      { length: 20 },
      (_, i) => `    at package.Class${i}.run(Class${i}.java:1)`
    ).join("\n");
    const raw = `[INFO] Scanning for projects...
[INFO] Building example 1.0.0
[ERROR] /src/App.java:[10,5] cannot find symbol
symbol:   class MissingType
location: class App
${frames}
[INFO] BUILD FAILURE
`;
    const result = processRtkText(raw, { command: "mvn compile" });
    assert.ok(result.text.includes("cannot find symbol"));
    assert.ok(result.text.includes("symbol:   class MissingType"));
    assert.ok(result.text.includes("location: class App"));
    assert.ok(result.text.includes("... [stack trace truncated]"));
    assert.ok(result.text.includes("BUILD FAILURE"));
  });

  it("preserves PHPT status counts, environment, time, and capped DIFF details", () => {
    const diff = Array.from({ length: 8 }, (_, i) => `diff-${i}`).join("\n");
    const raw = `=====================================================================
TIME START 2026-09-04 12:00:00
PHP 8.4.0
SAPI cli
OS Linux
=====================================================================
PASS Pass case [tests/pass.phpt]
XFAIL Expected failure [tests/xfail.phpt]
WARN Warning case [tests/warn.phpt]
FAIL Actual failure [tests/fail.phpt]
========DIFF========
${diff}
========DONE========
=====================================================================
Number of tests :    4                 4
Tests passed    :    1
Tests failed    :    1
Expected fail   :    1
Tests warned    :    1
Time taken      :    0.123 seconds
=====================================================================
`;
    const result = processRtkText(raw, { command: "php run-tests.php" });
    assert.ok(result.text.includes("PHP 8.4.0"));
    assert.ok(result.text.includes("SAPI cli"));
    assert.ok(result.text.includes("OS Linux"));
    assert.ok(result.text.includes("FAIL Actual failure [tests/fail.phpt]"));
    assert.ok(result.text.includes("diff-0"));
    assert.ok(result.text.includes("... +2 more diff lines"));
    assert.ok(result.text.includes("Expected fail   :    1"));
    assert.ok(result.text.includes("Time taken      :    0.123 seconds"));
    assert.ok(!result.text.includes("PASS Pass case"));
  });

  it("preserves TypeScript global diagnostics and code context", () => {
    const raw = `error TS2688: Cannot find type definition file for 'node'.

src/app.ts:4:7 - error TS2322: Type 'string' is not assignable to type 'number'.

4 const amount: number = "bad";
        ~~~~~~

Found 2 errors.
`;
    const result = processRtkText(raw, { command: "tsc" });
    assert.ok(result.text.includes("error TS2688"));
    assert.ok(result.text.includes("error TS2322"));
    assert.ok(result.text.includes("const amount: number"));
    assert.ok(result.text.includes("~~~~~~"));
    assert.ok(result.text.includes("Found 2 errors."));
  });
});
