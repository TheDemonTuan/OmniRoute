import type { RtkProcessorRenderBudget } from "./types.ts";

export type BudgetPriority = "normal" | "important" | "required";

export interface BudgetLine {
  id: number;
  text: string;
  priority: BudgetPriority;
}

const TRUNCATION_MARKER = "... output truncated by RTK processor budget";

export class RtkBudgetWriter {
  private readonly entries: BudgetLine[] = [];
  private readonly maxLines: number;
  private readonly maxChars: number;
  private nextId = 0;

  constructor(budget?: RtkProcessorRenderBudget) {
    this.maxLines = Math.max(1, budget?.maxLines ?? Number.MAX_SAFE_INTEGER);
    this.maxChars = Math.max(1, budget?.maxChars ?? Number.MAX_SAFE_INTEGER);
  }

  get remainingLines(): number {
    return Math.max(0, this.maxLines - this.entries.length);
  }

  push(line: string, priority: BudgetPriority = "normal"): boolean {
    this.entries.push({ id: this.nextId++, text: line, priority });
    return true;
  }

  pushImportant(line: string): boolean {
    return this.push(line, "important");
  }

  pushRequired(line: string): void {
    this.push(line, "required");
  }

  finish(summaryLines: string[] = []): string {
    for (const line of summaryLines) {
      this.pushRequired(line);
    }

    if (this.entries.length === 0) {
      return "";
    }

    // Check if everything fits as-is without any truncation
    const totalLines = this.entries.length;
    const totalChars = this.entries.reduce((acc, e) => acc + e.text.length, 0) + (totalLines - 1);

    if (totalLines <= this.maxLines && totalChars <= this.maxChars) {
      return this.entries.map((e) => e.text).join("\n");
    }

    // Truncation is needed. Reserve 1 line and chars for TRUNCATION_MARKER.
    const markerLen = TRUNCATION_MARKER.length;
    const budgetLines = Math.max(1, this.maxLines - 1);
    const budgetChars = Math.max(1, this.maxChars - (markerLen + 1));

    // Priority partition: required > important > normal
    const required = this.entries.filter((e) => e.priority === "required");
    const important = this.entries.filter((e) => e.priority === "important");
    const normal = this.entries.filter((e) => e.priority === "normal");

    const selectedIds = new Set<number>();
    let currentChars = 0;

    const trySelect = (e: BudgetLine): boolean => {
      const addedChars = e.text.length + (selectedIds.size > 0 ? 1 : 0);
      if (selectedIds.size + 1 > budgetLines || currentChars + addedChars > budgetChars) {
        return false;
      }
      selectedIds.add(e.id);
      currentChars += addedChars;
      return true;
    };

    // 1. Select required lines
    for (const req of required) {
      if (!trySelect(req)) {
        // If even required lines cannot all fit, keep as many as possible
        break;
      }
    }

    // 2. Select important lines with remaining budget
    for (const imp of important) {
      trySelect(imp);
    }

    // 3. Select normal lines with remaining budget
    for (const norm of normal) {
      trySelect(norm);
    }

    // Sort selected lines by their original sequence order
    const orderedEntries = this.entries.filter((e) => selectedIds.has(e.id));

    // Place the truncation marker before the final required/summary block if one exists,
    // otherwise append at the end.
    const finalLines: string[] = [];
    let markerInserted = false;

    // Find index of first trailing required block
    let lastNonReqIndex = -1;
    for (let i = orderedEntries.length - 1; i >= 0; i--) {
      if (orderedEntries[i].priority !== "required") {
        lastNonReqIndex = i;
        break;
      }
    }

    for (let i = 0; i < orderedEntries.length; i++) {
      if (!markerInserted && (lastNonReqIndex === -1 || i > lastNonReqIndex)) {
        finalLines.push(TRUNCATION_MARKER);
        markerInserted = true;
      }
      finalLines.push(orderedEntries[i].text);
    }

    if (!markerInserted) {
      finalLines.push(TRUNCATION_MARKER);
    }

    return finalLines.join("\n");
  }
}
