import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getRtkFilterCatalog } from "../open-sse/services/compression/engines/rtk/filterLoader.ts";
import { RTK_PARITY_MANIFEST } from "../open-sse/services/compression/engines/rtk/parityManifest.ts";
import { RTK_UPSTREAM_BASELINE } from "../open-sse/services/compression/engines/rtk/upstream.ts";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docsPath = path.join(rootDir, "docs", "compression", "RTK_COMPRESSION.md");

const catalog = getRtkFilterCatalog();
const familyRows = RTK_PARITY_MANIFEST.families
  .map((family) => {
    const gaps = family.gaps.length === 0 ? "—" : family.gaps.join(", ");
    return `| ${family.family} | ${family.filterIds.join(", ")} | ${family.parity} | ${gaps} |`;
  })
  .join("\n");

const generated = `<!-- RTK_GENERATED_START -->
## RTK ${RTK_UPSTREAM_BASELINE.stableTag} parity status

- **Upstream baseline:** [${RTK_UPSTREAM_BASELINE.project} ${RTK_UPSTREAM_BASELINE.stableTag}](https://github.com/${RTK_UPSTREAM_BASELINE.project}/releases/tag/${RTK_UPSTREAM_BASELINE.stableTag})
- **Parity target:** behavioral-semantic, independent TypeScript implementation.
- **Built-in filter catalog:** ${catalog.length} filters, computed dynamically from source.
- **Measurement policy:** OmniRoute does not claim compounded or upstream-derived savings as local benchmark results. Savings must be measured from OmniRoute's fixture corpus.

| Family | Filter IDs | Parity | Known gaps |
| --- | --- | --- | --- |
${familyRows}

<!-- RTK_GENERATED_END -->`;

const source = fs.readFileSync(docsPath, "utf8");
const start = "<!-- RTK_GENERATED_START -->";
const end = "<!-- RTK_GENERATED_END -->";
const startIndex = source.indexOf(start);
const endIndex = source.indexOf(end);
const updated =
  startIndex !== -1 && endIndex !== -1
    ? `${source.slice(0, startIndex)}${generated}${source.slice(endIndex + end.length)}`
    : `${source}\n\n${generated}\n`;

fs.writeFileSync(docsPath, updated);
console.log(`Generated RTK docs for ${catalog.length} filters.`);
