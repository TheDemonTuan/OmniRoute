import { stripAnsiCodes, normalizeProgressCr } from "../normalize.ts";
import type { RtkProcessor, RtkProcessorContext, RtkProcessorResult } from "./types.ts";

const MAX_FAILURES_SHOWN = 20;
const MAX_DIFF_LINES_PER_FAILURE = 6;

interface PhptFailure {
  status: "FAIL" | "BORK" | "LEAK";
  testName: string;
  testPath: string;
  reason?: string;
  diffLines: string[];
}

export const phptProcessor: RtkProcessor = {
  id: "phpt",
  process(ctx: RtkProcessorContext): RtkProcessorResult {
    const raw = ctx.stdout;
    if (!raw || typeof raw !== "string") {
      return {
        status: "passthrough",
        text: raw ?? "",
        processor: "phpt",
        confidence: 0,
        ownsTruncation: false,
      };
    }

    // Fail-open for startup failures or non-PHPT executions
    if (
      raw.includes("Could not open input file: run-tests.php") ||
      raw.includes("PHP Fatal error:") ||
      (!raw.includes("TIME START") &&
        !raw.includes("Number of tests") &&
        !raw.includes("PASS ") &&
        !raw.includes("FAIL "))
    ) {
      return {
        status: "passthrough",
        text: raw,
        processor: "phpt",
        confidence: 0,
        reason: "Unrecognized or fatal PHP startup error",
        ownsTruncation: false,
      };
    }

    const normalized = normalizeProgressCr(stripAnsiCodes(raw));
    const lines = normalized.split("\n");

    const headerLines: string[] = [];
    const failures: PhptFailure[] = [];
    const summaryLines: string[] = [];
    let inHeader = false;
    let inDiff = false;
    let currentDiffLines: string[] = [];
    let totalFailuresCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (
        trimmed.startsWith("=====================================================================")
      ) {
        if (headerLines.length === 0) {
          inHeader = true;
          headerLines.push(line);
          continue;
        } else if (inHeader) {
          headerLines.push(line);
          inHeader = false;
          continue;
        }
      }

      if (inHeader) {
        if (
          trimmed.startsWith("TIME START") ||
          trimmed.startsWith("PHP ") ||
          trimmed.startsWith("CWD")
        ) {
          headerLines.push(line);
        }
        continue;
      }

      if (trimmed.startsWith("========DIFF========") || trimmed.startsWith("========DIFF")) {
        inDiff = true;
        currentDiffLines = [];
        continue;
      }

      if (trimmed.startsWith("========DONE========") || trimmed.startsWith("========DONE")) {
        inDiff = false;
        continue;
      }

      if (inDiff) {
        currentDiffLines.push(line);
        continue;
      }

      const matchFailure = /^(FAIL|BORK|LEAK)\s+(.*?)\s+\[(.*?)\](?:\s+reason:\s+(.*))?$/.exec(
        trimmed
      );
      if (matchFailure) {
        totalFailuresCount++;
        const [, status, testName, testPath, reason] = matchFailure;
        failures.push({
          status: status as "FAIL" | "BORK" | "LEAK",
          testName,
          testPath,
          reason,
          diffLines: [...currentDiffLines],
        });
        currentDiffLines = [];
        continue;
      }

      if (/^(?:PASS|SKIP|WARN|XFAIL|XLEAK)\s+/.test(trimmed)) {
        currentDiffLines = [];
        continue;
      }

      if (
        trimmed.startsWith("Number of tests :") ||
        trimmed.startsWith("Tests passed    :") ||
        trimmed.startsWith("Tests failed    :") ||
        trimmed.startsWith("Tests skipped   :") ||
        trimmed.startsWith("Tests warned    :") ||
        trimmed.startsWith("Tests leaked    :") ||
        trimmed.startsWith("Expected fail   :")
      ) {
        summaryLines.push(line);
      }
    }

    const outputLines: string[] = [];
    if (headerLines.length > 0) {
      outputLines.push(...headerLines);
    }

    const shownFailures = failures.slice(0, MAX_FAILURES_SHOWN);
    for (const f of shownFailures) {
      outputLines.push(
        `${f.status} ${f.testName} [${f.testPath}]${f.reason ? ` reason: ${f.reason}` : ""}`
      );
      if (f.diffLines.length > 0) {
        outputLines.push("========DIFF========");
        const shownDiff = f.diffLines.slice(0, MAX_DIFF_LINES_PER_FAILURE);
        outputLines.push(...shownDiff);
        if (f.diffLines.length > MAX_DIFF_LINES_PER_FAILURE) {
          const omitted = f.diffLines.length - MAX_DIFF_LINES_PER_FAILURE;
          outputLines.push(`... +${omitted} more diff lines`);
        }
        outputLines.push("========DONE========");
      }
    }

    if (failures.length > MAX_FAILURES_SHOWN) {
      const omittedFailures = failures.length - MAX_FAILURES_SHOWN;
      outputLines.push(`... +${omittedFailures} more failures`);
    }

    if (summaryLines.length > 0) {
      outputLines.push("=====================================================================");
      outputLines.push(...summaryLines);
      outputLines.push("=====================================================================");
    }

    const resultText = outputLines.join("\n");
    return {
      status: "compressed",
      text: resultText,
      processor: "phpt",
      confidence: 0.95,
      ownsTruncation: true,
      stats: {
        totalFailures: totalFailuresCount,
        shownFailures: shownFailures.length,
      },
    };
  },
};
