import { stripAnsiCodes } from "../normalize.ts";
import { RtkBudgetWriter } from "./budget.ts";
import type { RtkProcessor, RtkProcessorContext, RtkProcessorResult } from "./types.ts";

export const typescriptProcessor: RtkProcessor = {
  id: "typescript",
  process(ctx: RtkProcessorContext): RtkProcessorResult {
    const raw = ctx.stdout;
    if (!raw || typeof raw !== "string")
      return {
        status: "passthrough",
        text: raw ?? "",
        processor: "typescript",
        confidence: 0,
        ownsTruncation: false,
      };
    if (
      !raw.includes("TS") &&
      !raw.includes("error TS") &&
      !raw.includes("Found ") &&
      !raw.includes("error:")
    ) {
      return {
        status: "passthrough",
        text: raw,
        processor: "typescript",
        confidence: 0,
        reason: "No TypeScript diagnostic markers found",
        ownsTruncation: false,
      };
    }

    const writer = new RtkBudgetWriter(ctx.renderBudget);
    let inPrettyBlock = false;
    const summaries: string[] = [];

    for (const line of stripAnsiCodes(raw).split("\n")) {
      const trimmed = line.trim();
      if (
        /^[\w./-]+\.(?:ts|tsx|js|jsx)(?:\(\d+,\d+\)|:\d+:\d+)?\s*(?:-\s*)?error\s+TS\d+:/i.test(
          trimmed
        ) ||
        /^error\s+TS\d+:/i.test(trimmed)
      ) {
        writer.pushRequired(line);
        inPrettyBlock = true;
        continue;
      }
      if (inPrettyBlock) {
        if (!trimmed) continue;
        if (
          /^\d+\s+/.test(trimmed) ||
          /^\s*~+\s*$/.test(trimmed) ||
          /^\s*\^+\s*$/.test(trimmed) ||
          /^\s*\|/.test(trimmed)
        ) {
          writer.pushRequired(line);
          continue;
        }
      }
      if (/^Found \d+ errors?(?: in \d+ files?)?/i.test(trimmed)) {
        summaries.push(line);
        inPrettyBlock = false;
      }
    }

    return {
      status: "compressed",
      text: writer.finish(summaries),
      processor: "typescript",
      confidence: 0.95,
      ownsTruncation: true,
    };
  },
};
