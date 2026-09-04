import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  processRtkText,
  maybePersistRtkRawOutput,
  detectCommandType,
} from "../../../open-sse/services/compression/index.ts";

describe("RTK v0.47 Parity Terminal Passthrough & Security Verification", () => {
  describe("P0 Terminal Passthrough through processRtkText", () => {
    it("terminal passthrough for ctest -V bypasses downstream line filtering and truncation", () => {
      const raw = `Test project /workspace/build
 1/2 Test #1: math ....................   Passed    0.01 sec
 2/2 Test #2: algo ....................   Passed    0.02 sec
100% tests passed
`;
      const result = processRtkText(raw, { command: "ctest -V" });
      assert.equal(result.text, raw);
      assert.equal(result.compressedTokens, result.originalTokens);
      assert.equal(result.tokensSaved, 0);
    });

    it("terminal passthrough for mvn dependency:tree bypasses downstream line filtering", () => {
      const raw = `[INFO] Scanning for projects...
[INFO] --- maven-dependency-plugin:3.1.2:tree (default-cli) @ myapp ---
[INFO] com.example:myapp:jar:1.0.0
[INFO] \\- org.slf4j:slf4j-api:jar:1.7.30:compile
[INFO] BUILD SUCCESS
`;
      const result = processRtkText(raw, { command: "mvn dependency:tree" });
      assert.equal(result.text, raw);
      assert.equal(result.tokensSaved, 0);
    });

    it("terminal passthrough for git diff with word-diff format", () => {
      const wordDiff = `diff --git a/test.ts b/test.ts
@@ -1 +1 @@
[-old-] {+new+}
`;
      const result = processRtkText(wordDiff, { command: "git diff --word-diff" });
      assert.equal(result.text, wordDiff);
      assert.equal(result.tokensSaved, 0);
    });

    it("terminal passthrough for grep with format-altering -l and -c flags via commandPolicy", () => {
      const grepL = "src/a.ts\nsrc/b.ts\nsrc/c.ts\n";
      const resL = processRtkText(grepL, { command: "grep -l pattern ." });
      assert.equal(resL.text, grepL);

      const grepC = "42\n";
      const resC = processRtkText(grepC, { command: "grep -c pattern file.ts" });
      assert.equal(resC.text, grepC);
    });
  });

  describe("Recovery Security & Filename Secret Sanitization", () => {
    it("sanitizes filename to use familySlug only without raw argv credentials", () => {
      const sensitiveCommand =
        "TOKEN=ghp_SuperSecretPassword12345678901234 curl -H 'Authorization: Bearer sk-ant-api03-12345678901234567890' https://api.example.com";
      const rawOutput = "Response data error 500 failed";

      const pointer = maybePersistRtkRawOutput(rawOutput, {
        command: sensitiveCommand,
        retention: "always",
      });

      assert.ok(pointer !== null);
      // Ensure the generated filename contains NO part of the sensitive token or bearer key
      assert.ok(!pointer.path.includes("ghp_SuperSecretPassword"));
      assert.ok(!pointer.path.includes("sk-ant-api03"));
      assert.ok(!pointer.path.includes("TOKEN"));

      // Ensure sidecar metadata also redacts the command
      const metaPath = pointer.path.replace(/\.log$/, ".meta.json");
      assert.ok(fs.existsSync(metaPath));
      const metaContent = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      assert.ok(!metaContent.safeSignature.includes("sk-ant-api03-12345678901234567890"));
      assert.ok(!metaContent.safeSignature.includes("ghp_SuperSecretPassword12345678901234"));
      assert.ok(metaContent.commandHash !== null);
    });
  });

  describe("Git Diff Rename, Binary and Metadata Preservation", () => {
    it("preserves rename metadata without hunks", () => {
      const renameDiff = `diff --git a/old.ts b/new.ts
similarity index 100%
rename from old.ts
rename to new.ts
`;
      const result = processRtkText(renameDiff, { command: "git diff" });
      assert.ok(result.text.includes("rename from old.ts"));
      assert.ok(result.text.includes("rename to new.ts"));
      assert.ok(result.text.includes("similarity index 100%"));
    });

    it("preserves binary file change indicator", () => {
      const binaryDiff = `diff --git a/logo.png b/logo.png
index 1234567..89abcdef 100644
Binary files a/logo.png and b/logo.png differ
`;
      const result = processRtkText(binaryDiff, { command: "git diff" });
      assert.ok(result.text.includes("Binary files a/logo.png and b/logo.png differ"));
    });
  });

  describe("Detector Tightening against Standalone [ERROR]", () => {
    it("does not classify random server log with [ERROR] as Maven", () => {
      const genericLog = "[ERROR] Connection to redis://localhost:6379 failed";
      const detection = detectCommandType(genericLog);
      assert.notEqual(detection.type, "maven");
    });
  });
});
