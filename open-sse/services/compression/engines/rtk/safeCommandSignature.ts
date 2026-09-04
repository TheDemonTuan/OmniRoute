const SAFE_SUBCOMMANDS: Record<string, Record<string, true>> = {
  cargo: { build: true, check: true, clippy: true, test: true, run: true, fmt: true },
  mvn: { compile: true, test: true, package: true, verify: true, install: true, clean: true },
  mvnw: { compile: true, test: true, package: true, verify: true, install: true, clean: true },
  mvnd: { compile: true, test: true, package: true, verify: true, install: true, clean: true },
  npm: { test: true, run: true, install: true, audit: true, build: true },
  git: { diff: true, status: true, log: true, show: true, branch: true },
  ctest: {},
  tsc: {},
};

export function buildSafeCommandSignature(command?: string | null, family?: string | null): string {
  const normalizedFamily =
    (family || "tool-output").replace(/[^A-Za-z0-9_-]+/g, "_") || "tool-output";
  if (!command) return normalizedFamily;

  // Remove simple POSIX environment assignments before considering executable/subcommand.
  const tokens = command
    .trim()
    .split(/\s+/)
    .filter((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
  if (tokens.length === 0) return normalizedFamily;
  const executable = tokens[0]
    .replace(/^\.\//, "")
    .replace(/\\/g, "/")
    .replace(/.*\//, "")
    .replace(/\.cmd$/i, "")
    .toLowerCase();
  const permitted = SAFE_SUBCOMMANDS[executable];
  if (permitted === undefined) return normalizedFamily;
  if (Object.keys(permitted).length === 0) return executable;

  const subcommand = tokens.slice(1).find((token) => !token.startsWith("-"));
  return subcommand && permitted[subcommand] ? `${executable} ${subcommand}` : executable;
}
