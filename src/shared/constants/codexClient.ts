// Tested protocol-compatibility version for the Codex OAuth/Responses flow.
// This is deliberately not auto-updated to OpenAI's latest release. Overridable
// per deployment through CODEX_CLIENT_VERSION after local compatibility testing.
export const DEFAULT_CODEX_CLIENT_VERSION = "0.153.4";
export const CODEX_CLI_RS_ORIGINATOR = "codex_cli_rs";

export function getCodexCliRsHeaders(
  version = DEFAULT_CODEX_CLIENT_VERSION
): Record<string, string> {
  return {
    "User-Agent": `${CODEX_CLI_RS_ORIGINATOR}/${version}`,
    originator: CODEX_CLI_RS_ORIGINATOR,
  };
}
