import { stripAnsiCodes } from "../normalize.ts";
import type { RtkProcessor, RtkProcessorContext, RtkProcessorResult } from "./types.ts";

const PASSTHROUGH_PATTERNS = [
  /(?:^|\s)-(?:V|VV)(?:\s|$)/,
  /(?:^|\s)--verbose(?:\s|$)/,
  /(?:^|\s)-N(?:\s|$)/,
  /(?:^|\s)--show-only(?:\s|$)/,
  /(?:^|\s)--help(?:\s|$)/,
  /(?:^|\s)--version(?:\s|$)/,
];

interface CTestFailure {
  testIndex: number;
  testName: string;
  duration?: string;
  status: "Failed" | "Timeout" | "Killed";
  diagnosticLines: string[];
}

export const ctestProcessor: RtkProcessor = {
  id: "ctest",
  process(ctx: RtkProcessorContext): RtkProcessorResult {
    const raw = ctx.stdout;
    if (!raw || typeof raw !== "string") {
      return {
        status: "passthrough",
        text: raw ?? "",
        processor: "ctest",
        confidence: 0,
        ownsTruncation: false,
      };
    }

    // Check passthrough flags in command if present
    if (ctx.command) {
      for (const pattern of PASSTHROUGH_PATTERNS) {
        if (pattern.test(ctx.command)) {
          return {
            status: "passthrough",
            text: raw,
            processor: "ctest",
            confidence: 1,
            reason: `Passthrough command flag detected in '${ctx.command}'`,
            ownsTruncation: false,
          };
        }
      }
    }

    // Fail-open for zero test runs with cmake errors or non-CTest output
    if (!raw.includes("Test project") && !raw.includes("tests passed") && !raw.includes("Test #")) {
      return {
        status: "passthrough",
        text: raw,
        processor: "ctest",
        confidence: 0,
        reason: "Unrecognized CTest framing",
        ownsTruncation: false,
      };
    }

    const normalized = stripAnsiCodes(raw);
    const lines = normalized.split("\n");

    const headerLines: string[] = [];
    const seenTests = new Map<string, CTestFailure>();
    const summaryLines: string[] = [];
    const trailerFailedLines: string[] = [];
    let currentFailure: CTestFailure | null = null;
    let inFailedTrailer = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (trimmed.startsWith("Test project")) {
        headerLines.push(line);
        continue;
      }

      if (trimmed.startsWith("The following tests FAILED:")) {
        inFailedTrailer = true;
        trailerFailedLines.push(line);
        continue;
      }

      if (inFailedTrailer) {
        if (/^\d+\s+-\s+/.test(trimmed)) {
          trailerFailedLines.push(line);
        } else if (trimmed.length > 0) {
          trailerFailedLines.push(line);
        }
        continue;
      }

      const resultMatch =
        /^\s*(\d+)\/\d+\s+Test\s+#(\d+):\s+(.*?)\s+\.{3,}\s*\*{3}(Failed|Timeout|Killed)(?:\s+([\d.]+\s+sec))?/.exec(
          trimmed
        );
      if (resultMatch) {
        const [, , testNumStr, testName, status, duration] = resultMatch;
        const testIndex = parseInt(testNumStr, 10);
        const dedupeKey = `${testIndex}:${testName}`;
        currentFailure = {
          testIndex,
          testName,
          duration,
          status: status as "Failed" | "Timeout" | "Killed",
          diagnosticLines: [],
        };
        seenTests.set(dedupeKey, currentFailure);
        continue;
      }

      const passMatch = /^\s*\d+\/\d+\s+Test\s+#\d+:\s+.*?\s+\.{3,}\s*Passed/.exec(trimmed);
      if (passMatch) {
        currentFailure = null;
        continue;
      }

      if (currentFailure && !trimmed.startsWith("Start ") && !trimmed.includes("% tests passed")) {
        currentFailure.diagnosticLines.push(line);
        continue;
      }

      if (
        /\d+%\s+tests passed(?:,\s+\d+\s+tests failed out of\s+\d+)?/.test(trimmed) ||
        trimmed.startsWith("Errors were encountered")
      ) {
        currentFailure = null;
        summaryLines.push(line);
      }
    }

    const outputLines: string[] = [];
    if (headerLines.length > 0) {
      outputLines.push(...headerLines);
    }

    for (const [, failure] of seenTests) {
      const dur = failure.duration ? `    ${failure.duration}` : "";
      outputLines.push(
        `Test #${failure.testIndex}: ${failure.testName} ...***${failure.status}${dur}`
      );
      if (failure.diagnosticLines.length > 0) {
        outputLines.push(...failure.diagnosticLines);
      }
    }

    if (summaryLines.length > 0) {
      outputLines.push(...summaryLines);
    }

    if (trailerFailedLines.length > 0) {
      outputLines.push(...trailerFailedLines);
    }

    return {
      status: "compressed",
      text: outputLines.join("\n"),
      processor: "ctest",
      confidence: 0.95,
      ownsTruncation: true,
      stats: {
        failuresFound: seenTests.size,
      },
    };
  },
};
