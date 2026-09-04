export type RtkProcessorId = "ctest" | "maven" | "phpt" | "git-diff" | "typescript";

export type RtkProcessorStatus = "compressed" | "passthrough" | "unrecognized" | "invalid";

export interface RtkProcessorRenderBudget {
  maxLines?: number;
  maxChars?: number;
  maxEstimatedTokens?: number;
}

export interface RtkProcessorContext {
  command: string | null;
  normalizedCommand: string | null;
  stdout: string;
  stderr?: string;
  maxLines?: number;
  renderBudget?: RtkProcessorRenderBudget;
  rawRecoveryEnabled?: boolean;
}

export interface RtkProcessorResult {
  status: RtkProcessorStatus;
  text: string;
  processor: RtkProcessorId;
  confidence: number;
  reason?: string;
  ownsTruncation: boolean;
  protectedLineRanges?: Array<[number, number]>;
  stats?: Record<string, number | string | boolean>;
}

export interface RtkProcessor {
  id: RtkProcessorId;
  process(ctx: RtkProcessorContext): RtkProcessorResult;
}
