import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  processRtkText,
  matchRtkFilter,
  verifyRtkFixture,
  applyRenderer,
} from "../../../open-sse/services/compression/index.ts";

describe("RTK Upstream v0.47.0 Regressions & Hardening", () => {
  describe("UTF-8 BOM and malformed input handling", () => {
    it("handles BOM prefix gracefully in processRtkText", () => {
      const bomPrefixed =
        "\uFEFFTest project /build\n 1/2 Test #1: math ...   Passed    0.01 sec\n 2/2 Test #2: io ...***Failed    0.02 sec\n50% tests passed";
      const result = processRtkText(bomPrefixed, { command: "ctest" });
      assert.ok(!result.text.startsWith("\uFEFF"));
      assert.ok(result.text.includes("***Failed"));
    });

    it("handles non-string or malformed inputs without throwing", () => {
      // @ts-expect-error testing runtime resilience
      const resNull = processRtkText(null);
      assert.equal(resNull.text, "");

      // @ts-expect-error testing runtime resilience
      const resNum = processRtkText(12345);
      assert.equal(resNum.text, "12345");
    });
  });

  describe("Git Diff renderer hardening", () => {
    it("handles diffs with quoted file paths and spaces", () => {
      const diffWithSpaces = `diff --git "a/path with spaces/file 1.ts" "b/path with spaces/file 1.ts"
index 1234567..89abcdef 100644
--- "a/path with spaces/file 1.ts"
+++ "b/path with spaces/file 1.ts"
@@ -1,3 +1,3 @@
 context line
-old line
+new line
`;
      const rendered = applyRenderer(
        diffWithSpaces,
        {
          type: "git-diff",
          command: "git diff",
          confidence: 1,
          category: "git",
          matchedPatterns: [],
        },
        { enableRenderers: true }
      );

      assert.ok(rendered.changed);
      assert.ok(
        rendered.text.includes(
          'diff --git "a/path with spaces/file 1.ts" "b/path with spaces/file 1.ts"'
        )
      );
      assert.ok(rendered.text.includes("-old line"));
      assert.ok(rendered.text.includes("+new line"));
      assert.ok(!rendered.text.includes("--- a/"));
    });

    it("does not mangle word-diffs or combined merge diffs", () => {
      const wordDiff = "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n[-deleted-] {+added+}\n";
      const rendered = applyRenderer(
        wordDiff,
        {
          type: "git-diff",
          command: "git diff --word-diff",
          confidence: 1,
          category: "git",
          matchedPatterns: [],
        },
        { enableRenderers: true }
      );
      assert.equal(rendered.changed, false);
      assert.equal(rendered.text, wordDiff);
    });

    it("preserves + and - change lines cleanly without dropping valid additions/deletions", () => {
      const diff = `diff --git a/src/calc.ts b/src/calc.ts
@@ -10,3 +10,3 @@
-const x = --counter;
+const x = ++counter;
`;
      const rendered = applyRenderer(
        diff,
        {
          type: "git-diff",
          command: "git diff",
          confidence: 1,
          category: "git",
          matchedPatterns: [],
        },
        { enableRenderers: true }
      );
      assert.ok(rendered.changed);
      assert.ok(rendered.text.includes("-const x = --counter;"));
      assert.ok(rendered.text.includes("+const x = ++counter;"));
    });
  });

  describe("Command detection negative match fixtures", () => {
    it("does not falsely detect command from Spring Boot / server logs mentioning command words", () => {
      const serverLog =
        "2026-09-04 12:00:00.123 [INFO] [main] org.example.Server - Connected via ssh to remote host\n2026-09-04 12:00:01.000 [INFO] [main] org.example.Server - Started application";
      const outcome = verifyRtkFixture({
        name: "server log negative match",
        input: serverLog,
        negativeMatchExpected: true,
      });
      assert.equal(
        outcome.passed,
        true,
        `Expected no filter match for server log, got ${outcome.actual}`
      );
    });

    it("does not falsely treat JSON mentioning command names as command output", () => {
      const jsonDoc = '{\n  "service": "git",\n  "description": "git repository service"\n}';
      const outcome = verifyRtkFixture({
        name: "json document negative match",
        input: jsonDoc,
        expectedFilterId: "json-output",
      });
      assert.equal(outcome.passed, true);
    });
  });

  describe("New v0.47.0 Filters (CTest, Maven, PHPT)", () => {
    it("matches and compresses CTest failure outputs", () => {
      const ctestInput = `Test project /workspace/build
      Start  1: test_math
 1/3 Test #1: test_math ....................   Passed    0.01 sec
      Start  2: test_algo
 2/3 Test #2: test_algo ....................***Failed    0.15 sec
      Start  3: test_perf
 3/3 Test #3: test_perf ....................   Passed    0.05 sec

67% tests passed, 1 tests failed out of 3

The following tests FAILED:
\t  2 - test_algo (Failed)
`;
      const filter = matchRtkFilter(ctestInput, "ctest");
      assert.equal(filter?.id, "test-ctest");

      const result = processRtkText(ctestInput, { command: "ctest" });
      assert.ok(result.text.includes("test_algo"));
      assert.ok(result.text.includes("***Failed"));
      assert.ok(result.text.includes("The following tests FAILED:"));
      assert.ok(!result.text.includes("test_math ....................   Passed"));
    });

    it("matches and compresses Maven build failure outputs", () => {
      const mvnInput = `[INFO] Scanning for projects...
[INFO] Building sample-app 1.0.0
[INFO] --- maven-resources-plugin:3.2.0:resources (default-resources) ---
[INFO] Downloading from central: https://repo.maven.apache.org/maven2/pkg.jar
[INFO] Downloaded from central: https://repo.maven.apache.org/maven2/pkg.jar (5 kB at 500 kB/s)
[INFO] --- maven-compiler-plugin:3.8.1:compile (default-compile) ---
[ERROR] /workspace/src/Main.java:[12,8] cannot find symbol
[INFO] BUILD FAILURE
[INFO] Total time: 2.100 s
`;
      const filter = matchRtkFilter(mvnInput, "mvn test");
      assert.equal(filter?.id, "maven");

      const result = processRtkText(mvnInput, { command: "mvn test" });
      assert.ok(result.text.includes("Scanning for projects..."));
      assert.ok(result.text.includes("Building sample-app 1.0.0"));
      assert.ok(result.text.includes("[ERROR] /workspace/src/Main.java:[12,8] cannot find symbol"));
      assert.ok(result.text.includes("BUILD FAILURE"));
      assert.ok(!result.text.includes("Downloading from central:"));
      assert.ok(!result.text.includes("Downloaded from central:"));
    });

    it("matches and compresses PHPT test failure outputs", () => {
      const phptInput = `=====================================================================
TIME START 2026-09-04 12:00:00
=====================================================================
PASS Array map test [tests/001.phpt]
FAIL String uppercase test [tests/002.phpt]
PASS JSON decode test [tests/003.phpt]
=====================================================================
Number of tests :    3                 3
Tests passed    :    2 ( 66.7%)       ( 66.7%)
Tests failed    :    1 ( 33.3%)       ( 33.3%)
=====================================================================
`;
      const filter = matchRtkFilter(phptInput, "php run-tests.php");
      assert.equal(filter?.id, "test-phpt");

      const result = processRtkText(phptInput, { command: "php run-tests.php" });
      assert.ok(result.text.includes("FAIL String uppercase test [tests/002.phpt]"));
      assert.ok(result.text.includes("Tests failed    :    1 ( 33.3%)"));
      assert.ok(!result.text.includes("PASS Array map test"));
      assert.ok(!result.text.includes("PASS JSON decode test"));
    });
  });
});
