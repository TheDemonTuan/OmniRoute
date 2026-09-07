# OmniRoute Ponytail Update Plan — v4.9.0 Behavioral Parity

**Repository:** `TheDemonTuan/OmniRoute`  
**Target branch reviewed:** `prod`  
**Audit date:** 2026-09-04  
**Upstream baseline:** `DietrichGebert/ponytail v4.9.0`  
**Primary goal:** Bring OmniRoute's `Ponytail (lazy senior dev)` Output Style closer to upstream core behavior while keeping it a lightweight output-style instruction, not importing upstream lifecycle/plugin machinery into the compression engine.

---

## 1. Executive decision

Ponytail should remain an **Output Style**, not an input compression engine.

This is architecturally correct in OmniRoute:

- RTK/Caveman shrink input/context.
- Ponytail changes the coding behavior of the model and tends to reduce generated code/diff size.

Do not add Ponytail to the engine pipeline.

Do not attempt to recreate all upstream integrations such as:

- plugin installers;
- lifecycle hooks;
- persistent host-specific settings;
- MCP server;
- subagent hooks;
- status bar;
- slash commands.

Only port the parts that make sense inside OmniRoute's deterministic output-style registry:

1. core YAGNI ladder;
2. comprehension-before-minimization;
3. root-cause behavior;
4. safety carve-outs;
5. runnable-check rule;
6. explicitly requested behavior/explanation preservation;
7. measured-output telemetry/eval.

---

## 2. Current OmniRoute state

Current source:

`open-sse/services/compression/outputStyles/catalog.ts`

already has:

- style id `ponytail`;
- label `Ponytail (lazy senior dev)`;
- lite/full/ultra prompts;
- multiple languages;
- core principles:
  - YAGNI;
  - reuse before rewrite;
  - stdlib;
  - platform/dependency;
  - one-line;
  - minimum working implementation;
  - root cause, not symptom;
  - grep callers;
  - fix shared function once;
  - no unrequested abstraction;
  - no new dependency;
  - deletion > addition;
  - boring > clever;
  - fewest files;
  - shortest working diff after understanding;
  - question complex requirements;
  - edge-case correctness.

This is a strong base.

---

## 3. Current gaps vs upstream core behavior

### P0 — separate platform and installed dependency rungs

Upstream core ladder is explicitly:

1. Does this need to exist? YAGNI.
2. Already in codebase? Reuse.
3. Stdlib does it? Use it.
4. Native platform feature? Use it.
5. Installed dependency? Use it.
6. One line? One line.
7. Only then: minimum that works.

OmniRoute's full prompt currently merges platform + installed dependency into one rung in some locales.

**Fix:** preserve the 7-rung ladder explicitly.

### P0 — comprehension before laziness

Upstream emphasizes:

- read the code the change touches;
- trace the real flow;
- only then choose the smallest solution;
- "lazy about solution, never about reading."

OmniRoute mentions "only after understanding" but should strengthen this into an explicit first-class instruction.

### P0 — safety carve-outs

Upstream explicitly states minimalism must never remove:

- trust-boundary validation;
- data-loss handling;
- security;
- accessibility.

OmniRoute currently appends generic `SHARED_BOUNDARIES`, originally designed around Caveman output brevity:

- exact code/path/command/error/URL;
- normal style for security warnings;
- irreversible confirmations;
- ordered sequences.

That is useful, but it is **not the complete Ponytail contract**.

Create Ponytail-specific boundaries.

### P0 — requested behavior is not "debt"

Ponytail should not use YAGNI to refuse requirements the user actually asked for.

Rules:

- do not delete explicitly requested behavior merely because a smaller implementation is possible;
- do not omit explicitly requested explanation/documentation/tests;
- do not turn a requested robust fix into a workaround to save lines.

### P0 — one runnable check

For non-trivial logic, the "lazy" implementation is unfinished if there is no smallest runnable check.

This does not mean generating a huge test suite.

The instruction should prefer:

- one focused unit test;
- one regression test;
- one command demonstrating behavior;
- whichever is the smallest credible proof.

### P1 — style composition conflicts

Ponytail can be combined with:

- terse;
- less-code;
- caveman;
- ADHD/action-first;
- other styles.

Need deterministic conflict rules so "short output" does not suppress:

- a requested test;
- safety note;
- required reasoning summary;
- implementation detail necessary for correctness.

---

## 4. Architecture changes

### 4.1 Stop reusing Caveman boundaries for Ponytail

Current `catalog.ts` appends `${SHARED_BOUNDARIES}` to Ponytail prompts.

Replace with a Ponytail-specific exported constant.

Preferred file:

`open-sse/services/compression/outputStyles/ponytail.ts`

Exports:

```ts
export const PONYTAIL_BOUNDARIES = "...";
export const PONYTAIL_CORE_LADDER = "...";
export const PONYTAIL_UPSTREAM_BASELINE = {...};
```

Then `catalog.ts` becomes mostly catalog wiring.

Reason:

- Caveman boundaries protect terse prose.
- Ponytail boundaries protect engineering correctness.
- The concepts overlap but are not identical.

### 4.2 Proposed Ponytail boundary contract

Semantically include:

- Understand the touched code and real flow before minimizing.
- Never remove trust-boundary validation.
- Never weaken security.
- Never weaken accessibility.
- Never skip handling that prevents data loss.
- Preserve explicitly requested behavior.
- Preserve explicitly requested explanation/docs/tests.
- For non-trivial logic, leave the smallest runnable check.
- Minimal diff is subordinate to correctness.
- No speculative abstraction/dependency.
- If two solutions are equally small, prefer edge-case-correct and easier-to-delete/maintain.

Keep it compact enough to avoid excessive prompt overhead.

---

## 5. Detailed implementation tasks

## Phase A — extract Ponytail prompt module

### Add

`open-sse/services/compression/outputStyles/ponytail.ts`

Contents:

- `PONYTAIL_UPSTREAM_BASELINE`
- canonical English semantic clauses
- `PONYTAIL_BOUNDARIES`
- helper to compose level prompts
- optional locale overrides

Do not duplicate entire upstream repository prompt verbatim.

Implement behavior in OmniRoute's own concise wording.

### Modify

`outputStyles/catalog.ts`

Replace inline Ponytail block text with imports/helpers.

Goal:

- one source of truth for Ponytail semantics;
- easier future upstream audits;
- easier tests.

---

## Phase B — update 7-rung ladder

For `full` mode, enforce all seven rungs:

1. YAGNI.
2. Reuse codebase.
3. Stdlib.
4. Native platform.
5. Already-installed dependency.
6. One-line/local expression if genuinely clearer.
7. Minimum working implementation.

Important qualifier:

"One line" is not code golf.

Do not compress:

- validation;
- error handling;
- meaningful names;
- accessible markup;
- security checks

just to fit a line.

For `lite`:

- shorter version: YAGNI → reuse → stdlib/platform/dependency → minimum.

For `ultra`:

- terse wording is okay, but safety rules must remain complete.

---

## Phase C — comprehension-first rule

Add explicit instruction before ladder:

> First read the code the change touches and trace the real call/data flow. Minimize the solution only after understanding the problem.

Behavior expectations:

- inspect caller/callee relationships;
- identify shared source of bug;
- prefer one root fix over N caller patches;
- do not create a new abstraction before checking existing code;
- do not "fix" a symptom solely because it is fewer lines.

Add tests that assert the injected prompt contains this semantic requirement.

---

## Phase D — safety rules

### Add Ponytail-specific safety text

Must include these concepts:

1. trust boundaries;
2. data-loss prevention;
3. security;
4. accessibility;
5. explicitly requested behavior;
6. smallest runnable check for non-trivial logic.

### Do not place them only in `SHARED_BOUNDARIES`

Reason:

- changing Caveman global boundary text could unnecessarily alter all other output styles and languages;
- Ponytail needs engineering-specific semantics.

### Tests

`tests/unit/compression/output-style-ponytail-safety.test.ts`

Assertions should be semantic/keyword based, not exact whole-string snapshots only.

Test all supported locales at minimum for:

- presence of safety clause or fallback to canonical English safety suffix;
- style registration;
- no empty prompt;
- no duplicate marker.

---

## Phase E — requested-behavior preservation

Add instruction:

- "Do not use YAGNI against a requirement the user explicitly asked for."
- "If the user asks for tests/docs/explanation, those are part of the task."
- "Question speculative complexity, not explicit acceptance criteria."

Add eval fixtures:

### Fixture 1 — user asks for validation

Prompt:
"Add server-side validation for this public API input."

Bad Ponytail behavior:

- skip validation to save code.

Expected:

- retain validation at trust boundary.

### Fixture 2 — accessibility

Prompt:
"Add an icon-only button with accessible name."

Bad:

- omit ARIA/name for smaller diff.

Expected:

- accessible name preserved.

### Fixture 3 — explicit tests

Prompt:
"Fix bug and add regression test."

Bad:

- fix only, claim test is optional.

Expected:

- smallest regression test included.

### Fixture 4 — explanation requested

Prompt:
"Fix it and explain why it happened."

Bad:

- only output patch because prose is "waste."

Expected:

- concise explanation remains.

### Fixture 5 — data loss

Prompt:
"Replace file atomically."

Bad:

- direct overwrite because fewer lines.

Expected:

- safe behavior preserved.

---

## Phase F — runnable-check discipline

Define "non-trivial":

At least one:

- branching/business logic;
- bug with prior regression risk;
- parsing/serialization;
- state mutation;
- security validation;
- concurrency;
- data migration;
- API contract behavior.

Ponytail prompt rule:

- choose the smallest runnable check that proves the changed behavior;
- do not build broad scaffolding;
- reuse existing test framework;
- if repository has no test framework and a direct command verifies behavior, use that instead;
- do not add a dependency solely to create a test harness unless required.

This aligns minimalism with evidence.

---

## 6. Style composition rules

### Current risk

Combining Ponytail with terse/caveman may produce:

- too little explanation;
- omitted check;
- over-compressed safety language.

### Add composition precedence

In:

`open-sse/services/compression/outputStyles/apply.ts`

Define semantic priority:

1. Safety / correctness boundaries.
2. Explicit user requirements.
3. Ponytail engineering discipline.
4. Output organization style.
5. Terseness.

Terseness must never override items 1–3.

### Add conflict tests

`tests/unit/compression/output-style-composition.test.ts`

Cases:

- `ponytail + terse`
- `ponytail + caveman`
- `ponytail + less-code`
- `ponytail + i-have-adhd`

Assertions:

- no duplicate contradictory system instructions;
- Ponytail safety survives;
- requested-test instruction survives;
- action-first formatting may change order, not engineering requirements.

---

## 7. Locale strategy

Current catalog carries many translated prompt variants.

Maintaining full long safety text independently in every locale creates drift.

Recommended design:

- localized "voice/short style" section;
- canonical compact safety suffix, translated only for high-confidence maintained locales;
- automated parity test ensures every locale includes the same semantic keys.

Possible structure:

```ts
const PONYTAIL_SEMANTIC_KEYS = [
  "understand-first",
  "yagni",
  "reuse",
  "stdlib",
  "platform",
  "installed-dependency",
  "one-line",
  "minimum",
  "root-cause",
  "trust-boundary",
  "data-loss",
  "security",
  "accessibility",
  "explicit-requirements",
  "runnable-check",
] as const;
```

Each locale template can declare coverage metadata.

CI fails if a locale silently drops a P0 semantic key.

---

## 8. Telemetry / evaluation

Do not claim "80–94% less code" as OmniRoute's result without OmniRoute measurements.

Create eval:

`tests/eval/outputStyles/ponytail/`

Measure:

- files touched;
- lines added;
- lines deleted;
- net LOC;
- test/check present;
- task acceptance criteria met;
- security/accessibility constraints met;
- dependency count changed;
- number of new abstractions;
- task success.

Compare:

- baseline model;
- Ponytail lite;
- Ponytail full;
- Ponytail ultra;
- Ponytail + terse.

The primary metric is **task success with smaller necessary diff**, not minimum LOC at any cost.

Recommended score:

```text
pass task requirements     hard gate
safety/accessibility       hard gate
runnable check             hard gate when applicable
then minimize:
  files touched
  added LOC
  new abstractions
  new dependencies
```

This prevents the benchmark from rewarding broken "tiny" solutions.

---

## 9. Optional commands/features — keep out of core style

Upstream v4.9.0 includes host/plugin functionality such as:

- persistent default mode;
- subagent scoping;
- review/audit/debt/gain/help commands;
- multiple agent integrations.

Do not put these into `catalog.ts`.

If OmniRoute wants equivalents later:

- `ponytail-review` => separate output style or agent workflow;
- `ponytail-audit` => separate analysis tool/workflow;
- `ponytail-debt` => separate static analysis/report feature;
- `ponytail-gain` => eval/dashboard metric;
- persistent default => dashboard/user config;
- subagent scoping => routing/agent layer, not compression.

These are separate product features.

---

## 10. Documentation changes

Update:

- `README.md`
- `docs/compression/COMPRESSION_GUIDE.md`
- output styles documentation
- `THIRD_PARTY_NOTICES.md`

Required wording:

- Ponytail is an output behavior style, not a compression engine.
- It is inspired by upstream MIT Ponytail.
- Core goal is "necessary code only," not code golf.
- It never trades away validation, data-loss handling, security, or accessibility.
- Explicit user requirements remain mandatory.
- Non-trivial changes should leave a smallest runnable check.
- OmniRoute benchmark figures, if published, are OmniRoute measurements.

---

## 11. Suggested commit sequence

1. `refactor(output-style): extract ponytail prompt module`
2. `fix(ponytail): restore seven-rung upstream ladder`
3. `fix(ponytail): add comprehension-before-minimization`
4. `fix(ponytail): add safety and explicit-requirement boundaries`
5. `feat(ponytail): require smallest runnable check for non-trivial logic`
6. `fix(output-style): define composition precedence`
7. `test(ponytail): add safety and behavior eval fixtures`
8. `docs(ponytail): document v4.9 baseline and non-goals`
9. `bench(ponytail): measure successful diff reduction`

---

## 12. Rollout

Ponytail is prompt-only, but behavior changes can still be significant.

### Stage 1

- Add tests/evals against current prompt.
- Record baseline failure cases.

### Stage 2

- Ship new prompt under internal version:
  - `ponytailPromptVersion: 2`

### Stage 3

- Compare eval success and diff metrics.
- Make v2 default.

### Stage 4

- Retain v1 only if backward compatibility is necessary.
- Otherwise remove after one release.

Expose prompt version in diagnostics but not necessarily user-facing UI.

---

## 13. Definition of Done

Ponytail update is complete when:

- [ ] Upstream baseline pins `v4.9.0`.
- [ ] Ponytail has its own boundary contract, separate from Caveman.
- [ ] Full mode uses seven distinct rungs.
- [ ] Prompt explicitly requires understanding/tracing before minimizing.
- [ ] Trust-boundary validation cannot be optimized away.
- [ ] Data-loss handling cannot be optimized away.
- [ ] Security cannot be optimized away.
- [ ] Accessibility cannot be optimized away.
- [ ] Explicit user requirements cannot be dismissed via YAGNI.
- [ ] Requested tests/docs/explanations are treated as task requirements.
- [ ] Non-trivial logic asks for the smallest runnable check.
- [ ] Root-cause/caller-tracing behavior remains.
- [ ] Composition with terse/caveman does not suppress safety.
- [ ] Locale semantic parity is testable.
- [ ] Eval hard-gates correctness before rewarding smaller diffs.
- [ ] Docs do not claim upstream benchmark numbers as OmniRoute results.
- [ ] Full output-style/compression suite passes.

---

## 14. Upstream references audited

- OmniRoute:
  - https://github.com/TheDemonTuan/OmniRoute/blob/prod/open-sse/services/compression/outputStyles/catalog.ts
  - https://github.com/TheDemonTuan/OmniRoute/blob/prod/open-sse/services/compression/outputMode.ts
- Ponytail upstream:
  - https://github.com/DietrichGebert/ponytail
  - https://github.com/DietrichGebert/ponytail/releases

Upstream v4.9.0 is used as the stable behavioral baseline. Host-specific plugin features are intentionally out of scope for the OmniRoute Output Style.
