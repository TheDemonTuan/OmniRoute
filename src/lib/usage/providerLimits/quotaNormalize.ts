import {
  isUserCallableAntigravityModelId,
  toClientAntigravityModelId,
} from "@omniroute/open-sse/config/antigravityModelAliases.ts";
import { isUserCallableAgyModelId } from "@omniroute/open-sse/config/agyModels.ts";

type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Whether a quota bucket may be shown for `provider`.
 *
 * `liveModelIds` is the provider's live discovery catalog when the caller has it: a model
 * the connection actually reports is always allowed, so a tier Google ships between two
 * OmniRoute releases keeps its quota instead of being dropped. The static catalogs stay as
 * the fallback for cold start / logged-out / discovery-failure.
 */
export function isUsageQuotaKeyAllowed(
  provider: string,
  quotaKey: string,
  liveModelIds?: ReadonlySet<string>
): boolean {
  if (quotaKey === "credits" || quotaKey === "models") return true;
  if (provider !== "antigravity" && provider !== "agy") return true;
  if (liveModelIds?.has(quotaKey)) return true;
  if (provider === "antigravity") return isUserCallableAntigravityModelId(quotaKey);
  return isUserCallableAgyModelId(quotaKey);
}

export function normalizeUsageQuotaKey(
  provider: string,
  quotaKey: string,
  liveModelIds?: ReadonlySet<string>
): string | null {
  if (quotaKey === "credits" || quotaKey === "models") return quotaKey;
  if (provider === "antigravity" || provider === "agy") {
    const clientKey = toClientAntigravityModelId(quotaKey);
    return isUsageQuotaKeyAllowed(provider, clientKey, liveModelIds) ? clientKey : null;
  }
  return isUsageQuotaKeyAllowed(provider, quotaKey, liveModelIds) ? quotaKey : null;
}

export function normalizeUsageQuotasForProvider(
  provider: string,
  quotas: JsonRecord | null | undefined,
  liveModelIds?: ReadonlySet<string>
): JsonRecord | null {
  if (!isRecord(quotas)) return quotas ?? null;

  const normalized: JsonRecord = {};
  let changed = false;

  for (const [quotaKey, quota] of Object.entries(quotas)) {
    const normalizedKey = normalizeUsageQuotaKey(provider, quotaKey, liveModelIds);
    if (!normalizedKey) {
      changed = true;
      continue;
    }

    const existing = normalized[normalizedKey];
    if (existing && isRecord(existing) && isRecord(quota)) {
      const existingSource = String(existing.quotaSource ?? "");
      const nextSource = String(quota.quotaSource ?? "");
      const sourceRank: Record<string, number> = {
        fetchAvailableModels: 0,
        localUsageHistory: 1,
        retrieveUserQuota: 2,
      };
      if ((sourceRank[existingSource] ?? 0) > (sourceRank[nextSource] ?? 0)) {
        continue;
      }
    }

    normalized[normalizedKey] = quota as JsonRecord;
    if (normalizedKey !== quotaKey) changed = true;
  }

  return changed ? normalized : quotas;
}

export function sanitizeUsageQuotasForProvider(
  provider: string,
  usage: JsonRecord,
  liveModelIds?: ReadonlySet<string>
): JsonRecord {
  if (provider !== "antigravity" && provider !== "agy") return usage;
  if (!isRecord(usage.quotas)) return usage;

  const sanitizedQuotas = normalizeUsageQuotasForProvider(provider, usage.quotas, liveModelIds);
  return sanitizedQuotas === usage.quotas ? usage : { ...usage, quotas: sanitizedQuotas };
}
