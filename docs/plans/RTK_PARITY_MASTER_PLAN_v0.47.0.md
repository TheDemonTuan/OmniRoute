# OmniRoute RTK Parity Master Plan — v0.47.0

**Target repository:** `TheDemonTuan/OmniRoute`  
**Target branch:** `prod`  
**Audit date:** 2026-09-04  
**Upstream:** `rtk-ai/rtk`  
**Stable baseline:** `v0.47.0`  
**Goal:** Make OmniRoute's RTK-inspired compression engine behave as closely and safely as practical to RTK v0.47.0, while remaining native to OmniRoute's TypeScript/proxy architecture.

---

# 0. What "RTK parity" means

The target is **behavioral and semantic parity**, not source-code parity.

For every supported command family:

1. Detect the same useful command/output class.
2. Preserve the same actionable information.
3. Drop/collapse the same classes of noise where practical.
4. Respect the same important passthrough modes.
5. Preserve failures and diagnostics before optimizing savings.
6. Fail open to original output whenever parsing is ambiguous.
7. Match upstream truncation semantics where they matter for correctness.
8. Match upstream flag semantics where the command is known.
9. Keep raw-output recovery available for lossy compression.
10. Measure OmniRoute's own savings/fidelity instead of borrowing upstream benchmark numbers.

Do **not** require byte-identical output unless a test explicitly defines that as the desired contract.

---

# 1. Non-negotiable design principles

## 1.1 Fidelity beats token savings

Priority order:

1. semantic correctness;
2. actionable failures;
3. user-requested command semantics;
4. safe recovery;
5. compactness.

A 0% saving passthrough is preferable to a 90% saving that removes a diagnostic.

## 1.2 Fail open

Any stateful parser must return original normalized output when:

- framing is inconsistent;
- command mode is unsupported;
- parser confidence is below threshold;
- a required failure block cannot be attributed safely;
- output is truncated before enough structure is observed;
- output shape conflicts with the expected family.

## 1.3 Stateless vs stateful must be explicit

Use JSON filter packs for stateless transformations.

Use TypeScript processors for output that has blocks, phases, ownership, hunks, or cross-line state.

### Stateless examples

- simple `ls` post-processing;
- simple grep result grouping;
- simple package-manager chatter;
- repeated log prefixes;
- obvious success boilerplate.

### Stateful examples

- CTest;
- Maven/Surefire/mvnd lanes;
- PHPT failure + diff blocks;
- git diff hunks;
- rich/pretty TypeScript diagnostics when multiline context is preserved.

## 1.4 Command-aware decisions are stronger than output heuristics

When OmniRoute has the exact command:

- parse flags;
- select mode;
- honor passthrough modes precisely.

When OmniRoute only has output:

- require higher-confidence framing;
- never infer destructive transformations from a single generic line such as `[ERROR]`.

---

# 2. Current architecture to keep

Keep these existing modules:

```text
open-sse/services/compression/engines/rtk/
├── commandDetector.ts
├── configSchema.ts
├── deduplicator.ts
├── discover.ts
├── filterLoader.ts
├── filterSchema.ts
├── grouper.ts
├── index.ts
├── learn.ts
├── lineFilter.ts
├── parityManifest.ts
├── rawOutput.ts
├── smartTruncate.ts
├── splitCompositeCommand.ts
├── tomlCompatibility.ts
├── verify.ts
├── filters/
└── renderers/
```

Do not rewrite the whole engine.

Add a processor layer between filter selection and generic line filtering.

---

# 3. Target architecture

```text
                       input
                         │
                         ▼
                 normalize transport
          ANSI / CRLF / BOM / safe decode
                         │
                         ▼
                 exact command parse
                         │
                         ▼
                command/output detect
                         │
                         ▼
                  filter selection
                         │
              ┌──────────┴──────────┐
              │                     │
              ▼                     ▼
      command-mode policy      output-only policy
              │                     │
              └──────────┬──────────┘
                         ▼
                 execution strategy
                         │
              ┌──────────┴───────────┐
              │                      │
              ▼                      ▼
       JSON/stateless DSL     Stateful processor
                               CTest / Maven /
                               PHPT / Git Diff /
                               optional TSC
              │                      │
              └──────────┬───────────┘
                         ▼
                integrity validation
                         │
                         ▼
                  gain/safety gate
                         │
                         ▼
              processor-aware truncation
                         │
                         ▼
               raw recovery metadata
                         │
                         ▼
                     result
```

---

# 4. New core processor API

Create:

`open-sse/services/compression/engines/rtk/processors/types.ts`

```ts
export type RtkProcessorId = "ctest" | "maven" | "phpt" | "git-diff" | "typescript";

export type RtkProcessorStatus = "compressed" | "passthrough" | "unrecognized" | "invalid";

export interface RtkProcessorContext {
  command: string | null;
  normalizedCommand: string | null;
  stdout: string;
  stderr?: string;
  maxLines?: number;
  rawRecoveryEnabled: boolean;
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
```

Create:

`open-sse/services/compression/engines/rtk/processors/index.ts`

Responsibilities:

- processor registry;
- dispatch by filter/processor id;
- catch processor exceptions;
- fail open on exception;
- return diagnostics without raw sensitive content.

---

# 5. Extend the filter schema

Modify:

`filterSchema.ts`

Add optional fields:

```ts
processor?: RtkProcessorId;

commandPolicy?: {
  passthroughPatterns?: string[];
  supportedPatterns?: string[];
  requireKnownCommand?: boolean;
};

safety?: {
  minimumConfidence?: number;
  ownsTruncation?: boolean;
  preserveOriginalOnUnknownMode?: boolean;
};
```

Example:

```json
{
  "id": "test-ctest",
  "processor": "ctest",
  "match": {
    "outputTypes": ["test-ctest"],
    "commands": ["^ctest\\b"],
    "patterns": ["^Test project\\b"]
  },
  "commandPolicy": {
    "passthroughPatterns": [
      "(?:^|\\s)-(?:V|VV)(?:\\s|$)",
      "(?:^|\\s)--verbose(?:\\s|$)",
      "(?:^|\\s)-N(?:\\s|$)",
      "(?:^|\\s)--show-only(?:\\s|$)",
      "(?:^|\\s)--help(?:\\s|$)",
      "(?:^|\\s)--version(?:\\s|$)"
    ]
  }
}
```

The JSON pack remains the registry/config object; the TypeScript processor owns cross-line semantics.

---

# 6. Normalize once, early

Create:

`open-sse/services/compression/engines/rtk/normalize.ts`

Responsibilities:

1. Strip a leading UTF-8 BOM where semantically safe.
2. Normalize CRLF to LF.
3. Preserve standalone CR information for processors that need it, or expose:
   - `normalizedLf`
   - `normalizedProgressLines`
4. Strip ANSI only when the selected processor/filter requests it.
5. Never mutate raw output stored for recovery before redaction.
6. Do not treat invalid JSON after BOM removal as valid structured data.

Tests:

```text
rtk-normalize.test.ts
├── UTF-8 BOM text
├── BOM JSON
├── malformed BOM JSON
├── CRLF
├── PHPT progress CR
├── ANSI failure
└── binary-ish/unusual unicode passthrough
```

---

# 7. Command parsing and mode classification

Refactor `commandDetector.ts` into two concepts:

```text
detectCommandFamily()
classifyCommandMode()
```

Do not let one generic content regex determine a specific tool family at high confidence.

## 7.1 Confidence model

Suggested:

### Exact command match

`+0.60`

### Strong framing marker

`+0.20`

### Second independent framing marker

`+0.15`

### Tool-specific summary

`+0.10`

### Generic error token

maximum `+0.05`

A single `[ERROR]` must never classify output as Maven.

## 7.2 Windows wrappers

Recognize:

- `mvnw.cmd`
- `gradlew.bat`
- `.\\mvnw.cmd`
- `.\\gradlew.bat`

where relevant.

## 7.3 Composite commands

`splitCompositeCommand.ts` must preserve quoted/semi-structured segments.

Regression cases:

```text
mvn test && echo done
ctest || cat Testing/Temporary/LastTest.log
printf "a && b"
powershell -Command "Write-Host 'a;b'"
git diff | head -100
```

Do not split separators inside quoted text.

---

# 8. P0 processor: CTest

Create:

`processors/ctest.ts`

## 8.1 Required upstream-parity behavior

The processor must support these concepts:

- derive run total from result lines;
- understand `--stop-on-failure`;
- disabled tests;
- forwarded/nested suites;
- validate result lines and final summary consistently;
- deduplicate retry/repeat result lines by test number + name;
- support wrapped result lines;
- preserve failure diagnostics;
- use raw `FAILED:` trailer when failure result parsing is incomplete;
- preserve meaningful error trailer if zero tests ran;
- support parallel `-j` output without assigning diagnostics to the wrong failure;
- bound failure detail;
- provide recovery hint/raw pointer if detail is truncated.

## 8.2 Passthrough modes

When exact command is known, bypass filtering for:

- `-V`
- `-VV`
- `--verbose`
- `-N`
- `--show-only`
- `--help`
- `--version`
- dashboard modes such as non-Test `-T` modes

Keep ordinary filtering for `-T Test` if behavior matches upstream.

## 8.3 State machine

Suggested model:

```text
Idle
 │
 ├─ Start line
 │
 ├─ Result(PASS) -> count/dedupe
 │
 ├─ Result(DISABLED/SKIP) -> count
 │
 └─ Result(FAIL/TIMEOUT/KILLED)
       │
       ▼
   FailureOpen
       │
       ├─ diagnostic line -> keep
       ├─ wrapped result -> fold
       ├─ next result -> close + process next
       ├─ summary -> close
       └─ EOF -> close safely
```

For parallel output, track failure ownership using stable identifiers only when confidence is high.

If ownership is ambiguous, preserve the diagnostic rather than dropping it.

## 8.4 Failure output bounds

Config:

```ts
maxFailuresShown;
maxLinesPerFailure;
maxTotalFailureLines;
```

When truncating:

```text
... +N more failure lines
raw: <recovery pointer>
```

Do not silently truncate failure detail.

## 8.5 CTest fixtures

Create:

`tests/unit/compression/fixtures/rtk/ctest/`

At minimum:

```text
all-pass.txt
mixed.txt
output-on-failure.txt
noisy-failure.txt
parallel-failure.txt
stop-on-failure.txt
disabled-tests.txt
repeat-until-pass.txt
nested-result.txt
wrapped-result.txt
forwarded-suite.txt
killed-suite.txt
failed-trailer.txt
zero-tests-with-error.txt
verbose-command.txt
show-only-command.txt
spoofed-framing.txt
malformed.txt
```

For every raw fixture, create expected semantic assertions; use exact golden expected output for stable formats.

---

# 9. P0 processor: Maven + mvnd

Create:

`processors/maven.ts`

Do not treat `mvnd` as a string alias only.

Use shared parsing/filter logic, but keep command identity because daemon output has lane/interleaving differences.

## 9.1 Supported executables

Recognize:

```text
mvn
./mvnw
mvnw
mvnw.cmd
.\mvnw.cmd
mvnd
```

## 9.2 Command modes

Implement:

```ts
type MavenMode = "test" | "compile" | "package" | "verify" | "install" | "passthrough";
```

### Compress

- test
- compile
- package
- verify
- install when normal lifecycle output

### Passthrough by default

- `dependency:tree`
- `dependency:list`
- `help:*`
- `help:effective-pom`
- `help:evaluate`
- plugin goals with unknown output contract
- user-requested verbose/debug output (`-X`, highly verbose diagnostic modes)
- commands whose primary output is structured/data rather than lifecycle logs

## 9.3 Preserve Maven signal

Must preserve:

- BUILD SUCCESS / FAILURE;
- reactor summary;
- project/module identity;
- failed modules;
- compile error head;
- `symbol:` continuation;
- `location:` continuation;
- source filename/line/column;
- Surefire/Failsafe failed test name;
- assertion failure;
- thrown exception;
- relevant stacktrace tail/head under configured cap;
- test failure count;
- elapsed durations;
- `Failed to execute goal`;
- multi-module resume hint;
- meaningful cause chain.

## 9.4 Drop Maven noise

May drop:

- repetitive download progress;
- plugin headers once context is established;
- repeated boilerplate;
- generic help boilerplate following a failure;
- duplicated `[INFO]` separators;
- redundant green module chatter.

Do **not** drop a line merely because it lacks `[ERROR]`.

## 9.5 Surefire failure trail

Model:

```text
Class/Test failure open
  ├─ failure header
  ├─ exception/assertion
  ├─ stack frames
  ├─ caused-by
  ├─ blank separator
  └─ close
```

Preserve bounded but actionable detail.

## 9.6 mvnd lane model

`mvnd` can interleave module-prefixed lines.

Create per-module lanes:

```ts
interface MavenLane {
  id: string;
  mode: MavenMode;
  failureTrailOpen: boolean;
  compileContinuationOpen: boolean;
  testBlockOpen: boolean;
}
```

Rules:

1. Strip lane prefix for classification.
2. Emit original line with lane/module identity preserved.
3. Unprefixed raw diagnostic lines:
   - route to a lane with active failure trail first;
   - then active compile continuation;
   - if exactly one candidate remains, attach;
   - if multiple candidates are plausible, preserve verbatim globally.
4. Never guess and then discard a diagnostic.

## 9.7 Maven fixtures

```text
maven/
├── compile-error.txt
├── compile-error-symbol-location.txt
├── test-failure-assertion.txt
├── test-error-exception.txt
├── surefire-stacktrace.txt
├── reactor-pass.txt
├── reactor-fail.txt
├── multi-module-resume.txt
├── mvnd-compile-error.txt
├── mvnd-test-fail.txt
├── mvnd-reactor-pass.txt
├── mvnd-reactor-fail.txt
├── mvnd-interleaved-lanes.txt
├── mvnd-ambiguous-raw-line.txt
├── dependency-tree.txt
├── effective-pom.txt
├── help-evaluate.txt
├── debug-mode.txt
└── malformed.txt
```

Hard requirement:
`dependency-tree.txt` must pass through without losing dependency entries.

---

# 10. P0 processor: PHPT

Create:

`processors/phpt.ts`

## 10.1 Upstream-parity constants

Start with:

```ts
MAX_FAILURES_SHOWN = 20;
MAX_DIFF_LINES_PER_FAILURE = 6;
```

Make configurable only if OmniRoute already exposes a safe engine config pattern.

## 10.2 Recognize statuses

Support:

```text
PASS
FAIL
SKIP
BORK
WARN
LEAK
XFAIL
XLEAK
```

Semantics:

- FAIL/BORK/LEAK count as broken/actionable.
- XFAIL/XLEAK are expected outcomes, not ordinary failures.
- SKIP should count but not flood output.
- WARN should be represented in summary.

## 10.3 Environment summary

Preserve compactly:

- PHP version;
- SAPI;
- OS.

Do not keep the entire environment header if it is redundant.

## 10.4 CR progress normalization

Serial `run-tests.php` can redraw progress with `\r`.

Before parsing:

```ts
stripAnsi(raw).replace(/\r/g, "\n");
```

but preserve original raw output separately for recovery.

## 10.5 DIFF block parser

Parse:

```text
========DIFF========
...
========DONE========
```

Associate the pending diff with the next relevant failing status.

Keep first 6 diff lines per failure.

If total > kept:

```text
... +N more diff lines
```

## 10.6 Failure cap

Keep first 20 actionable failures.

If more:

```text
... +N more failures
```

## 10.7 Fail-open rule

If output does not look like `run-tests.php`, return normalized original.

Example:

```text
Could not open input file: run-tests.php
```

must not become "no tests ran".

## 10.8 Optional execution-level parity

RTK injects `--show-diff` if the caller did not already request `--show-diff`/`--show-all`.

OmniRoute is a proxy and may not control command execution.

Therefore:

- if OmniRoute only receives output: do not invent a diff;
- if OmniRoute has a command-execution wrapper feature: optionally add a separate execution adapter that injects `--show-diff`;
- do not mix execution mutation into the pure output compressor.

## 10.9 PHPT fixtures

```text
phpt/
├── all-pass.txt
├── one-failure-with-diff.txt
├── long-diff.txt
├── 25-failures.txt
├── skip-xfail.txt
├── bork.txt
├── leak.txt
├── xleak.txt
├── warn.txt
├── serial-cr-progress.txt
├── no-tests.txt
├── startup-failure.txt
├── failed-test-summary-spoof.txt
├── truncated-before-detail.txt
└── malformed.txt
```

Hard assertions:

- expected and actual diff lines survive;
- exact test path survives;
- FAIL/BORK/LEAK survive;
- output truncation is disclosed;
- startup failure passes through.

---

# 11. P0 processor: Git Diff

Move semantic diff handling out of the generic line filter.

Create:

`processors/gitDiff.ts`

The JSON pack should become recognition/config only.

## 11.1 v0.47.0 parity contracts

Implement regression behavior for:

1. quoted path decoding;
2. header kind detection before path splitting;
3. declared hunk length;
4. context adjacent to hunk;
5. word-diff passthrough;
6. no guessing at path pairs;
7. reset hunk state on combined diff;
8. combined hunk bounded by all parents;
9. changed lines stay at column 0;
10. content beginning `++` / `--` is not dropped;
11. singular/plural truncation text;
12. classic hunk header fallback;
13. binary diff safe behavior;
14. rename/copy metadata;
15. `\ No newline at end of file` marker association.

## 11.2 Word-diff detection

Pass through on evidence of word-diff formats such as:

```text
[-old-]
{+new+}
```

Test each independently:

- addition only;
- deletion only;
- both.

Do not require both markers to be present.

## 11.3 Hunk accounting

Parse:

```text
@@ -oldStart,oldCount +newStart,newCount @@
```

Track consumed old/new lines.

Context:

- consumes both.

Deletion:

- consumes old only.

Addition:

- consumes new only.

Hunk ends when declared lengths are fulfilled, not when a heuristic blank/header happens to appear.

## 11.4 Combined diffs

When `@@@` combined hunk or `diff --cc` / `diff --combined` is detected:

- support only if the parser explicitly models all parents;
- otherwise passthrough.

Never reuse ordinary two-parent hunk state.

## 11.5 Diff fixtures

```text
git-diff/
├── simple.txt
├── quoted-paths.txt
├── escaped-paths.txt
├── multiple-hunks.txt
├── declared-hunk-length.txt
├── adjacent-context.txt
├── content-plus-plus.txt
├── content-minus-minus.txt
├── word-diff-add.txt
├── word-diff-delete.txt
├── word-diff-both.txt
├── combined-diff.txt
├── multi-parent-combined.txt
├── classic-diff.txt
├── binary-diff.txt
├── rename.txt
├── copy.txt
├── no-newline.txt
├── malformed-header.txt
└── truncated-input.txt
```

---

# 12. P0: matcher false-positive hardening

Upstream v0.47.0 tightened overly broad matching around Spring Boot, Liquibase and SSH.

OmniRoute must adopt the same principle globally.

## 12.1 Specific rule

A tool-specific family should require either:

- exact command-family match; or
- two independent, high-specificity output markers.

Never classify a family from:

- one generic error prefix;
- one generic "connection failed";
- one ordinary prose line mentioning the tool name.

## 12.2 Maven current problem

Remove generic Maven content evidence:

```text
^[ERROR]
```

as a standalone family classifier.

It may contribute weak confidence only after another Maven-specific marker exists.

## 12.3 SSH

Require:

- known command `ssh ...`;
  or
- multiple SSH-specific framing/error markers.

A README sentence mentioning SSH is not SSH command output.

## 12.4 Negative fixture corpus

```text
negative/
├── prose-mentions-ssh.txt
├── spring-log-generic-error.txt
├── liquibase-word-in-log.txt
├── generic-bracket-error.txt
├── json-command-string.txt
├── markdown-shell-snippet.txt
├── chat-message-git-diff-words.txt
└── stacktrace-with-maven-word.txt
```

Expected:
no specific family compression unless command context explicitly says so.

---

# 13. P0: BOM and structured fallback

Upstream v0.47.0 fixed BOM handling across JSON/dependency/settings paths.

OmniRoute parity requirement:

1. Strip one leading UTF-8 BOM before JSON detection/parsing.
2. If JSON parses, route to JSON-aware behavior.
3. If JSON fails to parse:
   - preserve original text;
   - never drop parser diagnostics;
   - never produce an empty "compressed JSON" result.
4. BOM handling must not alter arbitrary mid-string BOM characters.

Tests:

```text
bom-json-valid.txt
bom-json-invalid.txt
bom-json-array.txt
bom-plain-text.txt
mid-string-bom.txt
```

---

# 14. P0/P1: grep and rg native flag semantics

Current OmniRoute shell-grep filter is output-oriented and does not model native flag collisions.

For parity where command is known:

## 14.1 Native grep

Do not repurpose:

- `-m`
- `-l`
- `-t`

as OmniRoute/RTK compression options.

They belong to the invoked tool semantics.

For GNU grep:

- `-m` = max count;
- `-l` = files with matches;
- unsupported native flags should behave as native command output dictates.

For ripgrep:

- `-t rust` is a file-type filter.

## 14.2 Format-altering flags

When command uses output modes that break normal grouped result parsing, passthrough.

At minimum evaluate:

```text
-c
-l
-L
-o
-Z
--json
```

and other flags that substantially change record shape.

## 14.3 Keep invoked engine identity

Do not transform `grep` into `rg` or vice versa.

The proxy compressor only filters output.

## 14.4 Tests

```text
grep -m 3 foo .
grep -l foo .
grep -t foo .
rg -t rust foo .
rg --json foo .
grep -c foo file
grep -o foo file
```

The test objective is not to emulate command execution, but to ensure OmniRoute does not apply an incompatible output filter.

---

# 15. P1: `ls` v0.47 semantics

Upstream v0.47.0 adds listing cap behavior and standard dotfile semantics.

Current OmniRoute `shell-ls` simply caps generic lines with `maxLines`.

Improve it.

## 15.1 Command mode

Understand:

- default `ls`
- `-a`
- `-A`
- long format
- human-readable
- recursive mode
- explicit paths

## 15.2 Dotfile semantics

Do not invent or remove entries contrary to the actual command output.

If OmniRoute only filters captured output:

- preserve what command emitted;
- grouping/capping must not mislabel dotfile entries as noise.

## 15.3 Truncation hint

When listing is capped, emit a compact explicit hint:

```text
... N entries omitted; raw output available at <pointer>
```

or OmniRoute equivalent.

Use tail information when valuable instead of blindly first-N only.

## 15.4 Avoid underflow/negative savings bugs

All saved-line/saved-token counters must use bounded arithmetic.

Tests:

- fewer rows than cap;
- exactly cap;
- cap + 1;
- large listing;
- `-A`;
- hidden dirs;
- explicit file args.

---

# 16. P1: TypeScript v0.47 diagnostics

Current `build-typescript.json` keeps only lines matching TypeScript error patterns.

That is insufficient for pretty/multiline diagnostics.

Upstream v0.47.0 includes fixes for:

- global diagnostics;
- failure head;
- pretty diagnostics;
- ANSI stripping before blank filtering;
- bounded failure dump.

## 16.1 Add processor or multiline-aware renderer

Preferred:

`processors/typescript.ts`

Support:

- ordinary one-line diagnostics;
- pretty diagnostics with source snippets/carets;
- global diagnostics without file location;
- summary counts;
- bounded multiline context.

## 16.2 Preserve

- TS error code;
- file path;
- line/column;
- full diagnostic message;
- global error head;
- enough pretty-code context to understand the failure.

## 16.3 Tests

```text
tsc-one-line.txt
tsc-pretty.txt
tsc-global-diagnostic.txt
tsc-many-errors.txt
tsc-ansi-pretty.txt
tsc-malformed.txt
```

---

# 17. Generic line-filter safety changes

Modify `lineFilter.ts`.

## 17.1 Current semantic hazard

`includePatterns` behaves as an allow-list.

That is dangerous for multiline diagnostics.

Add explicit rule mode:

```ts
includeMode?: "allowlist" | "boost-preserve";
```

Default legacy:
`allowlist`

New safer mode:
`boost-preserve`

But stateful tools should not rely on either.

## 17.2 Preserve blocks

Optional generic schema:

```ts
preserveBlocks?: Array<{
  start: string;
  end: string;
  maxLines?: number;
}>;
```

Only add if at least two existing filters benefit.

Do not use this as a substitute for CTest/Maven/PHPT state machines.

---

# 18. Processor-aware truncation

Modify `smartTruncate.ts`.

Rules:

1. If processor `ownsTruncation = true`, generic truncation must not cut its output again.
2. Protected failure blocks must not be split.
3. Recovery pointer/hint must survive.
4. Summary must survive.
5. If total output still exceeds hard global budget:
   - ask processor for a second tighter rendering;
   - otherwise use a safe head/summary/tail strategy with explicit truncation marker.

Add interface:

```ts
renderBudget?: {
  maxLines?: number;
  maxChars?: number;
  maxEstimatedTokens?: number;
}
```

A processor should render within the given budget rather than being chopped afterward.

---

# 19. Raw-output recovery security

Modify `rawOutput.ts`.

## 19.1 Never persist full unredacted command

Current metadata must not store raw argv that may contain:

- bearer tokens;
- API keys;
- basic auth;
- passwords;
- signed URLs;
- secrets in query params;
- secrets in env assignments.

Persist:

```json
{
  "family": "curl",
  "executable": "curl",
  "commandHash": "...",
  "safeSignature": "curl -H <redacted> <url-redacted>",
  "createdAt": "...",
  "expiresAt": "..."
}
```

## 19.2 Redaction applies to metadata too

Use one central redactor for:

- raw output;
- safe command signature;
- pointer metadata.

## 19.3 Filesystem permission

Where supported:

```text
0600
```

for raw and sidecar files.

## 19.4 Atomic write

Write temporary file then rename.

Do not leave half-written recovery files after crash.

## 19.5 Tests

```text
authorization-header
basic-auth-url
api-key-query
AWS-like secret
GitHub token-like secret
env TOKEN=...
Windows path
atomic-write-failure
retention-purge
```

Hard gate:
no known fixture secret may appear in `.log` or `.meta.json`.

---

# 20. Parity manifest redesign

Current `status: active/planned/deprecated` is not enough.

Change to:

```ts
interface RtkParityEntry {
  family: string;
  filterIds: string[];

  localStatus: "active" | "planned" | "deprecated";

  parity: "full" | "semantic" | "partial" | "passthrough" | "not-supported" | "not-applicable";

  upstreamSince?: string;
  auditedAgainst: string;
  gaps: string[];
  fixtureGroups: string[];
}
```

Example:

```ts
{
  family: "phpt",
  filterIds: ["test-phpt"],
  localStatus: "active",
  parity: "semantic",
  upstreamSince: "v0.47.0",
  auditedAgainst: "v0.47.0",
  gaps: [],
  fixtureGroups: ["phpt"]
}
```

Do not mark `full` merely because a filter exists.

---

# 21. Baseline metadata

Keep/add:

`upstream.ts`

```ts
export const RTK_UPSTREAM_BASELINE = {
  repo: "rtk-ai/rtk",
  stableTag: "v0.47.0",
  auditedAt: "2026-09-04",
  parityType: "behavioral-semantic",
  implementation: "independent-typescript",
  license: "Apache-2.0",
} as const;
```

Use in diagnostics and docs generation.

---

# 22. Upstream fixture strategy

RTK is Apache-2.0.

For maximum parity:

1. Prefer reproducing behavior using OmniRoute-owned fixture text.
2. When copying upstream fixture text or substantial test material:
   - retain required license/NOTICE attribution;
   - document origin in fixture README.
3. Do not blindly copy Rust implementation when a native TypeScript design is cleaner.
4. Upstream tests are the **behavior oracle**.

Create:

`tests/unit/compression/fixtures/rtk/UPSTREAM.md`

Track:

```text
fixture group
upstream tag
upstream commit
source file / PR
copied vs independently recreated
license note
```

---

# 23. Golden tests + semantic invariant tests

Use both.

## 23.1 Golden tests

Useful when rendering is intentionally close to upstream.

Example:

```text
input.raw.txt
expected.txt
```

## 23.2 Semantic invariant tests

More important for correctness.

Examples:

### Maven

- failing class name exists;
- compile `symbol:` exists;
- source location exists;
- `BUILD FAILURE` exists;
- dependency tree is unchanged in passthrough mode.

### PHPT

- path exists;
- diff expected/actual exists;
- broken count correct;
- truncation marker accurate.

### CTest

- failure test name exists;
- diagnostic exists;
- final count correct.

### Diff

- changed content exact;
- marker column exact;
- no hunk bleed.

---

# 24. Differential parity harness

Create:

`scripts/rtk-parity/`

Goal:
compare OmniRoute compressor to upstream RTK for a fixture corpus.

## 24.1 Modes

### Offline fixture mode

- feed same captured raw output to both transformations when upstream exposes a pure filter path or expected fixture exists;
- compare invariants.

### Execution mode

Optional CI/nightly:

- run real command fixtures in containers;
- capture output;
- run upstream `rtk`;
- run OmniRoute processor;
- compare semantic output.

Do not require execution mode on every PR if it is expensive/flaky.

## 24.2 Comparison dimensions

```text
required information preserved
forbidden/noise removed
failure count
summary count
paths
diagnostics
truncation disclosure
passthrough equality
```

Compute a parity report, not just string equality.

---

# 25. Filter count and docs generation

Never hard-code:

```text
49 filters
58 filters
```

Create:

`scripts/generate-rtk-docs.ts`

Generate:

- built-in filter count;
- supported family table;
- parity status;
- upstream baseline;
- known gaps.

Generated section markers:

```md
<!-- RTK_GENERATED_START -->

...
<!-- RTK_GENERATED_END -->
```

CI runs generator and fails if git diff is non-empty.

---

# 26. Remove misleading benchmark math

Do not state:

```text
RTK average 80%
Caveman 46%
stacked = 89.2%
```

as OmniRoute measured performance.

For RTK docs, separate:

## Upstream reference

"Upstream RTK reports savings for specific commands/datasets."

## OmniRoute measured

Generated from OmniRoute benchmark corpus.

Never multiply independent upstream percentages into an "average."

---

# 27. Benchmark corpus

Create:

`tests/benchmarks/compression/rtk/`

Required families:

```text
git-diff
ctest
maven
mvnd
phpt
typescript
grep-rg
ls
jest
vitest
pytest
cargo
go
eslint
docker
kubectl
aws
generic-errors
negative-detection
structured-json
```

For each case record:

```json
{
  "family": "maven",
  "case": "compile-error",
  "eligible": true,
  "matched": true,
  "passthrough": false,
  "inputBytes": 0,
  "outputBytes": 0,
  "inputTokensEstimated": 0,
  "outputTokensEstimated": 0,
  "savingsRatio": 0,
  "fidelityPass": true,
  "runtimeMs": 0
}
```

Headline:

- fidelity pass rate;
- false-positive rate;
- eligible median savings;
- aggregate savings;
- passthrough rate;
- p95 runtime;
- raw-recovery rate.

Savings are secondary to fidelity.

---

# 28. Hard release gates

A release claiming v0.47 parity must meet:

```text
100% P0 semantic invariant tests
100% secret redaction fixture pass
0 known false-positive compressions in negative corpus
0 known failure-diagnostic corruption
0 unsupported-mode lossy compression
100% manifest/filter consistency
100% docs generation consistency
all processors fail open on malformed framing
```

Performance gate:

- define target after baseline;
- processor p95 overhead must remain small relative to proxy request latency;
- no regex catastrophic backtracking.

---

# 29. CI scripts

Add:

```text
scripts/check-rtk-parity.ts
scripts/check-rtk-filters.ts
scripts/generate-rtk-docs.ts
scripts/check-rtk-secrets.ts
```

## `check-rtk-filters.ts`

Validate:

- unique IDs;
- valid regex;
- every active filter represented in manifest;
- every manifest filter exists;
- every stateful filter references a registered processor;
- every processor has fixture coverage;
- no orphan processor.

## `check-rtk-parity.ts`

Fail when:

- `parity=full|semantic` has non-empty P0 gaps;
- baseline tag differs from generated docs;
- required fixture group missing.

## `check-rtk-secrets.ts`

Generate secret-like fake data and assert persisted recovery artifacts contain no secret.

---

# 30. Telemetry

Safe fields:

```text
rtk.family
rtk.filter_id
rtk.processor
rtk.command_mode
rtk.match_confidence
rtk.passthrough_reason
rtk.fallback_reason
rtk.input_tokens_est
rtk.output_tokens_est
rtk.savings_ratio
rtk.raw_recovery_created
rtk.integrity_failure
rtk.processing_ms
```

Do not record:

- full command;
- arguments;
- file paths unless safely normalized/hashed;
- environment variables;
- source lines;
- raw diagnostics;
- raw output.

---

# 31. `discover.ts` and `learn.ts`

## discover

Report:

- family;
- supported/partial/passthrough;
- sample count;
- estimated savings opportunity;
- parity gap.

Do not expose raw command arguments.

## learn

For unknown stateless formats:

- can propose JSON pack.

For stateful formats:

- do not auto-learn multiline parsers from regex samples;
- mark "processor required."

Never auto-enable an unsafe learned filter.

---

# 32. TOML compatibility

Keep `tomlCompatibility.ts` scoped.

Do not promise complete upstream RTK config compatibility.

Maintain a table:

```text
upstream option
OmniRoute mapping
supported / ignored / incompatible
reason
```

Unknown option:

- diagnostic warning;
- no silent reinterpretation.

---

# 33. Phase-by-phase implementation order

## Phase 0 — freeze baseline

Deliver:

- `upstream.ts`
- parity manifest redesign
- fixture provenance README
- baseline tests

No behavior changes.

Commit:

`chore(rtk): formalize v0.47 parity contract`

---

## Phase 1 — security fix first

Deliver:

- redact command metadata;
- `0600` where supported;
- atomic writes;
- secret corpus.

Commit:

`security(rtk): harden raw recovery metadata`

Release gate immediately.

---

## Phase 2 — processor framework

Deliver:

- `processors/types.ts`
- `processors/index.ts`
- schema `processor` field
- safe dispatch/fail-open
- processor-aware truncation hook

Commit:

`refactor(rtk): add stateful processor framework`

No tool behavior migration yet.

---

## Phase 3 — PHPT

Why first:

- smaller deterministic state machine;
- current implementation explicitly claims diff preservation but does not guarantee it.

Deliver:

- PHPT processor;
- fixtures;
- cap/truncation semantics;
- CR handling;
- fail-open.

Commit:

`fix(rtk): implement stateful PHPT parity`

Mark parity:
`semantic` only after all required tests pass.

---

## Phase 4 — CTest

Deliver:

- result parser;
- failure ownership;
- retry dedupe;
- trailer fallback;
- passthrough flags;
- fixtures.

Commit:

`fix(rtk): implement CTest v0.47 semantics`

---

## Phase 5 — Maven/mvnd

Deliver:

- mode classifier;
- lifecycle filters;
- Surefire trail;
- compile continuations;
- mvnd lanes;
- dependency/help passthrough;
- Windows wrapper support.

Commit:

`fix(rtk): implement Maven and mvnd parity`

This is the largest P0 feature.

---

## Phase 6 — Git diff correctness

Deliver:

- stateful hunk parser;
- word-diff passthrough;
- combined-diff safe path;
- quoted path support;
- full v0.47 fixture set.

Commit:

`fix(rtk): complete v0.47 git-diff parity`

---

## Phase 7 — detection/BOM

Deliver:

- confidence rules;
- Maven `[ERROR]` false-positive removal;
- Spring/Liquibase/SSH negative fixtures;
- BOM normalization.

Commit:

`fix(rtk): tighten detection and structured fallback`

---

## Phase 8 — grep/ls/tsc parity

Deliver:

- native flag policy;
- ls truncation/dot behavior;
- TypeScript pretty/global diagnostics.

Commits:

```text
fix(rtk): honor grep and rg native output modes
fix(rtk): align ls truncation semantics
fix(rtk): preserve TypeScript pretty diagnostics
```

---

## Phase 9 — docs/CI/benchmark

Deliver:

- generated docs;
- no hard-coded filter count;
- benchmark corpus;
- parity scripts;
- remove stale compounded savings math.

Commits:

```text
ci(rtk): enforce parity invariants
bench(rtk): add reproducible v0.47 corpus
docs(rtk): publish generated parity status
```

---

# 34. PR slicing

Do not ship one giant PR.

Recommended PRs:

```text
PR 1  Security + baseline metadata
PR 2  Processor framework
PR 3  PHPT
PR 4  CTest
PR 5  Maven/mvnd
PR 6  Git diff
PR 7  Matcher/BOM
PR 8  grep/ls/tsc
PR 9  CI/docs/benchmark
```

Each PR must be independently green and fail-open.

---

# 35. Exact P0 acceptance checklist

## Core

- [ ] Stable baseline = `v0.47.0`.
- [ ] `processor` architecture exists.
- [ ] Stateful processors bypass unsafe line allow-list behavior.
- [ ] Generic exceptions fail open.

## PHPT

- [ ] PASS/SKIP collapsed.
- [ ] FAIL/BORK/LEAK represented.
- [ ] XFAIL/XLEAK counted separately.
- [ ] WARN represented.
- [ ] first 20 failures.
- [ ] first 6 diff lines/failure.
- [ ] accurate overflow counts.
- [ ] CR progress handling.
- [ ] startup failure passthrough.
- [ ] environment compact summary.
- [ ] truncated per-test details disclosed.

## CTest

- [ ] all-pass summary.
- [ ] failure diagnostics preserved.
- [ ] timeout/killed preserved.
- [ ] retries deduplicated.
- [ ] wrapped result lines.
- [ ] stop-on-failure.
- [ ] disabled tests.
- [ ] forwarded suites.
- [ ] parallel diagnostics safe.
- [ ] raw FAILED trailer fallback.
- [ ] zero-run error trailer preserved.
- [ ] verbose/show-only/help/version passthrough.

## Maven/mvnd

- [ ] `mvn`.
- [ ] `./mvnw`.
- [ ] `mvnw.cmd`.
- [ ] `mvnd`.
- [ ] compile diagnostics.
- [ ] `symbol:`/`location:`.
- [ ] Surefire assertion.
- [ ] Surefire exception.
- [ ] bounded stacktrace.
- [ ] reactor summary.
- [ ] resume hint.
- [ ] mvnd lane ownership.
- [ ] ambiguous raw line preserved.
- [ ] dependency tree passthrough.
- [ ] help/effective-pom/evaluate passthrough.
- [ ] debug/unknown plugin conservative.

## Git diff

- [ ] quoted paths.
- [ ] hunk declared lengths.
- [ ] adjacent context.
- [ ] column-0 markers.
- [ ] `++`/`--` content.
- [ ] word-diff addition passthrough.
- [ ] word-diff deletion passthrough.
- [ ] combined diff safe.
- [ ] binary diff safe.
- [ ] rename/copy safe.
- [ ] classic hunk fallback.
- [ ] singular truncation grammar.
- [ ] no-newline marker safe.

## Detection

- [ ] `[ERROR]` alone is not Maven.
- [ ] prose mentioning SSH is not SSH output.
- [ ] generic logs are not tool-classified from one weak token.
- [ ] exact known command raises confidence.
- [ ] output-only mode is conservative.

## Structured/BOM

- [ ] BOM valid JSON.
- [ ] BOM malformed JSON fail-open.
- [ ] parser diagnostic retained.
- [ ] no accidental mid-string BOM stripping.

## Recovery

- [ ] raw output redacted.
- [ ] metadata command redacted/not stored raw.
- [ ] fake secrets absent from all sidecars.
- [ ] atomic write.
- [ ] retention bounded.
- [ ] recovery hint survives compression.

---

# 36. P1 acceptance checklist

- [ ] grep `-m/-l/-t` not repurposed.
- [ ] rg `-t` respected.
- [ ] format-altering grep modes passthrough.
- [ ] ls cap has explicit omission hint.
- [ ] ls dotfile/listing behavior not distorted.
- [ ] TSC pretty diagnostics preserved.
- [ ] TSC global diagnostics preserved.
- [ ] ANSI stripped before pretty-diagnostic blank handling.
- [ ] TSC failure dump bounded.
- [ ] generated filter count.
- [ ] generated parity table.
- [ ] benchmark published.
- [ ] false-positive corpus = 0 lossy matches.

---

# 37. Parity status policy

Use these definitions:

## `full`

Only when:

- all known upstream behavior in scoped family is implemented;
- all copied/recreated v0.47 fixtures pass;
- command modes are equivalent;
- no documented gap.

Use sparingly.

## `semantic`

Preferred success label.

Means:

- same important information preserved;
- same unsafe modes pass through;
- rendering may differ;
- behavior safe/equivalent for OmniRoute use.

## `partial`

Known meaningful gap exists.

## `passthrough`

OmniRoute intentionally does not compress that mode but safely preserves behavior.

## `not-supported`

Family unavailable.

For the proxy, `semantic` is usually the best honest target.

---

# 38. Recommended parity targets after this project

```text
PHPT            semantic
CTest           semantic
Maven           semantic
mvnd            semantic
Git diff        semantic
grep/rg         semantic for filtering modes
ls              semantic for captured-output compression
TypeScript      semantic
BOM/JSON        semantic
matcher safety  semantic
```

Do not label execution behaviors as full parity if OmniRoute does not actually execute/wrap the command.

---

# 39. Out of scope for this v0.47 milestone

Do not block this project on:

- RTK `0.48.0-rc` features such as Bun/Deno;
- recreating RTK's full CLI;
- installing shell hooks;
- replacing native commands;
- exact upstream analytics UX;
- exact byte-for-byte rendering;
- every command in RTK's 100+ catalog.

Track those in a future release parity backlog.

---

# 40. Future upstream update workflow

On each new stable RTK release:

1. Fetch release notes.
2. Pin a candidate baseline.
3. Diff features/fixes by family.
4. Update `parityManifest.ts` gaps first.
5. Import/recreate regression fixtures.
6. Implement behavior.
7. Run differential harness.
8. Update baseline tag only when P0 regression suite is green.
9. Generate docs.
10. Never silently claim latest parity before tests pass.

Optional scheduled CI:
detect latest stable tag and open an issue, but do not auto-update baseline.

---

# 41. Suggested final directory layout

```text
open-sse/services/compression/engines/rtk/
├── commandDetector.ts
├── commandMode.ts
├── configSchema.ts
├── deduplicator.ts
├── discover.ts
├── filterLoader.ts
├── filterSchema.ts
├── grouper.ts
├── index.ts
├── learn.ts
├── lineFilter.ts
├── normalize.ts
├── parityManifest.ts
├── rawOutput.ts
├── smartTruncate.ts
├── splitCompositeCommand.ts
├── tomlCompatibility.ts
├── upstream.ts
├── verify.ts
├── processors/
│   ├── index.ts
│   ├── types.ts
│   ├── ctest.ts
│   ├── maven.ts
│   ├── phpt.ts
│   ├── gitDiff.ts
│   └── typescript.ts
├── filters/
└── renderers/
```

Tests:

```text
tests/unit/compression/
├── rtk-normalize.test.ts
├── rtk-detection.test.ts
├── rtk-processor-dispatch.test.ts
├── rtk-ctest.test.ts
├── rtk-maven.test.ts
├── rtk-phpt.test.ts
├── rtk-git-diff.test.ts
├── rtk-typescript.test.ts
├── rtk-grep-flags.test.ts
├── rtk-ls.test.ts
├── rtk-raw-output-security.test.ts
├── rtk-parity-manifest.test.ts
└── fixtures/rtk/
```

---

# 42. Final Definition of Done

The RTK v0.47.0 parity project is Done only when all are true:

- [ ] No known P0 semantic corruption.
- [ ] Stateful tools no longer depend on line allow-lists for failure detail.
- [ ] PHPT actionable diff parity implemented.
- [ ] CTest failure-state parity implemented.
- [ ] Maven/mvnd lane and failure-trail parity implemented.
- [ ] Git-diff v0.47 correctness regressions covered.
- [ ] Matcher false positives covered.
- [ ] BOM fallback covered.
- [ ] grep native flag collision behavior covered.
- [ ] ls v0.47 truncation semantics covered.
- [ ] TypeScript v0.47 diagnostic regressions covered.
- [ ] Raw-output metadata cannot leak test secrets.
- [ ] All unsupported modes explicitly passthrough.
- [ ] Processor truncation never silently cuts a protected failure block.
- [ ] Manifest reports real parity, not just implementation presence.
- [ ] Filter count generated from source.
- [ ] Docs generated from baseline/manifest.
- [ ] Stale compounded savings claim removed.
- [ ] Benchmark reports OmniRoute-specific results.
- [ ] Differential parity harness passes required invariant corpus.
- [ ] Full compression test suite passes.
- [ ] CI blocks future parity regressions.

At that point OmniRoute can accurately state:

> **RTK compression is behaviorally tracked against RTK v0.47.0, with semantic parity for the listed supported families and conservative passthrough for unsupported/ambiguous modes.**

That wording is both technically strong and honest for a proxy implementation.

---

# 43. Authoritative upstream references used for this plan

## RTK stable release

- https://github.com/rtk-ai/rtk/releases/tag/v0.47.0

## CTest v0.47 implementation

- https://github.com/rtk-ai/rtk/commit/c75522e200d6133bca79ef2ba777c29ae9b1df6d

Key upstream behavior documented in the commit:

- run-total validation;
- retries;
- wrapped result lines;
- failed trailer fallback;
- bounded details;
- parallel attribution;
- verbose/show-only/help/version/dashboard passthrough.

## Maven/mvnd v0.47 implementation

- https://github.com/rtk-ai/rtk/commit/774465e379a4b723b1239ec0ea1b04c413ed0f10

Key upstream behavior:

- mvnd separate entry point;
- shared Maven filters;
- `[INFO]` blank handling;
- per-module parallel lanes;
- raw diagnostic ownership;
- preserve ambiguous unprefixed diagnostics.

## PHPT v0.47 implementation

- https://github.com/rtk-ai/rtk/commit/e8541d1e1180f7ef4c736322cedc8e834f2f8f77
- https://raw.githubusercontent.com/rtk-ai/rtk/e8541d1e1180f7ef4c736322cedc8e834f2f8f77/src/cmds/php/phpt_cmd.rs

Key upstream constants/behavior:

- 20 failures shown;
- 6 diff lines per failure;
- PASS/FAIL/SKIP/BORK/WARN/LEAK/XFAIL/XLEAK;
- CR progress normalization;
- fail-open on unparseable startup output;
- compact environment + count summary.

## Git diff v0.47 fixes

Release commits include:

- quoted paths;
- declared hunk lengths;
- word-diff passthrough;
- combined diff state;
- marker column preservation;
- `++`/`--` content preservation.

See release page for exact commits.

## Other v0.47 fixes

Release page also tracks:

- grep `-m/-l/-t` native flag behavior;
- BOM/JSON graceful fallback;
- `ls` cap/dotfile behavior;
- TypeScript pretty/global diagnostic fixes;
- overly broad Spring Boot/Liquibase/SSH matcher fixes.

---

# 44. Current OmniRoute files audited

- `commandDetector.ts`
- `filterSchema.ts`
- `filterLoader.ts`
- `lineFilter.ts`
- `parityManifest.ts`
- `rawOutput.ts`
- `filters/test-ctest.json`
- `filters/maven.json`
- `filters/test-phpt.json`
- `filters/git-diff.json`
- `filters/shell-grep.json`
- `filters/shell-ls.json`
- `filters/build-typescript.json`

The plan is intentionally designed as an incremental upgrade of the current engine rather than a rewrite.
