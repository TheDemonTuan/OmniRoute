import { stripAnsiCodes } from "../normalize.ts";
import type { RtkProcessor, RtkProcessorContext, RtkProcessorResult } from "./types.ts";

export const typescriptProcessor: RtkProcessor = {
  id: "typescript",
  process(ctx: RtkProcessorContext): RtkProcessorResult {
    const raw = ctx.stdout;
    if (!raw || typeof raw !== "string") {
      return {
        status: "passthrough",
        text: raw ?? "",
        processor: "typescript",
        confidence: 0,
        ownsTruncation: false,
      };
    }

    // Guard: must contain TS error codes or diagnostic markers
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

    const normalized = stripAnsiCodes(raw);
    const lines = normalized.split("\n");

    const kept: string[] = [];
    let inPrettyBlock = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Standard diagnostic header: file.ts(10,5): error TS2322: ...
      // or file.ts:10:5 - error TS2322: ...
      // or error TS6053: ...
      if (
        /^[\w./-]+\.(?:ts|tsx|js|jsx)(?:\(\d+,\d+\)|:\d+:\d+)?\s*(?:-\s*)?error\s+TS\d+:/i.test(
          trimmed
        ) ||
        /^error\s+TS\d+:/i.test(trimmed)
      ) {
        kept.push(line);
        inPrettyBlock = true;
        continue;
      }

      // Pretty diagnostic code snippet / caret indicator line
      if (inPrettyBlock) {
        if (!trimmed) {
          // Blank line within pretty diagnostic: continue tracking
          continue;
        }
        if (
          /^\d+\s+/.test(trimmed) ||
          /^\s*~+\s*$/.test(trimmed) ||
          /^\s*\^+\s*$/.test(trimmed) ||
          /^\s*\|/.test(trimmed)
        ) {
          kept.push(line);
          continue;
        }
      }

      // Summary lines: Found 3 errors in 2 files.
      if (/^Found \d+ errors?(?: in \d+ files?)?/i.test(trimmed)) {
        kept.push(line);
        inPrettyBlock = false;
        continue;
      }
    }
    return {
      status: "compressed",
      text: kept.join("\n"),
      processor: "typescript",
      confidence: 0.95,
      ownsTruncation: true,
    };
  },
};
