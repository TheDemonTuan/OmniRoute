import type { RtkFilterDefinition } from "./filterSchema.ts";
import type { CommandDetectionResult } from "./commandDetector.ts";

export interface RtkCommandPolicyEvaluation {
  action: "process" | "passthrough" | "reject";
  reason?: string;
}

export function evaluateRtkCommandPolicy(
  filter: RtkFilterDefinition,
  detection: CommandDetectionResult,
  command?: string | null
): RtkCommandPolicyEvaluation {
  const effectiveCommand = command?.trim() || detection.command?.trim() || "";

  // 1. Require known command check
  if (filter.commandPolicy?.requireKnownCommand && !effectiveCommand) {
    return {
      action: "passthrough",
      reason: "Filter requires a known command, but none was provided or detected.",
    };
  }

  // 2. Minimum confidence threshold check
  const minConfidence = filter.safety?.minimumConfidence ?? 0;
  if (minConfidence > 0 && detection.confidence < minConfidence) {
    return {
      action: "passthrough",
      reason: `Detection confidence ${detection.confidence} is below minimum required ${minConfidence}.`,
    };
  }

  // 3. Command policy passthrough patterns check (e.g. -c, -l, --json, -V, dependency:tree)
  if (effectiveCommand && filter.commandPolicy?.passthroughPatterns) {
    for (const pattern of filter.commandPolicy.passthroughPatterns) {
      try {
        const re = new RegExp(pattern);
        if (re.test(effectiveCommand)) {
          return {
            action: "passthrough",
            reason: `Command matched passthrough pattern: ${pattern}`,
          };
        }
      } catch {
        // Ignore malformed regex
      }
    }
  }

  // 4. Command policy supported patterns check (if defined, must match at least one)
  if (
    effectiveCommand &&
    filter.commandPolicy?.supportedPatterns &&
    filter.commandPolicy.supportedPatterns.length > 0
  ) {
    const isSupported = filter.commandPolicy.supportedPatterns.some((pattern) => {
      try {
        return new RegExp(pattern).test(effectiveCommand);
      } catch {
        return false;
      }
    });

    if (!isSupported) {
      if (filter.safety?.preserveOriginalOnUnknownMode) {
        return {
          action: "passthrough",
          reason:
            "Command did not match supported command patterns and preserveOriginalOnUnknownMode is set.",
        };
      }
    }
  }

  return { action: "process" };
}
