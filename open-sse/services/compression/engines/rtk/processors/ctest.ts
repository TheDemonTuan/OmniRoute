import { stripAnsiCodes } from "../normalize.ts";
import { RtkBudgetWriter } from "./budget.ts";
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
    if (ctx.command && PASSTHROUGH_PATTERNS.some((pattern) => pattern.test(ctx.command!))) {
      return {
        status: "passthrough",
        text: raw,
        processor: "ctest",
        confidence: 1,
        reason: "Verbose, listing, help, or version mode",
        ownsTruncation: false,
      };
    }
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

    const lines = stripAnsiCodes(raw).split("\n");
    const headerLines: string[] = [];
    const seenTests = new Map<string, CTestFailure>();
    const summaryLines: string[] = [];
    const trailerFailedLines: string[] = [];
    let currentFailure: CTestFailure | null = null;
    let inFailedTrailer = false;
    const maxLinesPerFailure = 25;

    for (const line of lines) {
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
        if (trimmed) trailerFailedLines.push(line);
        continue;
      }
      const resultMatch =
        /^\s*(\d+)\/\d+\s+Test\s+#(\d+):\s+(.*?)\s+\.{3,}\s*\*{3}(Failed|Timeout|Killed)(?:\s+([\d.]+\s+sec))?/.exec(
          trimmed
        );
      if (resultMatch) {
        const [, , testNumStr, testName, status, duration] = resultMatch;
        currentFailure = {
          testIndex: parseInt(testNumStr, 10),
          testName,
          duration,
          status: status as CTestFailure["status"],
          diagnosticLines: [],
        };
        seenTests.set(`${currentFailure.testIndex}:${currentFailure.testName}`, currentFailure);
        continue;
      }
      if (/^\s*\d+\/\d+\s+Test\s+#\d+:\s+.*?\s+\.{3,}\s*Passed/.test(trimmed)) {
        currentFailure = null;
        continue;
      }
      if (currentFailure && !trimmed.startsWith("Start ") && !trimmed.includes("% tests passed")) {
        if (currentFailure.diagnosticLines.length < maxLinesPerFailure)
          currentFailure.diagnosticLines.push(line);
        else if (currentFailure.diagnosticLines.length === maxLinesPerFailure)
          currentFailure.diagnosticLines.push("... [failure diagnostics truncated]");
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

    const writer = new RtkBudgetWriter(ctx.renderBudget);
    for (const line of headerLines) writer.push(line);
    let emitted = 0;
    for (const failure of seenTests.values()) {
      if (writer.remainingLines < 3) {
        writer.pushRequired(`... +${seenTests.size - emitted} more failed tests omitted`);
        break;
      }
      emitted++;
      writer.pushRequired(
        `Test #${failure.testIndex}: ${failure.testName} ...***${failure.status}${failure.duration ? `    ${failure.duration}` : ""}`
      );
      for (const line of failure.diagnosticLines) writer.pushRequired(line);
    }
    return {
      status: "compressed",
      text: writer.finish([...summaryLines, ...trailerFailedLines]),
      processor: "ctest",
      confidence: 0.95,
      ownsTruncation: true,
      stats: { failuresFound: seenTests.size },
    };
  },
};
