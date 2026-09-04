import { estimateCompressionTokens } from "../../stats.ts";
import {
  getRtkFilterLoadDiagnostics,
  loadRtkFilters,
  matchRtkFilter,
  type RtkFilterLoadDiagnostic,
} from "./filterLoader.ts";
import { applyLineFilter } from "./lineFilter.ts";
import { processRtkText } from "./index.ts";

export interface RtkFilterTestOutcome {
  filterId: string;
  testName: string;
  passed: boolean;
  actual: string;
  expected: string;
  passthrough?: boolean;
  matchedFilterId?: string | null;
}

export interface RtkFixtureAssertion {
  name: string;
  input: string;
  command?: string;
  expectedOutput?: string;
  expectedFilterId?: string | null;
  passthroughExpected?: boolean;
  negativeMatchExpected?: boolean;
}
export interface RtkFilterBenchmarkRow {
  category: string;
  filters: number;
  tests: number;
  averageSavingsPercent: number;
}

export interface RtkVerifyResult {
  passed: boolean;
  outcomes: RtkFilterTestOutcome[];
  filtersWithoutTests: string[];
  benchmark: RtkFilterBenchmarkRow[];
  diagnostics: RtkFilterLoadDiagnostic[];
  fixtureOutcomes?: RtkFilterTestOutcome[];
}

function trimComparable(value: string): string {
  return value.replace(/\n+$/g, "");
}

export function runRtkFilterTests(
  options: {
    requireAll?: boolean;
    customFiltersEnabled?: boolean;
    trustProjectFilters?: boolean;
  } = {}
): RtkVerifyResult {
  const filters = loadRtkFilters({
    refresh: true,
    customFiltersEnabled: options.customFiltersEnabled,
    trustProjectFilters: options.trustProjectFilters,
  });
  const outcomes: RtkFilterTestOutcome[] = [];
  const filtersWithoutTests: string[] = [];
  const benchmarkByCategory = new Map<
    string,
    { filters: Set<string>; tests: number; savingsTotal: number }
  >();

  for (const filter of filters) {
    const categoryStats = benchmarkByCategory.get(filter.category) ?? {
      filters: new Set<string>(),
      tests: 0,
      savingsTotal: 0,
    };
    categoryStats.filters.add(filter.id);
    benchmarkByCategory.set(filter.category, categoryStats);

    if (filter.tests.length === 0) {
      filtersWithoutTests.push(filter.id);
      continue;
    }

    for (const test of filter.tests) {
      const result = applyLineFilter(test.input, filter).text;
      const actual = trimComparable(result);
      const expected = trimComparable(test.expected);
      const originalTokens = estimateCompressionTokens(test.input);
      const compressedTokens = estimateCompressionTokens(result);
      const savings =
        originalTokens > 0 ? ((originalTokens - compressedTokens) / originalTokens) * 100 : 0;
      categoryStats.tests += 1;
      categoryStats.savingsTotal += Math.max(0, savings);
      outcomes.push({
        filterId: filter.id,
        testName: test.name,
        passed: actual === expected,
        actual,
        expected,
      });
    }
  }

  const benchmark = Array.from(benchmarkByCategory.entries())
    .map(([category, value]) => ({
      category,
      filters: value.filters.size,
      tests: value.tests,
      averageSavingsPercent:
        value.tests > 0 ? Math.round((value.savingsTotal / value.tests) * 100) / 100 : 0,
    }))
    .sort((a, b) => a.category.localeCompare(b.category));

  const failed = outcomes.some((outcome) => !outcome.passed);
  return {
    passed: !failed && (!options.requireAll || filtersWithoutTests.length === 0),
    outcomes,
    filtersWithoutTests,
    benchmark,
    diagnostics: options.customFiltersEnabled === false ? [] : getRtkFilterLoadDiagnostics(),
  };
}

export function verifyRtkFixture(
  assertion: RtkFixtureAssertion,
  options: { customFiltersEnabled?: boolean; trustProjectFilters?: boolean } = {}
): RtkFilterTestOutcome {
  const matched = matchRtkFilter(assertion.input, assertion.command, {
    customFiltersEnabled: options.customFiltersEnabled,
    trustProjectFilters: options.trustProjectFilters,
  });

  if (assertion.negativeMatchExpected) {
    const passed = matched === null || matched.id === "generic-output";
    return {
      filterId: "negative-match",
      testName: assertion.name,
      passed,
      actual: matched ? `matched:${matched.id}` : "no-match",
      expected: "no-match",
      matchedFilterId: matched?.id ?? null,
    };
  }

  if (assertion.expectedFilterId !== undefined) {
    if (assertion.expectedFilterId === null) {
      if (matched !== null) {
        return {
          filterId: "expected-filter-match",
          testName: assertion.name,
          passed: false,
          actual: matched.id,
          expected: "null",
          matchedFilterId: matched.id,
        };
      }
    } else if (matched?.id !== assertion.expectedFilterId) {
      return {
        filterId: assertion.expectedFilterId,
        testName: assertion.name,
        passed: false,
        actual: matched?.id ?? "none",
        expected: assertion.expectedFilterId,
        matchedFilterId: matched?.id ?? null,
      };
    }
  }

  const processed = processRtkText(assertion.input, {
    command: assertion.command,
  });

  const actual = trimComparable(processed.text);
  const expected =
    assertion.expectedOutput !== undefined
      ? trimComparable(assertion.expectedOutput)
      : assertion.passthroughExpected
        ? trimComparable(assertion.input)
        : actual;

  const passthroughMatches =
    assertion.passthroughExpected !== undefined
      ? assertion.passthroughExpected
        ? processed.text === assertion.input
        : processed.text !== assertion.input
      : true;

  const passed =
    passthroughMatches && (assertion.expectedOutput === undefined || actual === expected);

  return {
    filterId: matched?.id ?? "none",
    testName: assertion.name,
    passed,
    actual,
    expected,
    passthrough: processed.text === assertion.input,
    matchedFilterId: matched?.id ?? null,
  };
}
