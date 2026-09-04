import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  RTK_UPSTREAM_BASELINE,
  RTK_PARITY_MANIFEST,
  loadRtkFilters,
  getRtkFilterCatalog,
} from "../../../open-sse/services/compression/index.ts";

describe("RTK Upstream v0.47.0 Parity Manifest", () => {
  it("exports baseline metadata pinned to v0.47.0", () => {
    assert.equal(RTK_UPSTREAM_BASELINE.project, "rtk-ai/rtk");
    assert.equal(RTK_UPSTREAM_BASELINE.stableTag, "v0.47.0");
    assert.equal(RTK_UPSTREAM_BASELINE.license, "Apache-2.0");
    assert.equal(RTK_UPSTREAM_BASELINE.parityScope, "behavioral-semantic");
  });

  it("manifest covers all built-in filters on disk", () => {
    const filters = loadRtkFilters({ refresh: true, customFiltersEnabled: false });
    const manifestFilterIds = new Set(RTK_PARITY_MANIFEST.filters.map((f) => f.id));

    assert.equal(RTK_PARITY_MANIFEST.upstreamTag, "v0.47.0");
    assert.ok(filters.length >= 58, `Expected at least 58 filters, got ${filters.length}`);

    for (const filter of filters) {
      assert.ok(
        manifestFilterIds.has(filter.id),
        `Filter "${filter.id}" on disk must be present in parity manifest`
      );
    }
  });

  it("manifest includes new v0.47.0 filters: ctest, maven, and phpt", () => {
    const v047Filters = RTK_PARITY_MANIFEST.filters.filter(
      (f) => f.upstreamVersionIntroduced === "v0.47.0"
    );
    const ids = v047Filters.map((f) => f.id);
    assert.ok(ids.includes("test-ctest"));
    assert.ok(ids.includes("maven"));
    assert.ok(ids.includes("test-phpt"));
  });

  it("catalog reflects dynamic filter count", () => {
    const catalog = getRtkFilterCatalog();
    assert.ok(catalog.length >= 58);
    assert.ok(catalog.some((c) => c.id === "test-ctest"));
    assert.ok(catalog.some((c) => c.id === "maven"));
    assert.ok(catalog.some((c) => c.id === "test-phpt"));
  });
});
