import type {
  RtkProcessor,
  RtkProcessorContext,
  RtkProcessorId,
  RtkProcessorResult,
} from "./types.ts";
import { phptProcessor } from "./phpt.ts";
import { ctestProcessor } from "./ctest.ts";
import { mavenProcessor } from "./maven.ts";
import { gitDiffProcessor } from "./gitDiff.ts";
import { typescriptProcessor } from "./typescript.ts";

const PROCESSOR_REGISTRY: Record<string, RtkProcessor> = {};

export function registerRtkProcessor(processor: RtkProcessor): void {
  PROCESSOR_REGISTRY[processor.id] = processor;
}

// Pre-register built-in stateful processors
registerRtkProcessor(phptProcessor);
registerRtkProcessor(ctestProcessor);
registerRtkProcessor(mavenProcessor);
registerRtkProcessor(gitDiffProcessor);
registerRtkProcessor(typescriptProcessor);

export function executeRtkProcessor(
  processorId: string,
  ctx: RtkProcessorContext
): RtkProcessorResult {
  const processor = PROCESSOR_REGISTRY[processorId];
  if (!processor) {
    return {
      status: "unrecognized",
      text: ctx.stdout,
      processor: processorId as RtkProcessorId,
      confidence: 0,
      reason: `Processor '${processorId}' not registered`,
      ownsTruncation: false,
    };
  }

  try {
    return processor.process(ctx);
  } catch (err) {
    // Fail open on unexpected processor exceptions: return original text
    return {
      status: "invalid",
      text: ctx.stdout,
      processor: processor.id,
      confidence: 0,
      reason: err instanceof Error ? err.message : String(err),
      ownsTruncation: false,
    };
  }
}

export * from "./types.ts";
