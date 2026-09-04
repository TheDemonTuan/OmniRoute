import { stripAnsiCodes } from "../normalize.ts";
import { RtkBudgetWriter } from "./budget.ts";
import type { RtkProcessor, RtkProcessorContext, RtkProcessorResult } from "./types.ts";

const PASSTHROUGH_GOALS = [
  /dependency:(?:tree|list|analyze|resolve)/,
  /help:(?:effective-pom|evaluate|describe|help)/,
  /(?:^|\s)-X(?:\s|$)/,
  /(?:^|\s)--debug(?:\s|$)/,
];
const MAX_STACKTRACE_FRAMES = 15;

export const mavenProcessor: RtkProcessor = {
  id: "maven",
  process(ctx: RtkProcessorContext): RtkProcessorResult {
    const raw = ctx.stdout;
    if (!raw || typeof raw !== "string")
      return {
        status: "passthrough",
        text: raw ?? "",
        processor: "maven",
        confidence: 0,
        ownsTruncation: false,
      };
    if (ctx.command && PASSTHROUGH_GOALS.some((pattern) => pattern.test(ctx.command!))) {
      return {
        status: "passthrough",
        text: raw,
        processor: "maven",
        confidence: 1,
        reason: "Dependency, help, or debug command mode",
        ownsTruncation: false,
      };
    }
    if (
      !raw.includes("[INFO]") &&
      !raw.includes("[ERROR]") &&
      !raw.includes("BUILD SUCCESS") &&
      !raw.includes("BUILD FAILURE")
    ) {
      return {
        status: "passthrough",
        text: raw,
        processor: "maven",
        confidence: 0,
        reason: "Unrecognized Maven framing",
        ownsTruncation: false,
      };
    }

    const writer = new RtkBudgetWriter(ctx.renderBudget);
    let inReactorSummary = false;
    let inStackTrace = false;
    let stackTraceFrameCount = 0;
    let inCompileContinuation = false;

    for (const line of stripAnsiCodes(raw).split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        inStackTrace = false;
        inCompileContinuation = false;
        stackTraceFrameCount = 0;
        continue;
      }
      if (
        trimmed.startsWith("[INFO] Downloading from ") ||
        trimmed.startsWith("[INFO] Downloaded from ") ||
        trimmed.startsWith("Progress (") ||
        trimmed.startsWith("Download ")
      )
        continue;
      if (
        trimmed.startsWith("[INFO] Scanning for projects...") ||
        trimmed.startsWith("[INFO] Building ") ||
        trimmed.startsWith(
          "[INFO] ------------------------------------------------------------------------"
        ) ||
        trimmed.startsWith("[INFO] BUILD SUCCESS") ||
        trimmed.startsWith("[INFO] BUILD FAILURE") ||
        trimmed.startsWith("[INFO] Total time:") ||
        trimmed.startsWith("[INFO] Finished at:")
      ) {
        writer.pushRequired(line);
        continue;
      }
      if (
        trimmed.startsWith("[INFO] Reactor Summary") ||
        trimmed.startsWith("[INFO] Reactor Build Order:")
      ) {
        inReactorSummary = true;
        writer.pushRequired(line);
        continue;
      }
      if (
        inReactorSummary &&
        trimmed.startsWith("[INFO]") &&
        (trimmed.includes("SUCCESS") ||
          trimmed.includes("FAILURE") ||
          trimmed.includes("SKIPPED") ||
          trimmed.includes("---"))
      ) {
        writer.pushRequired(line);
        continue;
      }
      if (trimmed.startsWith("[ERROR]")) {
        writer.pushRequired(line);
        inCompileContinuation = true;
        inStackTrace = true;
        stackTraceFrameCount = 0;
        continue;
      }
      if (inCompileContinuation && /^(?:\[INFO\]\s+)?(?:symbol:|location:)/.test(trimmed)) {
        writer.pushRequired(line);
        continue;
      }
      if (
        trimmed.startsWith("[INFO] Results:") ||
        trimmed.startsWith("[INFO] Tests run:") ||
        trimmed.includes("<<< FAILURE!") ||
        trimmed.includes("<<< ERROR!") ||
        trimmed.startsWith("Failed tests:") ||
        trimmed.startsWith("Tests in error:")
      ) {
        writer.pushRequired(line);
        inStackTrace = true;
        stackTraceFrameCount = 0;
        continue;
      }
      if (
        inStackTrace &&
        (trimmed.startsWith("at ") ||
          trimmed.startsWith("Caused by:") ||
          /^[a-zA-Z0-9_.]+(?:Exception|Error):/.test(trimmed))
      ) {
        if (stackTraceFrameCount < MAX_STACKTRACE_FRAMES) writer.pushRequired(line);
        else if (stackTraceFrameCount === MAX_STACKTRACE_FRAMES)
          writer.pushRequired("    ... [stack trace truncated]");
        stackTraceFrameCount++;
        continue;
      }
      if (
        trimmed.startsWith("[ERROR] To see the full stack trace") ||
        trimmed.startsWith("[ERROR] Re-run Maven using the -X switch") ||
        trimmed.startsWith(
          "[ERROR] After correcting the problems, you can resume the build with the command"
        )
      ) {
        writer.pushRequired(line);
      }
    }

    return {
      status: "compressed",
      text: writer.finish(),
      processor: "maven",
      confidence: 0.95,
      ownsTruncation: true,
    };
  },
};
