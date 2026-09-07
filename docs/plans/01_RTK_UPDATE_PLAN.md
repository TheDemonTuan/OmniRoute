# OmniRoute RTK Update Plan — Stable Parity Baseline v0.47.0

**Repository:** `TheDemonTuan/OmniRoute`  
**Target branch reviewed:** `prod`  
**Audit date:** 2026-09-04  
**Upstream baseline:** `rtk-ai/rtk v0.47.0` (stable; released 2026-09-02, changelog dated 2026-09-01)  
**Do not baseline against:** `0.48.0-rc.*` / unreleased master-only behavior  
**Primary goal:** Bring OmniRoute's RTK-inspired engine materially closer to upstream stable behavior while preserving OmniRoute's declarative JSON-filter architecture, fail-open behavior, raw-output recovery, and stacked-pipeline integration.

---

## 1. Executive decision

Do **not** vendor or copy the upstream Rust RTK binary into OmniRoute.

OmniRoute already has a useful independent architecture:

- `commandDetector.ts`
- `filterLoader.ts`
- `filterSchema.ts`
- JSON filter packs under `engines/rtk/filters/`
- `grouper.ts`
- `smartTruncate.ts`
- `deduplicator.ts`
- `rawOutput.ts`
- `discover.ts`
- `learn.ts`
- `tomlCompatibility.ts`
- `verify.ts`
- renderers and pipeline integration

The correct update strategy is:

1. Track upstream stable behavior.
2. Port **semantics and regression cases**, not implementation language.
3. Add missing command families only where OmniRoute can safely recognize and compress them.
4. Keep passthrough/fail-open as the default when recognition is ambiguous.
5. Benchmark OmniRoute itself rather than repeating upstream headline savings as OmniRoute results.

---

## 2. Current OmniRoute state

### 2.1 Current filter catalog

The current `prod` tree contains **55 built-in JSON filter packs**, not 49.

Current packs include:

- AWS
- Biome
- ESLint
- TypeScript
- Vite
- Webpack
- Bundler
- Composer
- curl / wget
- df / du / ps
- Docker build/logs/ps
- .NET
- gcloud
- GitHub CLI
- git branch/diff/log/status
- golangci-lint
- Gradle
- JSON output
- kubectl
- make
- mypy
- npm audit/install
- Nx
- pip
- Playwright
- Poetry
- Prettier
- rsync
- RuboCop
- Ruff
- shell find/grep/ls
- SSH
- systemctl
- Terraform / OpenTofu
- Cargo / Go / Jest / Pytest / Vitest
- Turbo
- uv sync
- generic output / stacktrace

### 2.2 Documentation drift

Several OmniRoute docs/forks still describe a 49-filter catalog.

**Required change:** never hard-code the filter count again.

Generate or derive the count from the filter loader/catalog during:

- docs generation,
- build metadata,
- test assertions,
- or a small script used by docs CI.

### 2.3 Strong parts to preserve

Keep these characteristics:

- custom filter trust gate;
- project/global/built-in precedence;
- inline filter verification;
- raw-output retention with secret redaction;
- no-op/passthrough for unsafe or structured modes;
- command-aware dispatch rather than global regex rewriting;
- pipeline integration with RTK as a standalone or stacked engine.

---

## 3. Upstream stable gaps to close

### P0 — v0.47.0 feature additions

Upstream v0.47.0 adds:

1. `ctest` compact output filter.
2. `mvnd` / Maven Daemon support.
3. `phpt` / PHP `run-tests.php` support.

OmniRoute's current filter directory does not contain dedicated:

- `ctest.json`
- `maven.json` / `mvnd.json`
- `test-phpt.json`

These are the first new command families to implement.

### P0 — v0.47.0 correctness regressions

The most important upstream changes are correctness fixes, especially around diffs and overly broad command matching.

Port the behavioral test cases for:

- UTF BOM handling/fallback.
- `git diff` quoted paths.
- `git diff` hunk boundary termination.
- classic hunk header fallback.
- preservation of `+` / `-` markers at column 0.
- word-diff passthrough.
- correct path-pair parsing.
- singular/plural truncated-line accounting.
- narrow matching for commands similar to Spring Boot / Liquibase / SSH.
- grep option handling where applicable to OmniRoute's parser/matcher.
- no accidental compression of unsupported command variants.

### P1 — stable command coverage parity audit

Upstream's current documented catalog is much broader than OmniRoute's 55 packs.

Build a machine-readable parity matrix for at least these families:

| Family                          | OmniRoute status                            | Action                                           |
| ------------------------------- | ------------------------------------------- | ------------------------------------------------ |
| `ls`                            | existing                                    | regression audit                                 |
| smart file read / signatures    | partial / architecture differs              | evaluate; do not force into filter DSL if unsafe |
| `grep` / `rg`                   | existing                                    | option + grouping audit                          |
| standalone `diff`               | not clearly dedicated                       | add only if safe                                 |
| `git status/log/diff`           | existing                                    | P0 regression hardening                          |
| `git add/commit/push/pull`      | no dedicated packs                          | P1                                               |
| GitHub CLI                      | existing                                    | coverage audit                                   |
| Jest/Vitest/Playwright/Pytest   | existing                                    | regression audit                                 |
| PHPT                            | missing                                     | P0                                               |
| Go/Cargo test                   | existing                                    | regression audit                                 |
| Rake/Minitest                   | missing                                     | P1                                               |
| RSpec                           | missing                                     | P1                                               |
| generic `err` / `test` wrappers | architecture mismatch                       | P2 / optional                                    |
| ESLint/Biome/TS/Prettier        | existing                                    | regression audit                                 |
| Next.js build                   | missing dedicated pack                      | P1                                               |
| Cargo build/clippy              | test pack exists, build/lint parity unclear | P1                                               |
| Ruff/golangci/RuboCop           | existing                                    | regression audit                                 |
| Maven/mvnd                      | missing                                     | P0                                               |
| SBT                             | missing                                     | P1                                               |
| pnpm list                       | missing                                     | P1                                               |
| Prisma                          | missing                                     | P1                                               |
| AWS                             | existing                                    | subcommand fidelity audit                        |
| Docker                          | partial                                     | add images/compose only if safe                  |
| OpenShift `oc`                  | missing                                     | P2                                               |
| Pulumi                          | missing                                     | P2                                               |

### P2 — do not prematurely chase 0.48 RC

Upstream prerelease currently contains Bun/Deno work.

Create a watchlist entry but do not ship Bun/Deno parity as part of the v0.47.0 stable milestone unless:

- 0.48 becomes stable before implementation merges, and
- the team intentionally rebases the baseline.

---

## 4. Architecture changes

### 4.1 Add upstream tracking metadata

Create:

`open-sse/services/compression/engines/rtk/upstream.ts`

Suggested shape:

```ts
export const RTK_UPSTREAM_BASELINE = {
  project: "rtk-ai/rtk",
  stableTag: "v0.47.0",
  auditedAt: "2026-09-04",
  license: "Apache-2.0",
  parityScope: "behavioral-semantic",
} as const;
```

Do not use this to imply binary/API compatibility.

Use it for:

- diagnostics,
- docs generation,
- parity tests,
- future update audits.

### 4.2 Add parity manifest

Create:

`open-sse/services/compression/engines/rtk/parityManifest.ts`

Each entry should contain:

```ts
{
  family: "ctest",
  status: "supported" | "partial" | "passthrough" | "not-planned",
  filterIds: ["test-ctest"],
  upstreamSince: "0.47.0",
  notes: "...",
}
```

The manifest should become the source for:

- docs coverage table,
- unit assertions,
- diagnostics endpoint if desired.

### 4.3 Keep the JSON DSL data-first

Do not add one-off TypeScript branches for every new command.

Add engine code only when the DSL cannot represent a correctness requirement.

Preferred order:

1. express in filter JSON;
2. extend filter schema generically;
3. add renderer/helper;
4. only then add command-specific engine code.

---

## 5. Implementation tasks by file

## Phase A — baseline + regression harness

### Modify

`open-sse/services/compression/engines/rtk/verify.ts`

Add:

- golden fixture support;
- explicit `passthroughExpected`;
- optional expected matched filter ID;
- assertions for preservation of exact prefixes/markers;
- negative-match cases.

### Add

`tests/unit/compression/rtk-upstream-v047-regressions.test.ts`

Cases:

- BOM-prefixed JSON/tool output.
- malformed JSON after BOM => fail open.
- quoted git paths with spaces.
- quoted/escaped paths.
- multiple diff hunks.
- hunk ending at declared length.
- context adjacent to hunk.
- `--word-diff` => passthrough.
- lines beginning with `++foo` and `--bar` preserved correctly.
- unknown diff format => passthrough, not mangled.
- false-positive SSH-like text.
- generic logs containing words that resemble tool names.

### Add

`tests/unit/compression/rtk-parity-manifest.test.ts`

Assert:

- all manifest `filterIds` exist;
- all built-in JSON packs are represented by at least one parity family/category;
- no duplicate filter IDs;
- docs count derives from loader output.

---

## Phase B — add v0.47.0 command families

### Add `ctest`

File:

`open-sse/services/compression/engines/rtk/filters/test-ctest.json`

Recognition must support common forms:

- `ctest`
- `ctest --output-on-failure`
- `cmake --build ... && ctest ...` only if composite command splitting already proves the second command safely

Preserve:

- failed test name;
- test number if present;
- command / executable path when reported;
- failure output;
- final pass/fail summary;
- total duration when short.

Collapse:

- individual passing tests;
- progress spam;
- repeated boilerplate.

Never compress if:

- output shape is not recognizably CTest;
- user requested a raw/listing mode that changes semantics.

### Add Maven / mvnd

Prefer one family with aliases rather than duplicate logic.

Suggested file:

`open-sse/services/compression/engines/rtk/filters/maven.json`

Match:

- `mvn`
- `mvnw`
- `./mvnw`
- `mvnd`

Preserve:

- `[ERROR]`;
- compilation errors;
- failed modules;
- test failures;
- reactor summary;
- BUILD SUCCESS / FAILURE;
- relevant cause chain.

Collapse:

- download/progress noise;
- repetitive INFO lines;
- repeated plugin boilerplate.

Be conservative for:

- dependency tree output;
- effective POM;
- help/evaluate commands;
- structured plugin output.

### Add PHPT

File:

`open-sse/services/compression/engines/rtk/filters/test-phpt.json`

Recognize:

- `run-tests.php`
- `php run-tests.php`
- `rtk phpt`-equivalent output shapes

Preserve:

- FAIL / XFAIL / BORK / LEAK / WARN / SKIP reasons as appropriate;
- failing test path;
- diff or expected-vs-actual snippet;
- summary counts.

Collapse:

- passing test rows;
- progress separators;
- repeated environment header.

Do not claim upstream's `-99%` result as OmniRoute savings until OmniRoute benchmark reproduces it.

---

## Phase C — git diff hardening

### Modify

`open-sse/services/compression/engines/rtk/filters/git-diff.json`

and, only if needed:

- `grouper.ts`
- `lineFilter.ts`
- `smartTruncate.ts`
- renderer under `renderers/`

Required invariants:

1. A compressed diff must never turn an addition into context or a deletion into context.
2. `+` and `-` content markers stay in column 0.
3. `+++` / `---` file headers are distinguishable from content.
4. quoted file paths decode or remain byte-safe; never invent a path.
5. unsupported word-diff formats pass through.
6. hunk truncation cannot splice unrelated hunks.
7. binary diffs pass through or emit a safe one-line binary-change summary only when confidently parsed.
8. combined/merge diffs pass through unless explicitly supported.
9. rename/copy metadata must remain understandable.
10. "no newline at end of file" marker must not be attached to the wrong line.

### Add fixtures

`tests/unit/compression/fixtures/rtk/git-diff/`

Files:

- `quoted-paths.txt`
- `multiple-hunks.txt`
- `word-diff.txt`
- `binary-diff.txt`
- `rename.txt`
- `markers-at-column-zero.txt`
- `truncated-hunk.txt`
- `malformed-diff.txt`

---

## Phase D — matcher hardening

### Modify

`commandDetector.ts`

Goals:

- normalize executable token safely;
- preserve subcommand boundaries;
- do not match arbitrary prose;
- distinguish `ssh` command from logs mentioning SSH;
- distinguish `mvn`/`mvnd`;
- detect `ctest`;
- detect PHPT runner;
- keep composite command behavior explicit.

### Modify

`splitCompositeCommand.ts`

Add tests for:

- `&&`
- `||`
- `;`
- pipelines
- quoted shell strings
- PowerShell separators where current parser supports them

Never split inside:

- quoted strings;
- heredoc-like payloads if unsupported;
- JSON string values.

### Add negative fixtures

`tests/unit/compression/fixtures/rtk/negative/`

Examples:

- README text mentioning `ssh`.
- Spring Boot log line containing a command-like word.
- Liquibase text in generic log.
- JSON string containing `"ctest --output-on-failure"`.

Expected: no command-family match.

---

## Phase E — high-value stable coverage

After P0 is green, add P1 packs in small commits:

1. `test-rspec.json`
2. `test-rake.json`
3. `sbt.json`
4. `next-build.json`
5. `pnpm-list.json`
6. `prisma.json`
7. git mutation summaries (`git-add`, `git-commit`, `git-push`, `git-pull`) if OmniRoute sees the post-command output reliably
8. Docker images/compose, if output shapes are well-defined

Each new pack must have:

- positive inline tests;
- negative tests;
- one "do not compress structured/raw mode" test when relevant;
- one error-preservation test;
- one low-gain test proving it can bail out.

---

## 6. Raw-output recovery changes

Keep current `rawOutput.ts`, but add regression coverage for new command families.

Required behavior:

- save raw only under configured policy;
- redact secrets before persistence;
- pointer metadata must not contain raw command arguments that may include secrets;
- failed compression / validation still has a safe recovery path;
- never overwrite an existing pointer;
- cleanup/retention remains bounded.

Add:

`tests/unit/compression/rtk-raw-output-v047.test.ts`

Cover:

- CTest failure.
- Maven auth/download error with fake credential.
- PHPT failure containing path/user data.
- redaction before persistence.

---

## 7. Discover / learn behavior

### `discover.ts`

Do not simply advertise every upstream command.

Report:

- observed command family;
- supported / partial / passthrough;
- estimated opportunity;
- sample count;
- no raw arguments.

### `learn.ts`

If a command is unsupported:

- propose a local filter scaffold only when enough samples exist;
- never auto-enable unsafe regex rules;
- keep project filters trust-gated.

Add manifest-aware hint:

- if upstream supports a family but OmniRoute does not, mark it as a known parity gap;
- if upstream stable does not support it, mark it as custom/experimental.

---

## 8. TOML compatibility

`tomlCompatibility.ts` should remain compatibility-only.

Do not attempt to implement every upstream TOML option.

Document supported translation subset explicitly.

Add tests for:

- unknown upstream key => ignored with diagnostic, not silently reinterpreted;
- incompatible key => warning;
- supported exclusion/matching option => deterministic mapping.

---

## 9. Telemetry / diagnostics

Add non-sensitive metrics:

- `rtk.filter_id`
- `rtk.family`
- `rtk.matched`
- `rtk.passthrough_reason`
- `rtk.fallback_applied`
- `rtk.original_tokens_est`
- `rtk.compressed_tokens_est`
- `rtk.savings_ratio`
- `rtk.raw_pointer_created`
- `rtk.validation_failure`

Do not record:

- full shell command;
- path arguments;
- environment variables;
- source code;
- raw output.

Use metrics to find:

- high-frequency passthrough families;
- filters with low savings;
- filters with high fallback/validation failure.

---

## 10. Benchmark plan

Create:

`tests/benchmarks/compression/rtk/`

Corpus categories:

- git status/log/diff
- CTest
- Maven/mvnd
- PHPT
- Jest/Vitest/Pytest
- Go/Cargo
- TypeScript/ESLint
- Docker
- kubectl
- AWS
- grep/find/ls
- generic logs
- malformed/ambiguous outputs

Report per case:

- input bytes;
- output bytes;
- estimated input tokens;
- estimated output tokens;
- savings;
- matched filter;
- validation/fidelity pass;
- fallback;
- runtime ms.

Headline metrics:

- median eligible savings;
- p25/p75 eligible savings;
- aggregate corpus savings;
- passthrough rate;
- false-positive rate;
- fidelity pass rate;
- p95 runtime.

**Release gate:**

- zero known semantic corruption;
- false-positive rate on negative corpus = 0;
- fidelity gate = 100% for protected fields;
- p95 engine overhead stays within an agreed budget.

---

## 11. Documentation changes

Update:

- `README.md`
- `docs/compression/RTK_COMPRESSION.md`
- `docs/compression/COMPRESSION_ENGINES.md`
- `docs/compression/COMPRESSION_GUIDE.md`
- `THIRD_PARTY_NOTICES.md` if attribution wording changes

Required wording:

- "RTK-inspired / behavior-tracked" rather than "drop-in compatible."
- Current upstream stable baseline.
- Generated built-in filter count.
- Clear distinction between upstream savings and OmniRoute benchmark.
- Raw-output privacy behavior.
- Known parity gaps.
- 0.48 prerelease watchlist, not stable support.

Remove stale hard-coded:

- `49 filters`
- any claim that implies all `100+` upstream commands are implemented.

---

## 12. CI / release gates

Add scripts:

- `scripts/check-rtk-filter-count.ts`
- `scripts/check-rtk-parity.ts`

CI must fail when:

- built-in filter count and generated docs disagree;
- manifest references missing filters;
- a filter lacks tests;
- duplicate filter IDs exist;
- regex cannot compile;
- negative match fixture is compressed;
- v0.47 regression suite fails.

Optional scheduled upstream watcher:

- query latest stable RTK release;
- compare to `RTK_UPSTREAM_BASELINE`;
- open an issue/change report only;
- do not auto-port behavior.

---

## 13. Suggested commit sequence

1. `test(rtk): add v0.47 regression fixtures`
2. `chore(rtk): add upstream baseline and parity manifest`
3. `fix(rtk): harden git diff semantics`
4. `fix(rtk): tighten command matching and BOM fallback`
5. `feat(rtk): add ctest filter`
6. `feat(rtk): add maven and mvnd filter`
7. `feat(rtk): add phpt filter`
8. `feat(rtk): add stable high-value missing families`
9. `docs(rtk): generate coverage and remove stale filter count`
10. `bench(rtk): publish OmniRoute-specific fidelity/savings results`

This sequence keeps correctness ahead of feature count.

---

## 14. Definition of Done

RTK update is complete when:

- [ ] Baseline metadata pins upstream stable `v0.47.0`.
- [ ] Current built-in filter count is generated, not hand-written.
- [ ] CTest supported with positive + negative tests.
- [ ] Maven/mvnd supported with error-preserving tests.
- [ ] PHPT supported with failure-preserving tests.
- [ ] v0.47 diff regression corpus passes.
- [ ] BOM/malformed structured input fails open.
- [ ] Broad matcher false positives are covered by negative fixtures.
- [ ] Parity manifest exists and is CI-validated.
- [ ] Raw output recovery/redaction tests pass for new families.
- [ ] Benchmark reports fidelity and savings separately.
- [ ] Docs distinguish upstream RTK results from OmniRoute results.
- [ ] 0.48 RC features remain explicitly marked as watchlist unless rebased to a stable release.
- [ ] Full compression test suite passes.

---

## 15. Upstream references audited

- OmniRoute RTK source:
  - https://github.com/TheDemonTuan/OmniRoute/tree/prod/open-sse/services/compression/engines/rtk
  - https://github.com/TheDemonTuan/OmniRoute/tree/prod/open-sse/services/compression/engines/rtk/filters
- RTK upstream:
  - https://github.com/rtk-ai/rtk
  - https://github.com/rtk-ai/rtk/releases

**Important:** Upstream source and release notes are reference behavior, not a license or compatibility statement for OmniRoute's independent implementation.
