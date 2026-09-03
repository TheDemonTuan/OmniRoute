import {
  getClaudeCodeRuntimeVersion,
  getClaudeCodeSdkVersion,
  getClaudeCodeUserAgent,
  getClaudeCodeVersion,
} from "@/shared/constants/claudeCodeClient";

export function getClaudeCodeCompatibleVersion(): string {
  return getClaudeCodeVersion();
}

export function getClaudeCodeCompatibleUserAgent(): string {
  return getClaudeCodeUserAgent("sdk-cli");
}

export function getClaudeCodeCompatibleStainlessPackageVersion(): string {
  return getClaudeCodeSdkVersion();
}

export function getClaudeCodeCompatibleStainlessRuntimeVersion(): string {
  return getClaudeCodeRuntimeVersion();
}

const CONTEXT_1M_NATIVE_MODELS = ["claude-opus-5"];

export function modelHasNativeContext1m(model: string | null | undefined): boolean {
  const normalizedModel = String(model || "")
    .trim()
    .toLowerCase()
    .replace(/-\d{8}$/, "");

  return CONTEXT_1M_NATIVE_MODELS.some(
    (supported) => normalizedModel === supported || normalizedModel.startsWith(`${supported}-`)
  );
}
