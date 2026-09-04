import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRtkFilters } from "../open-sse/services/compression/engines/rtk/filterLoader.ts";
import { RTK_PARITY_MANIFEST } from "../open-sse/services/compression/engines/rtk/parityManifest.ts";
import { RTK_UPSTREAM_BASELINE } from "../open-sse/services/compression/engines/rtk/upstream.ts";
import { listRtkProcessorIds } from "../open-sse/services/compression/engines/rtk/processors/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const filtersDir = path.join(
  rootDir,
  "open-sse",
  "services",
  "compression",
  "engines",
  "rtk",
  "filters"
);
const fixtureRoot = path.join(rootDir, "tests", "unit", "compression", "fixtures", "rtk");

function assertCompilable(pattern: string, description: string): void {
  try {
    new RegExp(pattern);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${description} is not a valid regular expression: ${message}`);
  }
}

function checkFilters(): void {
  console.log("Checking RTK filter definitions...");
  const files = fs.readdirSync(filtersDir).filter((f) => f.endsWith(".json"));
  const filters = loadRtkFilters({ refresh: true, customFiltersEnabled: false });
  const processorIds = new Set(listRtkProcessorIds());

  const filterIds = new Set<string>();
  for (const filter of filters) {
    if (filterIds.has(filter.id)) {
      throw new Error(`Duplicate filter ID found: ${filter.id}`);
    }
    filterIds.add(filter.id);

    for (const pattern of [
      ...filter.commandPatterns,
      ...filter.matchPatterns,
      ...filter.stripPatterns,
      ...filter.keepPatterns,
      ...filter.priorityPatterns,
      ...filter.collapsePatterns,
      ...(filter.commandPolicy?.passthroughPatterns ?? []),
      ...(filter.commandPolicy?.supportedPatterns ?? []),
    ]) {
      assertCompilable(pattern, `Filter '${filter.id}' pattern '${pattern}'`);
    }

    if (filter.processor && !processorIds.has(filter.processor)) {
      throw new Error(
        `Filter '${filter.id}' references unregistered processor '${filter.processor}'.`
      );
    }
  }

  console.log(`Loaded ${filters.length} filters across ${files.length} JSON files.`);

  // Check manifest completeness (disk -> manifest) and reverse completeness.
  const manifestFilterIds = new Set(RTK_PARITY_MANIFEST.filters.map((f) => f.id));
  for (const filter of filters) {
    if (!manifestFilterIds.has(filter.id)) {
      throw new Error(`Filter on disk '${filter.id}' missing from parity manifest.`);
    }
  }
  for (const item of RTK_PARITY_MANIFEST.filters) {
    if (!filterIds.has(item.id)) {
      throw new Error(`Manifest filter '${item.id}' does not exist on disk.`);
    }
  }

  // Validate parity claims against fixture groups and stateful filter ownership.
  const claimedProcessors = new Set<string>();
  for (const family of RTK_PARITY_MANIFEST.families) {
    if ((family.parity === "full" || family.parity === "semantic") && family.gaps.length > 0) {
      throw new Error(
        `Family '${family.family}' claims '${family.parity}' while listing unresolved gaps.`
      );
    }
    for (const fixtureGroup of family.fixtureGroups) {
      const fixturePath = path.join(fixtureRoot, fixtureGroup);
      if (!fs.existsSync(fixturePath)) {
        throw new Error(
          `Family '${family.family}' references missing fixture group '${fixtureGroup}'.`
        );
      }
    }
    for (const filterId of family.filterIds) {
      const filter = filters.find((entry) => entry.id === filterId);
      if (filter?.processor) claimedProcessors.add(filter.processor);
    }
  }

  for (const processorId of processorIds) {
    if (!claimedProcessors.has(processorId)) {
      throw new Error(
        `Registered processor '${processorId}' has no parity-manifest filter ownership.`
      );
    }
  }

  console.log(`Parity manifest valid against ${RTK_UPSTREAM_BASELINE.stableTag}.`);
}

try {
  checkFilters();
  console.log("All RTK filters, processors, fixtures, and parity contracts verified.");
} catch (err) {
  console.error("Parity check failed:", err);
  process.exit(1);
}
