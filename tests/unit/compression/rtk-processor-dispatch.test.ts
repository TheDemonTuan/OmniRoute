import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeRtkProcessor } from "../../../open-sse/services/compression/engines/rtk/processors/index.ts";
import { processRtkText } from "../../../open-sse/services/compression/engines/rtk/index.ts";

describe("RTK Stateful Processors Integration", () => {
  it("phptProcessor preserves diff lines and failure count", () => {
    const phptOutput = `=====================================================================
TIME START 2026-09-04 12:00:00
=====================================================================
PASS Test A [tests/001.phpt]
========DIFF========
001+ Hello World
001- Hello Universe
========DONE========
FAIL Test B [tests/002.phpt]
=====================================================================
Number of tests :    2                 2
Tests passed    :    1 ( 50.0%)       ( 50.0%)
Tests failed    :    1 ( 50.0%)       ( 50.0%)
=====================================================================
`;
    const result = executeRtkProcessor("phpt", {
      command: "php run-tests.php",
      normalizedCommand: "run-tests.php",
      stdout: phptOutput,
    });

    assert.equal(result.status, "compressed");
    assert.ok(result.text.includes("FAIL Test B [tests/002.phpt]"));
    assert.ok(result.text.includes("001+ Hello World"));
    assert.ok(result.text.includes("001- Hello Universe"));
    assert.ok(result.text.includes("Tests failed    :    1 ( 50.0%)"));
    assert.ok(!result.text.includes("PASS Test A"));
  });

  it("ctestProcessor respects verbose passthrough flag", () => {
    const raw = "Test project /build\n 1/1 Test #1: math ...   Passed    0.01 sec\n";
    const result = executeRtkProcessor("ctest", {
      command: "ctest -V",
      normalizedCommand: "ctest -V",
      stdout: raw,
    });

    assert.equal(result.status, "passthrough");
    assert.equal(result.text, raw);
  });

  it("mavenProcessor respects dependency:tree passthrough", () => {
    const raw =
      "[INFO] --- maven-dependency-plugin:3.1.2:tree (default-cli) @ app ---\n[INFO] org.example:app:jar:1.0-SNAPSHOT\n[INFO] \\- org.slf4j:slf4j-api:jar:1.7.30:compile\n";
    const result = executeRtkProcessor("maven", {
      command: "mvn dependency:tree",
      normalizedCommand: "mvn dependency:tree",
      stdout: raw,
    });

    assert.equal(result.status, "passthrough");
    assert.equal(result.text, raw);
  });

  it("typescriptProcessor preserves pretty multiline errors with carets", () => {
    const tsError = `src/index.ts:15:7 - error TS2322: Type 'string' is not assignable to type 'number'.

15 const x: number = "hello";
         ~

Found 1 error in src/index.ts:15
`;
    const result = processRtkText(tsError, { command: "tsc" });
    assert.ok(result.text.includes("error TS2322"));
    assert.ok(result.text.includes('const x: number = "hello";'));
    assert.ok(result.text.includes("~"));
    assert.ok(result.text.includes("Found 1 error"));
  });
});
