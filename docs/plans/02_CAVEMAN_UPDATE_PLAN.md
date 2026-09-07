# OmniRoute Caveman Update Plan — v2.5-Aware, License-Safe Integration

**Repository:** `TheDemonTuan/OmniRoute`  
**Target branch reviewed:** `prod`  
**Audit date:** 2026-09-04  
**Upstream baseline:** `JuliusBrussee/caveman v2.5.0`  
**Primary goal:** Modernize OmniRoute's Caveman-inspired input/output compression behavior without copying BSL-1.1 engine runtime code into OmniRoute's MIT core, and replace stale marketing math with reproducible OmniRoute measurements.

---

## 1. Executive decision

Treat "Caveman" as two separate upstream concepts:

1. **Caveman skill / terse-output behavior**
   - remains permissive/MIT upstream;
   - conceptually close to OmniRoute's Caveman output mode and prose compression philosophy.

2. **Caveman 2 Engine / Proxy runtime**
   - content-type routing, input compression, CCR/recovery, proxy/wrap behavior, cache optimization, browse/shrink/MCP runtime;
   - upstream states engine-linked runtime is BSL-1.1;
   - third-party hosted/managed/embedded service use may require a commercial license.

Therefore:

- Do **not** copy Caveman 2 engine/proxy implementation into OmniRoute's MIT gateway.
- Do **not** claim OmniRoute implements Caveman 2.
- Continue the current independent rule-based Caveman engine.
- Port only ideas/behavior patterns that are independently implementable and compatible with OmniRoute's architecture.
- If a future direct Caveman runtime integration is desired, make it an **optional external adapter** with explicit licensing/configuration, not bundled engine code.

---

## 2. Current OmniRoute state

Current `caveman.ts` already has valuable safety machinery:

- imports `extractPreservedBlocks` / `restorePreservedBlocks`;
- uses language detection;
- uses data/rule packs;
- preserves code-like regions;
- calls `validateCompression(...)`;
- on validation failure sets fallback metadata and returns original text;
- tracks validation warnings/errors;
- tracks preserved block count;
- estimates token deltas;
- applies rules per message role/context.

This means the right update is **not a rewrite**.

Preserve:

- deterministic rules;
- data-only language packs;
- preservation engine;
- validation;
- fail-open fallback;
- compatibility with stacked pipelines.

---

## 3. Main gaps to fix

### P0 — stale savings claims

Current OmniRoute README still calculates stacked savings approximately as:

`1 - (1 - 0.80) * (1 - 0.46) = 89.2%`

This should not be presented as an OmniRoute average.

Why:

- RTK and Caveman figures come from different products/datasets.
- Eligibility differs.
- Pipeline stages are not statistically independent.
- token estimators may differ.
- rule interactions can reduce or increase downstream eligibility.
- upstream Caveman 2 now emphasizes measured/inferred/verified distinctions rather than a single reusable percentage.

**Required action:** remove the computed "average" as a factual product benchmark.

Use:

- OmniRoute end-to-end measured corpus results for OmniRoute claims;
- upstream figures only in an attribution/reference section.

### P0 — licensing boundary

Add an explicit source/license boundary in code docs and notices:

- Caveman skill/CLI/SDK portions: upstream describes as MIT.
- Engine-linked runtime: upstream describes as BSL-1.1.
- OmniRoute Caveman engine: independent implementation inspired by the public behavior/philosophy; not Caveman 2 Engine.

### P0 — semantic safety corpus

Current validation is useful, but production confidence should move from only generic preservation checks to a pinned Caveman-specific semantic corpus.

Must protect:

- negation;
- numeric values;
- version numbers;
- file paths;
- URLs;
- code identifiers;
- flags;
- error strings;
- ordered steps;
- quoted strings;
- API names;
- constraints such as "must", "must not", "only", "at least", "exactly";
- security and irreversible-action language.

### P1 — content-type eligibility router

Do not clone Caveman 2's engine.

However, OmniRoute should avoid sending obviously unsuitable content through prose rules.

Add a small **Caveman eligibility classifier** before rule application:

Kinds:

- prose
- mixed-prose-code
- code-dominant
- structured-json
- diff
- log/tool-output
- table
- unknown

Behavior:

- `prose` => Caveman eligible.
- `mixed-prose-code` => protect blocks, compress prose segments only.
- `code-dominant` => conservative or passthrough.
- `structured-json` => passthrough to Caveman; let Headroom/other structured engine handle it.
- `diff` => passthrough to Caveman; let RTK/diff-aware engine handle it.
- `log/tool-output` => Caveman only after RTK if stacked and only for residual prose.
- `unknown` => conservative/fail-open.

This gives OmniRoute the useful "content-aware routing" principle without embedding upstream runtime.

---

## 4. Proposed architecture

### 4.1 Add Caveman upstream metadata

Create:

`open-sse/services/compression/cavemanUpstream.ts`

Suggested data:

```ts
export const CAVEMAN_UPSTREAM_BASELINE = {
  project: "JuliusBrussee/caveman",
  stableTag: "v2.5.0",
  auditedAt: "2026-09-04",
  integrationType: "independent-inspired-implementation",
  bundledRuntime: false,
} as const;
```

Include a comment linking the upstream licensing explanation.

### 4.2 Add eligibility module

Create:

`open-sse/services/compression/cavemanEligibility.ts`

Public API:

```ts
type CavemanContentKind =
  | "prose"
  | "mixed-prose-code"
  | "code-dominant"
  | "structured-json"
  | "diff"
  | "log-tool-output"
  | "table"
  | "unknown";

interface CavemanEligibility {
  kind: CavemanContentKind;
  eligible: boolean;
  confidence: number;
  reason: string;
}
```

No ML required.

Use deterministic signals:

- parsed JSON;
- fenced code density;
- code-like-line ratio;
- diff headers/hunks;
- log timestamp/severity density;
- tabular delimiter density;
- natural-language sentence density.

### 4.3 Keep preservation and validation as gates

Target flow:

`input -> classify -> preserve -> apply rules -> restore -> validate -> minimum-gain gate -> result/fallback`

Do not let compression output bypass validation.

---

## 5. Detailed implementation tasks

## Phase A — classify before compressing

### Add

`cavemanEligibility.ts`

Rules should be intentionally conservative.

Examples:

**structured JSON**

- if entire trimmed text parses as JSON => not Caveman prose;
- if a fenced JSON block dominates content => mixed/structured.

**diff**

- begins with `diff --git`, `---`/`+++`, or strong hunk signatures => not Caveman prose.

**logs**

- high ratio of ISO timestamps, log levels, stack frames, repeated prefixes => route away from Caveman when standalone.

**code-dominant**

- reuse `isCodeLikeLine`;
- if code-like lines exceed configurable threshold, only compress non-code prose segments.

### Modify

`caveman.ts`

Before `getRulesForContext(...)`:

- classify text part;
- skip or reduce intensity by kind;
- add stats:
  - `cavemanContentKind`
  - `cavemanSkippedReason`
  - `cavemanEligibilityConfidence`

### Add tests

`tests/unit/compression/caveman-eligibility.test.ts`

Cases:

- normal English prose;
- Vietnamese prose;
- mixed prose + fenced code;
- pure JSON;
- JSON with BOM;
- git diff;
- stacktrace;
- shell logs;
- markdown table;
- source file body;
- one-sentence prose containing a path/URL.

---

## Phase B — semantic safety hardening

### Modify

`validation.ts` only if a generic capability belongs there.

Otherwise create:

`cavemanSemanticGuard.ts`

Guard classes:

1. **Negation guard**
   - preserve semantic polarity (`not`, `never`, `cannot`, language equivalents).

2. **Constraint guard**
   - preserve `must`, `must not`, `exactly`, `only`, threshold expressions.

3. **Numeric guard**
   - preserve numbers, percentages, versions, ports, dates where meaning-bearing.

4. **Identifier guard**
   - preserve backticked identifiers and API names.

5. **Sequence guard**
   - if source contains an ordered operational sequence, output must not collapse/reorder it.

6. **Security/irreversible guard**
   - do not compress warnings/confirmations into ambiguous shorthand.

7. **Quoted-literal guard**
   - preserve exact quoted values when likely command/config/API data.

### Important behavior

If a guard cannot prove safety:

- return original text;
- set `fallbackApplied = true`;
- expose the guard reason in diagnostics.

No partial corruption.

### Tests

`tests/unit/compression/caveman-semantic-guard.test.ts`

Minimum cases:

- "Do not delete production data."
- "Use port 443, not 80."
- "Version 2.1.251 or newer."
- "Run A before B."
- "Only retry GET requests."
- "Exactly 3 attempts."
- "Never log Authorization."
- Vietnamese equivalents for negation/ordering/numbers.
- technical text with backticks, URL, JSON fragment.

---

## Phase C — rule quality cleanup

### Audit

`cavemanRules.ts`

and:

`open-sse/services/compression/rules/<language>/...`

For every rule:

- category;
- minimum intensity;
- supported role;
- language;
- positive example;
- negative example;
- known-risk note.

### Remove or tighten rules that:

- delete articles/tokens in a way that can hit identifiers or non-English text;
- remove hedging when hedging expresses uncertainty that matters;
- rewrite "may" / "might" into certainty;
- remove "not";
- collapse ordered instructions;
- change comparisons/thresholds.

### Add rule-pack validation

The rule loader should reject:

- invalid regex;
- empty match;
- pathological zero-width global replacement;
- duplicate rule IDs;
- impossible intensity;
- unknown language/category.

Where practical, add a regex safety/complexity check to prevent catastrophic backtracking from custom packs.

---

## Phase D — minimum-gain gate

Do not compress tiny inputs just because a rule matches.

Add config:

```ts
minimumGain: {
  enabled: true,
  minTokensSaved: number,
  minPercentSaved: number
}
```

Suggested policy:

- if result saves too little, use original;
- preserve diagnostics indicating "low_gain_passthrough".

Reason:

- avoids churn;
- avoids needless semantic risk;
- avoids changing cache keys for negligible savings;
- makes metrics cleaner.

Add tests:

- 1-token saving => passthrough.
- substantial prose compression => apply.
- long text with only one filler word => passthrough.

---

## Phase E — stacked pipeline semantics

For the default `RTK -> Caveman` stack:

- RTK gets first chance on tool output.
- Caveman should only process residual natural-language prose.
- Caveman must not "re-compress" RTK's structured compact output unless classifier says it is safe prose.
- if RTK creates raw-output pointer/recovery hint, Caveman must preserve it exactly.
- retrieval markers from CCR/headroom must be protected.

Add:

`tests/unit/compression/rtk-caveman-stacked-fidelity.test.ts`

Cases:

- test failure output;
- git diff;
- AWS JSON;
- kubectl error;
- generic explanatory prose around compact tool output;
- raw-output recovery pointer;
- CCR retrieve marker.

Assertions:

- pointer/marker exact;
- error lines exact enough to act on;
- no structured output corruption.

---

## 6. Caveman output mode update

OmniRoute has a separate output-side Caveman instruction path.

Keep it separate from input compression.

### Modify

`open-sse/services/compression/outputMode.ts`

Current shared boundary text already protects:

- code blocks;
- paths;
- commands;
- errors;
- URLs;
- security warnings;
- irreversible confirmations;
- ordered multi-step sequences.

Improve it with:

- do not turn uncertainty into certainty;
- preserve numbers/constraints;
- preserve negation;
- preserve requested explanations when user explicitly asks for detail;
- do not shorten legal/security-sensitive disclaimers into ambiguity.

Do not add upstream Caveman 2 engine behavior to this prompt.

### Tests

`tests/unit/compression/caveman-output-mode-boundaries.test.ts`

Test injected instruction text contains all required boundaries and remains cache-stable/deterministic.

---

## 7. Metrics and benchmark redesign

### Remove misleading product math

Delete or rewrite docs that imply:

`RTK average 80% + Caveman input 46% = OmniRoute average 89.2%`

Replace with measured fields.

### Add benchmark corpus

`tests/benchmarks/compression/caveman/`

Categories:

- short prose;
- verbose prose;
- technical prose;
- code-heavy prompt;
- JSON;
- diff;
- logs;
- multi-language prose;
- security warning;
- ordered procedure;
- API request instructions;
- prompt with many identifiers/versions/numbers.

Record:

- original token estimate;
- compressed token estimate;
- savings;
- language;
- eligibility kind;
- rules fired;
- fallback reason;
- validation result;
- semantic check result;
- runtime.

### Required reporting

Publish:

- eligible-request savings;
- aggregate savings across all requests;
- passthrough rate;
- fallback rate;
- semantic fidelity pass rate;
- p95 latency.

Never call a number "verified savings" unless OmniRoute actually implements a verification protocol that justifies the term.

Use:

- "measured on OmniRoute benchmark corpus"
- "estimated tokens"
- "provider-reported tokens" only when provider receipts are actually collected.

---

## 8. License / provenance work

### Update

`THIRD_PARTY_NOTICES.md`

Suggested conceptual wording:

> OmniRoute's Caveman modes are independent implementations inspired by the Caveman project's terse-output and compression concepts. OmniRoute does not bundle the Caveman 2 BSL-1.1 engine-linked runtime. Upstream licenses differ by component; see the upstream licensing documentation.

### Add

`docs/compression/CAVEMAN_PROVENANCE.md`

Include:

- what is inspired;
- what is independently implemented;
- what is not bundled;
- upstream stable version audited;
- links to upstream license/announcement;
- instructions for maintainers: do not paste BSL engine source into MIT core without license review.

### Optional external adapter

If users later want real Caveman 2 runtime:

Create a separate adapter such as:

`open-sse/services/compression/external/cavemanAdapter.ts`

Requirements:

- disabled by default;
- endpoint/process configured by user;
- no bundled BSL engine binary;
- explicit warning that operator must comply with upstream license;
- fail open to OmniRoute native engine or original input;
- distinguish stats: `engine=caveman-external`.

This is **not part of the required update**.

---

## 9. Documentation changes

Update:

- `README.md`
- `docs/compression/COMPRESSION_GUIDE.md`
- `docs/compression/COMPRESSION_ENGINES.md`
- relevant dashboard help text

Required changes:

1. Clearly distinguish:
   - native OmniRoute Caveman input compressor;
   - Caveman output mode;
   - upstream Caveman project;
   - Caveman 2 engine/proxy.

2. Remove stale fixed upstream input-savings number used as OmniRoute math.

3. State that JSON/diff/tool output are normally handled by specialized engines before Caveman prose rules.

4. Publish benchmark methodology.

5. Include fail-open behavior.

6. Avoid saying "same as Caveman 2" or implying API/runtime parity.

---

## 10. Suggested commit sequence

1. `docs(caveman): clarify upstream v2.5 licensing and integration boundary`
2. `test(caveman): add semantic preservation corpus`
3. `feat(caveman): add content eligibility classifier`
4. `fix(caveman): fail open on semantic guard violations`
5. `feat(caveman): add minimum-gain passthrough`
6. `fix(caveman): protect stacked RTK/CCR markers`
7. `fix(output-mode): strengthen caveman output boundaries`
8. `bench(caveman): add reproducible OmniRoute corpus`
9. `docs(compression): replace compounded upstream savings math`

---

## 11. Rollout plan

### Stage 1 — tests only

Add corpus and regression tests without behavior changes.

Capture current baseline:

- savings;
- fallback rate;
- runtime;
- known semantic failures.

### Stage 2 — classifier + guards behind feature flag

Add temporary config:

`caveman.safeRoutingV2`

Default:

- enabled in tests;
- opt-in in production for one release if backward-compat concern is high.

### Stage 3 — make safe routing default

After benchmark:

- enable classifier + semantic guards by default;
- retain escape hatch for one release.

### Stage 4 — remove stale flag

When telemetry shows no regression:

- remove compatibility flag;
- keep config for gain thresholds if useful.

---

## 12. Definition of Done

Caveman update is complete when:

- [ ] Upstream baseline records `v2.5.0`.
- [ ] License/provenance boundary is documented.
- [ ] No Caveman 2 BSL engine runtime code is bundled into MIT core.
- [ ] Content eligibility classifier exists.
- [ ] Pure JSON/diff/log payloads no longer run through prose rules by default.
- [ ] Mixed prose/code compresses only eligible prose.
- [ ] Negation, numbers, constraints, ordered steps, identifiers and security warnings are protected.
- [ ] Validation failure always returns original text.
- [ ] Minimum-gain passthrough exists.
- [ ] RTK → Caveman stacked regression suite passes.
- [ ] CCR/raw-recovery markers remain exact.
- [ ] Old `89.2% average` style claim is removed or explicitly labeled as illustrative math, not product benchmark.
- [ ] OmniRoute-specific benchmark results are reproducible.
- [ ] Docs clearly distinguish input compressor vs output mode.
- [ ] Full compression suite passes.

---

## 13. Upstream references audited

- OmniRoute:
  - https://github.com/TheDemonTuan/OmniRoute/blob/prod/open-sse/services/compression/caveman.ts
  - https://github.com/TheDemonTuan/OmniRoute/blob/prod/open-sse/services/compression/outputMode.ts
  - https://github.com/TheDemonTuan/OmniRoute/tree/prod/open-sse/services/compression/rules
- Caveman upstream:
  - https://github.com/JuliusBrussee/caveman
  - https://github.com/JuliusBrussee/caveman/releases
  - https://github.com/JuliusBrussee/caveman/blob/main/ANNOUNCEMENT.md

The upstream v2.5 release highlights fail-closed proxy-port behavior, request-scoped MCP recovery, staging-file validation for compression, cache optimizers, and measured-savings documentation. Those are useful design signals, but they do not justify copying BSL engine code into OmniRoute.
