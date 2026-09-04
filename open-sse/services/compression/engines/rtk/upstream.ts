export interface RtkUpstreamBaseline {
  project: string;
  stableTag: string;
  auditedAt: string;
  license: string;
  parityScope: "behavioral-semantic";
}

export const RTK_UPSTREAM_BASELINE: RtkUpstreamBaseline = Object.freeze({
  project: "rtk-ai/rtk",
  stableTag: "v0.47.0",
  auditedAt: "2026-09-04",
  license: "Apache-2.0",
  parityScope: "behavioral-semantic",
});
