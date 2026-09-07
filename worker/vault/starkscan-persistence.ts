/**
 * Starkscan KV persistence helpers — jobId ↔ Idempotency-Key and once-only proof storage.
 *
 * TTL 24h (86400s) for both mappings. `putProof` is once-only: if a proof for
 * the jobId already exists it is NOT overwritten (delivered-once semantics).
 *
 * KV namespace is expected to be PROOF_JOBS (or SESSIONS fallback) with binding
 * `PROOF_JOBS` / `SESSIONS`. Helpers accept any KVNamespace-like object so they
 * are testable with a mock KV.
 */

export const STARKSCAN_TTL_SECONDS = 86_400; // 24h
export const STARKSCAN_JOB_PREFIX = "starkscan:job:";
export const STARKSCAN_PROOF_PREFIX = "starkscan:proof:";

export type StarkscanProofRecord = {
  jobId: string;
  proof: string[];
  proofFacts: string[];
  additionalData?: { signature: string; issuedAt: number };
  storedAt: number;
};

export type StarkscanKvNamespace = {
  get(key: string, opts?: unknown): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete?(key: string): Promise<void>;
};

function jobKey(idempotencyKey: string): string {
  return `${STARKSCAN_JOB_PREFIX}${idempotencyKey}`;
}

function proofKey(jobId: string): string {
  return `${STARKSCAN_PROOF_PREFIX}${jobId}`;
}

/** Persist 202 jobId keyed by Idempotency-Key (TTL 24h). */
export async function putJob(
  kv: StarkscanKvNamespace,
  idempotencyKey: string,
  jobId: string,
): Promise<void> {
  await kv.put(jobKey(idempotencyKey), jobId, { expirationTtl: STARKSCAN_TTL_SECONDS });
}

/** Retrieve jobId for an Idempotency-Key, or null if not found/expired. */
export async function getJob(
  kv: StarkscanKvNamespace,
  idempotencyKey: string,
): Promise<string | null> {
  return kv.get(jobKey(idempotencyKey));
}

/**
 * Persist terminal proof result once-only. If a proof for this jobId already
 * exists the call is a no-op (atomic delivered-once guarantee at app level;
 * KV itself has no CAS, so callers MUST rely on this guard).
 */
export async function putProof(
  kv: StarkscanKvNamespace,
  jobId: string,
  record: StarkscanProofRecord,
): Promise<boolean> {
  const existing = await kv.get(proofKey(jobId));
  if (existing !== null) return false;
  await kv.put(proofKey(jobId), JSON.stringify(record), {
    expirationTtl: STARKSCAN_TTL_SECONDS,
  });
  return true;
}

/** Retrieve a persisted proof record, or null. */
export async function getProof(
  kv: StarkscanKvNamespace,
  jobId: string,
): Promise<StarkscanProofRecord | null> {
  const raw = await kv.get(proofKey(jobId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StarkscanProofRecord;
  } catch {
    return null;
  }
}

/** Whether a proof for this jobId is already persisted. */
export async function hasProof(kv: StarkscanKvNamespace, jobId: string): Promise<boolean> {
  const v = await kv.get(proofKey(jobId));
  return v !== null;
}
