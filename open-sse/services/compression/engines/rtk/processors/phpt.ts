import { stripAnsiCodes, normalizeProgressCr } from "../normalize.ts";
import { RtkBudgetWriter } from "./budget.ts";
import type { RtkProcessor, RtkProcessorContext, RtkProcessorResult } from "./types.ts";

const MAX_FAILURES_SHOWN = 20;
const MAX_DIFF_LINES_PER_FAILURE = 6;

type PhptStatus = "PASS" | "FAIL" | "SKIP" | "BORK" | "WARN" | "LEAK" | "XFAIL" | "XLEAK";

interface PendingDiff {
  lines: string[];
  totalLines: number;
}

interface PhptFailure {
  status: PhptStatus;
  testName: string;
  testPath: string;
  reason?: string;
  diff?: PendingDiff;
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
    let diffBuffer: string[] = [];
    let diffTotal = 0;
    let pendingDiff: PendingDiff | null = null;

    let phpVersion = "";
    let phpSapi = "";
    let phpOs = "";

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

    const summaryCounts = {
      failed: 0,
      borked: 0,
      leaked: 0,
    };
    let summaryCountsFound = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (
        trimmed.startsWith("=====================================================================")
      ) {
        if (headerLines.length === 0) {
          inHeader = true;
          headerLines.push(line);
          continue;
        }
        if (inHeader) {
          headerLines.push(line);
          inHeader = false;
          continue;
        }
      }

      if (inHeader) {
        const mVer = /^(?:PHP_VERSION\s*:\s*|PHP\s+)(.+)$/i.exec(trimmed);
        if (mVer) phpVersion = mVer[1].trim();

        const mSapi = /^(?:PHP_SAPI\s*:\s*|SAPI\s+)(.+)$/i.exec(trimmed);
        if (mSapi) phpSapi = mSapi[1].trim();

        const mOs = /^(?:PHP_OS\s*:\s*|OS\s+)(.+)$/i.exec(trimmed);
        if (mOs) phpOs = mOs[1].trim();

        if (trimmed.startsWith("TIME START") || trimmed.startsWith("CWD")) {
          headerLines.push(line);
        }
        continue;
      }

      if (trimmed.startsWith("========DIFF")) {
        inDiff = true;
        diffBuffer = [];
        diffTotal = 0;
        continue;
      }
      if (trimmed.startsWith("========DONE")) {
        inDiff = false;
        pendingDiff = { lines: diffBuffer, totalLines: diffTotal };
        continue;
      }
      if (inDiff) {
        diffTotal++;
        if (diffBuffer.length < MAX_DIFF_LINES_PER_FAILURE) diffBuffer.push(line);
        continue;
      }

      const matchResult =
        /(?:^|\]\s*)(PASS|FAIL|SKIP|BORK|WARN|LEAK|XFAIL|XLEAK)\s+(.*?)(?:\s+\[(.*?)\])?(?:\s+reason:\s+(.*))?$/.exec(
          trimmed
        );
      if (matchResult) {
        const [, statusStr, testName, testPath, reason] = matchResult;
        const status = statusStr as PhptStatus;
        counts[status]++;
        if (status === "FAIL" || status === "BORK" || status === "LEAK") {
          failures.push({
            status,
            testName,
            testPath: testPath || "unknown",
            reason,
            diff: pendingDiff ?? undefined,
          });
        }
        // Any test status consumes a pending DIFF. It can never bleed to later tests.
        pendingDiff = null;
        continue;
      }

      const mFailed = /^Tests failed\s*:\s*(\d+)/i.exec(trimmed);
      if (mFailed) {
        summaryCounts.failed = parseInt(mFailed[1], 10);
        summaryCountsFound = true;
      }
      const mBorked = /^Tests borked\s*:\s*(\d+)/i.exec(trimmed);
      if (mBorked) {
        summaryCounts.borked = parseInt(mBorked[1], 10);
        summaryCountsFound = true;
      }
      const mLeaked = /^Tests leaked\s*:\s*(\d+)/i.exec(trimmed);
      if (mLeaked) {
        summaryCounts.leaked = parseInt(mLeaked[1], 10);
        summaryCountsFound = true;
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
        trimmed.startsWith("Expected leak   :") ||
        trimmed.startsWith("Time taken      :")
      ) {
        summaryLines.push(line);
      }
    }

    const writer = new RtkBudgetWriter(ctx.renderBudget);
    for (const line of headerLines) writer.push(line);

    if (phpVersion || phpSapi || phpOs) {
      writer.push(
        `PHP ${phpVersion || "unknown"} SAPI ${phpSapi || "unknown"} OS ${phpOs || "unknown"}`
      );
    }

    const maxShown = Math.min(MAX_FAILURES_SHOWN, failures.length);
    for (const failure of failures.slice(0, maxShown)) {
      writer.pushRequired(
        `${failure.status} ${failure.testName} [${failure.testPath}]${failure.reason ? ` reason: ${failure.reason}` : ""}`
      );
      if (failure.diff) {
        writer.pushImportant("========DIFF========");
        for (const line of failure.diff.lines) writer.pushImportant(line);
        if (failure.diff.totalLines > failure.diff.lines.length) {
          writer.pushImportant(
            `... +${failure.diff.totalLines - failure.diff.lines.length} more diff lines`
          );
        }
        writer.pushImportant("========DONE========");
      }
    }
    if (failures.length > maxShown) {
      writer.pushRequired(`... +${failures.length - maxShown} more failures`);
    }

    const totalExpectedFailures = summaryCountsFound
      ? summaryCounts.failed + summaryCounts.borked + summaryCounts.leaked
      : counts.FAIL + counts.BORK + counts.LEAK;

    if (totalExpectedFailures > 0 && failures.length === 0) {
      writer.pushRequired(
        `FAILURES (${totalExpectedFailures}): per-test details unavailable — output truncated`
      );
    }

    writer.pushRequired("=====================================================================");
    return {
      status: "compressed",
      text: writer.finish([
        ...summaryLines,
        "=====================================================================",
      ]),
      processor: "phpt",
      confidence: 0.95,
      ownsTruncation: true,
      stats: { ...counts, shownFailures: maxShown },
    };
  },
};
