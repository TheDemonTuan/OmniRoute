import type { RtkProcessorRenderBudget } from "./types.ts";

export class RtkBudgetWriter {
  private readonly lines: string[] = [];
  private readonly maxLines: number;
  private readonly maxChars: number;
  private chars = 0;
  private didTruncate = false;

  constructor(budget?: RtkProcessorRenderBudget) {
    this.maxLines = Math.max(1, budget?.maxLines ?? Number.MAX_SAFE_INTEGER);
    this.maxChars = Math.max(1, budget?.maxChars ?? Number.MAX_SAFE_INTEGER);
  }

  get truncated(): boolean {
    return this.didTruncate;
  }

  get remainingLines(): number {
    return Math.max(0, this.maxLines - this.lines.length);
  }

  push(line: string): boolean {
    const lineChars = line.length + (this.lines.length > 0 ? 1 : 0);
    if (this.lines.length >= this.maxLines || this.chars + lineChars > this.maxChars) {
      this.didTruncate = true;
      return false;
    }
    this.lines.push(line);
    this.chars += lineChars;
    return true;
  }

  pushRequired(line: string): void {
    if (this.push(line)) return;
    const marker = "... output truncated by RTK processor budget";
    if (this.lines.length === 0) {
      this.lines.push(marker.slice(0, this.maxChars));
      return;
    }
    if (this.lines.at(-1) !== marker && this.lines.length <= this.maxLines) {
      const lastIndex = this.lines.length - 1;
      this.chars -= this.lines[lastIndex].length;
      this.lines[lastIndex] = marker.slice(
        0,
        Math.max(1, this.maxChars - (this.chars > 0 ? 1 : 0))
      );
    }
  }

  finish(summaryLines: string[] = []): string {
    for (const line of summaryLines) {
      this.pushRequired(line);
    }
    if (this.didTruncate && this.lines.at(-1) !== "... output truncated by RTK processor budget") {
      this.pushRequired("... output truncated by RTK processor budget");
    }
    return this.lines.join("\n");
  }
}
