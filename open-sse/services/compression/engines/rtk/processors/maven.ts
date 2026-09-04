import { stripAnsiCodes } from "../normalize.ts";
import type { RtkProcessor, RtkProcessorContext, RtkProcessorResult } from "./types.ts";

const PASSTHROUGH_GOALS = [
  /dependency:(?:tree|list|analyze|resolve)/,
  /help:(?:effective-pom|evaluate|describe|help)/,
  /(?:^|\s)-X(?:\s|$)/,
  /(?:^|\s)--debug(?:\s|$)/,
];

export const mavenProcessor: RtkProcessor = {
  id: "maven",
  process(ctx: RtkProcessorContext): RtkProcessorResult {
    const raw = ctx.stdout;
    if (!raw || typeof raw !== "string") {
      return {
        status: "passthrough",
        text: raw ?? "",
        processor: "maven",
        confidence: 0,
        ownsTruncation: false,
      };
    }

    if (ctx.command) {
      for (const pattern of PASSTHROUGH_GOALS) {
        if (pattern.test(ctx.command)) {
          return {
            status: "passthrough",
            text: raw,
            processor: "maven",
            confidence: 1,
            reason: `Passthrough Maven goal detected in '${ctx.command}'`,
            ownsTruncation: false,
          };
        }
      }
    }

    // Fail-open if output does not have basic Maven markers
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

    const normalized = stripAnsiCodes(raw);
    const lines = normalized.split("\n");

    const kept: string[] = [];
    let inReactorSummary = false;
    let inStackTrace = false;
    let inCompileErrorContinuation = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed) {
        inStackTrace = false;
        inCompileErrorContinuation = false;
        continue;
      }

      // Drop download noise
      if (
        trimmed.startsWith("[INFO] Downloading from ") ||
        trimmed.startsWith("[INFO] Downloaded from ") ||
        trimmed.startsWith("Progress (") ||
        trimmed.startsWith("Download ")
      ) {
        continue;
      }

      // Preserved Headers & Milestones
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
        kept.push(line);
        continue;
      }

      // Reactor Summary
      if (
        trimmed.startsWith("[INFO] Reactor Summary") ||
        trimmed.startsWith("[INFO] Reactor Build Order:")
      ) {
        inReactorSummary = true;
        kept.push(line);
        continue;
      }

      if (inReactorSummary) {
        if (
          trimmed.startsWith("[INFO]") &&
          (trimmed.includes("SUCCESS") ||
            trimmed.includes("FAILURE") ||
            trimmed.includes("SKIPPED") ||
            trimmed.includes("---"))
        ) {
          kept.push(line);
          continue;
        } else if (trimmed.startsWith("[INFO] ---")) {
          inReactorSummary = false;
        }
      }

      // Compilation & Runtime Errors
      if (trimmed.startsWith("[ERROR]")) {
        kept.push(line);
        inCompileErrorContinuation = true;
        inStackTrace = true;
        continue;
      }

      // Multi-line compile continuation (symbol:, location:)
      if (
        inCompileErrorContinuation &&
        (trimmed.startsWith("[INFO]   location:") ||
          trimmed.startsWith("[INFO]   symbol:") ||
          trimmed.startsWith("location:") ||
          trimmed.startsWith("symbol:"))
      ) {
        kept.push(line);
        continue;
      }

      // Surefire / Failsafe Test Failures & Stack traces
      if (
        trimmed.startsWith("[INFO] Results:") ||
        trimmed.startsWith("[INFO] Tests run:") ||
        trimmed.includes("<<< FAILURE!") ||
        trimmed.includes("<<< ERROR!") ||
        trimmed.startsWith("Failed tests:") ||
        trimmed.startsWith("Tests in error:")
      ) {
        kept.push(line);
        inStackTrace = true;
        continue;
      }

      // Stacktrace frames under active failure
      if (
        inStackTrace &&
        (trimmed.startsWith("at ") ||
          trimmed.startsWith("Caused by:") ||
          /^[a-zA-Z0-9_.]+(?:Exception|Error):/.test(trimmed))
      ) {
        kept.push(line);
        continue;
      }

      // Resume multi-module project hint
      if (
        trimmed.startsWith("[ERROR] To see the full stack trace of the errors") ||
        trimmed.startsWith("[ERROR] Re-run Maven using the -X switch") ||
        trimmed.startsWith(
          "[ERROR] After correcting the problems, you can resume the build with the command"
        )
      ) {
        kept.push(line);
        continue;
      }
    }

    return {
      status: "compressed",
      text: kept.join("\n"),
      processor: "maven",
      confidence: 0.95,
      ownsTruncation: true,
    };
  },
};
