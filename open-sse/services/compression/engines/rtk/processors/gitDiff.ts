import { stripAnsiCodes } from "../normalize.ts";
import type { RtkProcessor, RtkProcessorContext, RtkProcessorResult } from "./types.ts";

export const gitDiffProcessor: RtkProcessor = {
  id: "git-diff",
  process(ctx: RtkProcessorContext): RtkProcessorResult {
    const raw = ctx.stdout;
    if (!raw || typeof raw !== "string") {
      return {
        status: "passthrough",
        text: raw ?? "",
        processor: "git-diff",
        confidence: 0,
        ownsTruncation: false,
      };
    }

    // Fail-open for word diff formats: [-deleted-] or {+added+} or combined @@@
    if (raw.includes("[-") || raw.includes("{+") || raw.includes("@@@")) {
      return {
        status: "passthrough",
        text: raw,
        processor: "git-diff",
        confidence: 1,
        reason: "Word-diff or combined merge diff detected",
        ownsTruncation: false,
      };
    }

    // Guard: must have git diff headers or hunk headers
    if (!raw.includes("diff --git") && !raw.includes("@@")) {
      return {
        status: "passthrough",
        text: raw,
        processor: "git-diff",
        confidence: 0,
        reason: "No git diff or hunk headers found",
        ownsTruncation: false,
      };
    }

    const normalized = stripAnsiCodes(raw);
    const lines = normalized.split("\n");

    const kept: string[] = [];
    let inHunk = false;
    let oldRemaining = 0;
    let newRemaining = 0;

    const maxBudgetLines = ctx.renderBudget?.maxLines || ctx.maxLines || 1000;

    for (let i = 0; i < lines.length; i++) {
      if (kept.length >= maxBudgetLines) {
        kept.push(`... +${lines.length - i} more lines omitted (budget cap reached)`);
        break;
      }

      const line = lines[i];

      // File headers & metadata preservation
      if (
        line.startsWith("diff --git ") ||
        line.startsWith("index ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ") ||
        line.startsWith("rename from ") ||
        line.startsWith("rename to ") ||
        line.startsWith("copy from ") ||
        line.startsWith("copy to ") ||
        line.startsWith("similarity index ") ||
        line.startsWith("dissimilarity index ") ||
        line.startsWith("new file mode ") ||
        line.startsWith("deleted file mode ") ||
        line.startsWith("old mode ") ||
        line.startsWith("new mode ") ||
        line.startsWith("Binary files ") ||
        line.startsWith("GIT binary patch")
      ) {
        kept.push(line);
        inHunk = false;
        continue;
      }

      const hunkMatch = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/.exec(line);
      if (hunkMatch) {
        kept.push(line);
        inHunk = true;
        const oldCount = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;
        const newCount = hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1;
        oldRemaining = oldCount;
        newRemaining = newCount;
        continue;
      }

      if (inHunk) {
        if (line.startsWith("+")) {
          kept.push(line);
          newRemaining = Math.max(0, newRemaining - 1);
        } else if (line.startsWith("-")) {
          kept.push(line);
          oldRemaining = Math.max(0, oldRemaining - 1);
        } else if (line.startsWith(" ")) {
          // Context line: omit to compress, but decrement consumed count
          oldRemaining = Math.max(0, oldRemaining - 1);
          newRemaining = Math.max(0, newRemaining - 1);
        } else if (line.startsWith("\\ No newline at end of file")) {
          kept.push(line);
        }

        if (oldRemaining === 0 && newRemaining === 0) {
          inHunk = false;
        }
      }
    }

    return {
      status: "compressed",
      text: kept.join("\n"),
      processor: "git-diff",
      confidence: 0.95,
      ownsTruncation: true,
    };
  },
};
