import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { processRtkText } from "../../../open-sse/services/compression/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.join(__dirname, "fixtures", "rtk");
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

  it("associates an upstream-shaped DIFF block with the following failure", () => {
    const raw = `TIME START 2026-09-04 12:00:00
========DIFF========
001- expected output
001+ actual output
========DONE========
FAIL Bug #123 reproduces [tests/bug-123.phpt]
Number of tests :    1
Tests failed    :    1
`;
    const result = processRtkText(raw, { command: "php run-tests.php" });
    assert.ok(result.text.includes("FAIL Bug #123 reproduces [tests/bug-123.phpt]"));
    assert.ok(result.text.includes("001- expected output"));
    assert.ok(result.text.includes("001+ actual output"));
  });
  it("parses upstream-formatted PHP_VERSION, PHP_SAPI, PHP_OS and detects truncated per-test failures", () => {
    const raw = `=====================================================================
TIME START 2026-09-04 12:00:00
PHP_VERSION : 8.4.20
PHP_SAPI    : cli
PHP_OS      : Linux
=====================================================================
PASS Pass case [tests/pass.phpt]
=====================================================================
Number of tests :    4                 4
Tests passed    :    1 ( 25.0%)       ( 25.0%)
Tests failed    :    3 ( 75.0%)       ( 75.0%)
Time taken      :    0.200 seconds
=====================================================================
`;
    const result = processRtkText(raw, { command: "php run-tests.php" });
    assert.ok(result.text.includes("PHP 8.4.20 SAPI cli OS Linux"));
    assert.ok(
      result.text.includes("FAILURES (3): per-test details unavailable — output truncated")
    );
    assert.ok(result.text.includes("Tests failed    :    3"));
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
========DIFF========
${diff}
========DONE========
FAIL Actual failure [tests/fail.phpt]
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

  describe("Disk fixture group samples", () => {
    it("compresses ctest/sample.txt correctly", () => {
      const raw = fs.readFileSync(path.join(fixturesRoot, "ctest", "sample.txt"), "utf8");
      const result = processRtkText(raw, { command: "ctest" });
      assert.ok(result.text.includes("Test #2: test_algo ...***Failed"));
      assert.ok(result.text.includes("The following tests FAILED:"));
      assert.ok(!result.text.includes("test_math ....................   Passed"));
    });

    it("compresses maven/sample.txt correctly", () => {
      const raw = fs.readFileSync(path.join(fixturesRoot, "maven", "sample.txt"), "utf8");
      const result = processRtkText(raw, { command: "mvn test" });
      assert.ok(result.text.includes("cannot find symbol"));
      assert.ok(result.text.includes("symbol:   class MissingType"));
      assert.ok(result.text.includes("BUILD FAILURE"));
      assert.ok(!result.text.includes("Downloading from central:"));
    });

    it("compresses phpt/sample.txt correctly", () => {
      const raw = fs.readFileSync(path.join(fixturesRoot, "phpt", "sample.txt"), "utf8");
      const result = processRtkText(raw, { command: "php run-tests.php" });
      assert.ok(result.text.includes("FAIL Test string format [tests/002.phpt]"));
      assert.ok(result.text.includes("001+ string format output"));
      assert.ok(result.text.includes("Tests failed    :    1"));
      assert.ok(!result.text.includes("PASS Test math"));
    });

    it("compresses git-diff/sample.txt correctly", () => {
      const raw = fs.readFileSync(path.join(fixturesRoot, "git-diff", "sample.txt"), "utf8");
      const result = processRtkText(raw, { command: "git diff" });
      assert.ok(result.text.includes("diff --git"));
      assert.ok(result.text.includes("+new line"));
      assert.ok(result.text.includes("-old line"));
    });

    it("compresses typescript/sample.txt correctly", () => {
      const raw = fs.readFileSync(path.join(fixturesRoot, "typescript", "sample.txt"), "utf8");
      const result = processRtkText(raw, { command: "tsc" });
      assert.ok(result.text.includes("error TS2322"));
      assert.ok(result.text.includes("const value: number"));
      assert.ok(result.text.includes("~~~~~"));
    });

    it("compresses shell-grep/sample.txt correctly", () => {
      const raw = fs.readFileSync(path.join(fixturesRoot, "shell-grep", "sample.txt"), "utf8");
      const result = processRtkText(raw, { command: "grep run src/app.ts" });
      assert.ok(result.text.includes("src/app.ts:10:export function run()"));
      assert.ok(result.text.includes("src/index.ts:5:run();"));
    });

    it("compresses shell-ls/sample.txt correctly", () => {
      const raw = fs.readFileSync(path.join(fixturesRoot, "shell-ls", "sample.txt"), "utf8");
      const result = processRtkText(raw, { command: "ls -la" });
      assert.ok(result.text.includes("src"));
      assert.ok(result.text.includes("package.json"));
      assert.ok(result.text.includes("README.md"));
    });

    it("compresses ctest/timeout.txt correctly", () => {
      const raw = fs.readFileSync(path.join(fixturesRoot, "ctest", "timeout.txt"), "utf8");
      const result = processRtkText(raw, { command: "ctest" });
      assert.ok(result.text.includes("Test #2: test_slow ...***Timeout"));
      assert.ok(result.text.includes("2 - test_slow (Timeout)"));
    });

    it("compresses maven/surefire-fail.txt correctly", () => {
      const raw = fs.readFileSync(path.join(fixturesRoot, "maven", "surefire-fail.txt"), "utf8");
      const result = processRtkText(raw, { command: "mvn test" });
      assert.ok(result.text.includes("AssertionError"));
      assert.ok(result.text.includes("BUILD FAILURE"));
    });

    it("compresses maven/multi-module.txt correctly", () => {
      const raw = fs.readFileSync(path.join(fixturesRoot, "maven", "multi-module.txt"), "utf8");
      const result = processRtkText(raw, { command: "mvn package" });
      assert.ok(result.text.includes("Reactor Summary"));
      assert.ok(result.text.includes("BUILD FAILURE"));
    });

    it("compresses phpt/bork.txt correctly", () => {
      const raw = fs.readFileSync(path.join(fixturesRoot, "phpt", "bork.txt"), "utf8");
      const result = processRtkText(raw, { command: "php run-tests.php" });
      assert.ok(result.text.includes("BORK Invalid section test"));
      assert.ok(result.text.includes("Tests borked    :    1"));
    });

    it("compresses phpt/leak.txt correctly", () => {
      const raw = fs.readFileSync(path.join(fixturesRoot, "phpt", "leak.txt"), "utf8");
      const result = processRtkText(raw, { command: "php run-tests.php" });
      assert.ok(result.text.includes("LEAK Memory leak test"));
      assert.ok(result.text.includes("Tests leaked    :    1"));
    });

    it("compresses git-diff/rename.txt correctly", () => {
      const raw = fs.readFileSync(path.join(fixturesRoot, "git-diff", "rename.txt"), "utf8");
      const result = processRtkText(raw, { command: "git diff" });
      assert.ok(result.text.includes("rename from source.ts"));
      assert.ok(result.text.includes("rename to target.ts"));
    });

    it("compresses git-diff/binary.txt correctly", () => {
      const raw = fs.readFileSync(path.join(fixturesRoot, "git-diff", "binary.txt"), "utf8");
      const result = processRtkText(raw, { command: "git diff" });
      assert.ok(result.text.includes("Binary files a/icon.png and b/icon.png differ"));
    });

    it("preserves word-diff as passthrough", () => {
      const raw = fs.readFileSync(path.join(fixturesRoot, "git-diff", "word-diff.txt"), "utf8");
      const result = processRtkText(raw, { command: "git diff --word-diff" });
      assert.equal(result.text, raw);
    });

    it("compresses typescript/pretty-multiline.txt correctly", () => {
      const raw = fs.readFileSync(
        path.join(fixturesRoot, "typescript", "pretty-multiline.txt"),
        "utf8"
      );
      const result = processRtkText(raw, { command: "tsc" });
      assert.ok(result.text.includes("error TS2345"));
      assert.ok(result.text.includes("verifyToken(token)"));
      assert.ok(result.text.includes("~~~~~"));
    });

    it("compresses typescript/global-error.txt correctly", () => {
      const raw = fs.readFileSync(
        path.join(fixturesRoot, "typescript", "global-error.txt"),
        "utf8"
      );
      const result = processRtkText(raw, { command: "tsc" });
      assert.ok(result.text.includes("error TS18003"));
      assert.ok(result.text.includes("Found 1 error."));
    });
  });
});
