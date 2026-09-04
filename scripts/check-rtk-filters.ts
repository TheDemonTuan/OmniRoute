import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRtkFilters } from "../open-sse/services/compression/engines/rtk/filterLoader.ts";
import { RTK_PARITY_MANIFEST } from "../open-sse/services/compression/engines/rtk/parityManifest.ts";
import { RTK_UPSTREAM_BASELINE } from "../open-sse/services/compression/engines/rtk/upstream.ts";

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

function checkFilters(): void {
  console.log("Checking RTK filter definitions...");
  const files = fs.readdirSync(filtersDir).filter((f) => f.endsWith(".json"));
  const filters = loadRtkFilters({ refresh: true, customFiltersEnabled: false });

  const filterIds = new Set<string>();
  for (const filter of filters) {
    if (filterIds.has(filter.id)) {
      throw new Error(`Duplicate filter ID found: ${filter.id}`);
    }
    filterIds.add(filter.id);
  }

  console.log(`Loaded ${filters.length} filters across ${files.length} JSON files.`);

  // 1. Check manifest completeness (disk -> manifest)
  const manifestFilterIds = new Set(RTK_PARITY_MANIFEST.filters.map((f) => f.id));
  for (const filter of filters) {
    if (!manifestFilterIds.has(filter.id)) {
      throw new Error(`Filter on disk '${filter.id}' missing from parity manifest.`);
    }
  }

  // 2. Check reverse completeness (manifest -> disk)
  for (const item of RTK_PARITY_MANIFEST.filters) {
    if (!filterIds.has(item.id)) {
      throw new Error(`Manifest filter '${item.id}' does not exist on disk.`);
    }
  }

  // 3. Check families and parity claims
  for (const family of RTK_PARITY_MANIFEST.families) {
    if (family.parity === "full" && family.gaps.length > 0) {
      throw new Error(`Family '${family.family}' is marked 'full' but has non-empty gaps.`);
    }
  }

  console.log(`Parity manifest valid against ${RTK_UPSTREAM_BASELINE.stableTag}.`);
}

try {
  checkFilters();
  console.log("All RTK filters and parity contracts verified.");
} catch (err) {
  console.error("Parity check failed:", err);
  process.exit(1);
}
