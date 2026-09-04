import { stripAnsiCodes, normalizeProgressCr } from "../normalize.ts";
import type { RtkProcessor, RtkProcessorContext, RtkProcessorResult } from "./types.ts";

const MAX_FAILURES_SHOWN = 20;
const MAX_DIFF_LINES_PER_FAILURE = 6;

type PhptStatus = "PASS" | "FAIL" | "SKIP" | "BORK" | "WARN" | "LEAK" | "XFAIL" | "XLEAK";

interface PhptFailure {
  status: PhptStatus;
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

    const counts: Record<PhptStatus, number> = {
      PASS: 0,
      FAIL: 0,
      SKIP: 0,
      BORK: 0,
      WARN: 0,
      LEAK: 0,
      XFAIL: 0,
      XLEAK: 0,
    };

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
          trimmed.startsWith("CWD") ||
          trimmed.startsWith("OS ") ||
          trimmed.startsWith("SAPI ")
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

      // Supports status anchors at line start or after TEST N/M [path]
      const matchResult =
        /(?:^|\]\s*)(PASS|FAIL|SKIP|BORK|WARN|LEAK|XFAIL|XLEAK)\s+(.*?)(?:\s+\[(.*?)\])?(?:\s+reason:\s+(.*))?$/.exec(
          trimmed
        );
      if (matchResult) {
        const [, statusStr, testName, testPath, reason] = matchResult;
        const status = statusStr as PhptStatus;
        counts[status] = (counts[status] || 0) + 1;

        if (status === "FAIL" || status === "BORK" || status === "LEAK") {
          failures.push({
            status,
            testName,
            testPath: testPath || "unknown",
            reason,
            diffLines: [...currentDiffLines],
          });
        }
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
        trimmed.startsWith("Tests borked    :") ||
        trimmed.startsWith("Expected fail   :") ||
        trimmed.startsWith("Expected leak   :")
      ) {
        summaryLines.push(line);
      }
    }

    const outputLines: string[] = [];
    if (headerLines.length > 0) {
      outputLines.push(...headerLines);
    }

    const maxShown = ctx.renderBudget?.maxLines
      ? Math.min(MAX_FAILURES_SHOWN, Math.floor(ctx.renderBudget.maxLines / 4))
      : MAX_FAILURES_SHOWN;
    const shownFailures = failures.slice(0, maxShown);
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

    if (failures.length > shownFailures.length) {
      const omittedFailures = failures.length - shownFailures.length;
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
        ...counts,
        shownFailures: shownFailures.length,
      },
    };
  },
};
