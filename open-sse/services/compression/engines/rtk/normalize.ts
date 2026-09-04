/**
 * RTK Input Normalization Layer
 *
 * Provides safe transport decoding, UTF-8 BOM removal, CRLF to LF normalization,
 * standalone CR handling (progress redrawing e.g. run-tests.php), and ANSI stripping.
 */

const ANSI_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export interface RtkNormalizedText {
  /** Text normalized with LF line endings and leading BOM stripped */
  text: string;
  /** Whether a leading UTF-8 BOM was detected and stripped */
  hasBom: boolean;
  /** Whether the original text contained CRLF line endings */
  hasCrlf: boolean;
  /** Whether the original text contained standalone CR characters */
  hasStandaloneCr: boolean;
}

export function stripAnsiCodes(text: string): string {
  if (!text) return "";
  return text.replace(ANSI_REGEX, "");
}

export function normalizeTransport(input: unknown): RtkNormalizedText {
  if (typeof input !== "string") {
    return {
      text: input == null ? "" : String(input),
      hasBom: false,
      hasCrlf: false,
      hasStandaloneCr: false,
    };
  }

  let text = input;
  let hasBom = false;
  if (text.charCodeAt(0) === 0xfeff) {
    hasBom = true;
    text = text.slice(1);
  }

  const hasCrlf = text.includes("\r\n");
  const hasStandaloneCr = !hasCrlf && text.includes("\r");

  // Normalize CRLF -> LF
  text = text.replace(/\r\n/g, "\n");

  return {
    text,
    hasBom,
    hasCrlf,
    hasStandaloneCr,
  };
}

/**
 * Normalizes terminal progress redrawn with standalone CR (\r) into distinct LF lines.
 */
export function normalizeProgressCr(text: string): string {
  if (!text) return "";
  return text.replace(/\r/g, "\n");
}
