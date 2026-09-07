/**
 * StarkscanProofProvider — mainnet async prover (POST /v1/SN_MAIN/prove → poll).
 * Mainnet-only; reads STARKSCAN_API_KEY as Worker secret (never logged).
 * Persists jobId via putJob (idem→jobId) and proof once-only via putProof.
 * Handles pollAfterSeconds (cap 30s), maxAttempts, attestation 300-30-5, KV rate limit.
 */
import { BudgetExhaustedError, StarkscanRetryableError, StarkscanTerminalError, classifyStarkscanError } from "./errors";
import { getJob, getProof, putJob, putProof, type StarkscanKvNamespace, type StarkscanProofRecord } from "./starkscan-persistence";

export const STARKSCAN_BASE_URL = "https://api.starkscan.co";
export const STARKSCAN_PROVE_PATH = "/v1/SN_MAIN/prove";
export const ATTESTATION_MAX_AGE = 300;
export const ATTESTATION_MARGIN = 30;
export const ATTESTATION_SKEW = 5;
export const ATTESTATION_VALID_WINDOW = ATTESTATION_MAX_AGE - ATTESTATION_MARGIN - ATTESTATION_SKEW; // 265
export const DEFAULT_DAILY_BUDGET = 100;
export const DEFAULT_MAX_ATTEMPTS = 30;
export const MAX_POLL_MS = 30_000;
export const BASE_POLL_MS = 1_000;
export const RATE_LIMIT_PREFIX = "starkscan:budget:";

export type StarkscanProveInput = { transaction: unknown; blockId: unknown; idempotencyKey?: string };
export type StarkscanProveResult = { jobId: string; proof: string[]; proofFacts: string[]; additionalData?: { signature: string; issuedAt: number } };
type PollJson = {
  status?: string; pollAfterSeconds?: number; poll_after_seconds?: number;
  result?: { proof?: string[]; proof_facts?: string[]; proofFacts?: string[]; additional_data?: { signature: string; issued_at?: number; issuedAt?: number }; additionalData?: { signature: string; issuedAt?: number } };
  error?: { code?: string | number; message?: string; retryAfter?: number; retry_after?: number }; code?: string | number; message?: string; retryAfter?: number;
};
export type StarkscanProofProviderOptions = { apiKey: string; kv: StarkscanKvNamespace; dailyBudget?: number; baseUrl?: string; maxAttempts?: number; fetchImpl?: typeof fetch };

export function hashApiKey(apiKey: string): string { let h = 0; for (let i = 0; i < apiKey.length; i++) h = (h * 31 + apiKey.charCodeAt(i)) >>> 0; return h.toString(16).padStart(8, "0"); }
export function utcDateString(d = new Date()): string { return d.toISOString().slice(0, 10); }
export function secondsUntilMidnight(now = Date.now()): number { const n = new Date(now); n.setUTCHours(24, 0, 0, 0); return Math.max(1, Math.ceil((n.getTime() - now) / 1000)); }
function ttlUntilMidnight(): number { return secondsUntilMidnight(); }
function rateLimitKey(apiKey: string): string { return `${RATE_LIMIT_PREFIX}${hashApiKey(apiKey)}:${utcDateString()}`; }
export function isAttestationValid(issuedAt: number, nowSec = Date.now() / 1000): boolean { return nowSec < issuedAt + ATTESTATION_VALID_WINDOW; }
export function validateAttestation(additionalData: { signature: string; issued_at?: number; issuedAt?: number } | undefined, nowSec = Date.now() / 1000): { signature: string; issuedAt: number } | undefined {
  if (!additionalData) return undefined;
  const raw = (additionalData as { issuedAt?: number; issued_at?: number }).issuedAt ?? (additionalData as { issued_at?: number }).issued_at;
  if (raw == null) throw new StarkscanTerminalError("Missing attestation issued_at", "attestation_missing");
  const issuedAt = Number(raw);
  if (!isAttestationValid(issuedAt, nowSec)) throw new StarkscanTerminalError(`Attestation expired: issued_at=${issuedAt} now=${Math.floor(nowSec)} window=${ATTESTATION_VALID_WINDOW}s`, "attestation_expired");
  return { signature: additionalData.signature, issuedAt };
}
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
function parseRetryAfter(res: Response, body?: PollJson): number | undefined {
  const h = res.headers.get("retry-after") ?? res.headers.get("Retry-After");
  if (h) { const n = Number(h); if (!Number.isNaN(n)) return n; }
  const v = body?.retryAfter ?? body?.error?.retryAfter ?? body?.error?.retry_after;
  if (v != null) return Number(v);
  return undefined;
}
function extractJobId(json: unknown): string | undefined { const j = json as Record<string, unknown>; return (j.jobId as string) ?? (j.job_id as string) ?? (j.id as string); }

/**
 * Mainnet-only Starkscan prover.
 * - Endpoint: POST/GET https://api.starkscan.co/v1/SN_MAIN/prove (SN_MAIN only; Sepolia via mock/self-hosted).
 * - Secret: STARKSCAN_API_KEY must be a Worker secret (wrangler secret put), never in [vars], never logged.
 * - Rollback: clear the secret → VaultService falls back to PROVING_SERVICE_URL or mock.
 */
export class StarkscanProofProvider {
  private apiKey: string; private kv: StarkscanKvNamespace; private dailyBudget: number; private baseUrl: string; private maxAttempts: number; private fetchImpl: typeof fetch;
  constructor(opts: StarkscanProofProviderOptions) {
    if (!opts.apiKey) throw new StarkscanTerminalError("STARKSCAN_API_KEY missing", "missing_api_key");
    this.apiKey = opts.apiKey; this.kv = opts.kv; this.dailyBudget = opts.dailyBudget ?? DEFAULT_DAILY_BUDGET;
    this.baseUrl = (opts.baseUrl ?? STARKSCAN_BASE_URL).replace(/\/$/, ""); this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as typeof fetch);
    if (!this.fetchImpl) throw new StarkscanTerminalError("fetch unavailable", "missing_fetch");
  }
  private headers(idem?: string): Record<string, string> {
    const h: Record<string, string> = { "X-Starkscan-Api-Key": this.apiKey, "Content-Type": "application/json", Accept: "application/json" };
    if (idem) h["Idempotency-Key"] = idem; return h;
  }
  private async checkRateLimit(): Promise<void> {
    const raw = await this.kv.get(rateLimitKey(this.apiKey)); const count = raw ? Number(raw) : 0;
    if (count >= this.dailyBudget) throw new BudgetExhaustedError(`Daily budget ${this.dailyBudget} reached`, "prover_daily_budget_exhausted", secondsUntilMidnight());
  }
  private async incrementRateLimit(): Promise<void> {
    const key = rateLimitKey(this.apiKey); const raw = await this.kv.get(key); const count = raw ? Number(raw) : 0;
    await this.kv.put(key, String(count + 1), { expirationTtl: ttlUntilMidnight() });
  }
  async submitJob(input: StarkscanProveInput): Promise<string> {
    const idem = input.idempotencyKey ?? (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2));
    const existing = await getJob(this.kv, idem); if (existing) return existing;
    await this.checkRateLimit();
    const url = `${this.baseUrl}${STARKSCAN_PROVE_PATH}`;
    const body = JSON.stringify({ transaction: input.transaction, blockId: input.blockId, block_id: input.blockId });
    const res = await this.fetchImpl(url, { method: "POST", headers: this.headers(idem), body });
    const text = await res.text(); let json: PollJson & Record<string, unknown> = {};
    try { json = text ? (JSON.parse(text) as PollJson) : {}; } catch { json = {}; }
    if (res.status === 202) {
      const jobId = extractJobId(json); if (!jobId) throw new StarkscanTerminalError("202 without jobId", "missing_jobId");
      await putJob(this.kv, idem, jobId); await this.incrementRateLimit(); return jobId;
    }
    const code = (json as PollJson).error?.code ?? (json as PollJson).code ?? res.status;
    const msg = (json as PollJson).error?.message ?? (json as PollJson).message ?? `Submit failed ${res.status}`;
    throw classifyStarkscanError(code as string | number, msg, parseRetryAfter(res, json as PollJson));
  }
  async pollJob(jobId: string, opts?: { maxAttempts?: number }): Promise<StarkscanProveResult> {
    const cached = await getProof(this.kv, jobId);
    if (cached) return { jobId, proof: cached.proof, proofFacts: cached.proofFacts, additionalData: cached.additionalData };
    const maxAttempts = opts?.maxAttempts ?? this.maxAttempts;
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const url = `${this.baseUrl}${STARKSCAN_PROVE_PATH}/${jobId}`;
      let res: Response;
      try { res = await this.fetchImpl(url, { method: "GET", headers: this.headers() }); } catch (e) {
        lastError = e as Error; await sleep(Math.min(BASE_POLL_MS * 2 ** attempt, MAX_POLL_MS)); continue;
      }
      const text = await res.text(); let json: PollJson = {};
      try { json = text ? (JSON.parse(text) as PollJson) : {}; } catch { json = {}; }
      if (!res.ok) {
        const code = json.error?.code ?? json.code ?? res.status;
        const msg = json.error?.message ?? json.message ?? `Poll failed ${res.status}`;
        const classified = classifyStarkscanError(code as string | number, msg, parseRetryAfter(res, json));
        if (classified instanceof StarkscanTerminalError || classified instanceof BudgetExhaustedError) throw classified;
        const hint = (json.pollAfterSeconds ?? json.poll_after_seconds ?? 0) * 1000;
        await sleep(Math.max(hint, Math.min(BASE_POLL_MS * 2 ** attempt, MAX_POLL_MS)));
        lastError = classified; continue;
      }
      const status = (json.status ?? "").toLowerCase();
      if (status === "pending" || status === "processing" || status === "queued" || status === "running") {
        const hintMs = (json.pollAfterSeconds ?? json.poll_after_seconds ?? 0) * 1000;
        const backoff = Math.min(BASE_POLL_MS * 2 ** attempt, MAX_POLL_MS);
        const waitMs = hintMs ? Math.min(Math.max(hintMs, backoff), MAX_POLL_MS) : backoff;
        if (json.error?.code != null) {
          const c = classifyStarkscanError(json.error.code as string | number, json.error.message, json.error.retryAfter);
          if (c instanceof StarkscanTerminalError || c instanceof BudgetExhaustedError) throw c; lastError = c;
        }
        await sleep(waitMs); continue;
      }
      if (json.error?.code != null) {
        const c = classifyStarkscanError(json.error.code as string | number, json.error.message, json.error.retryAfter);
        if (c instanceof StarkscanTerminalError || c instanceof BudgetExhaustedError) throw c;
        const hintMs = (json.pollAfterSeconds ?? json.poll_after_seconds ?? 0) * 1000;
        await sleep(Math.max(hintMs, Math.min(BASE_POLL_MS * 2 ** attempt, MAX_POLL_MS)));
        lastError = c; continue;
      }
      const result = json.result;
      if (result?.proof || result?.proof_facts || result?.proofFacts) {
        const proof = result.proof ?? []; const proofFacts = result.proof_facts ?? result.proofFacts ?? [];
        const additionalDataRaw = result.additional_data ?? result.additionalData;
        const additionalData = validateAttestation(additionalDataRaw as never);
        const record: StarkscanProofRecord = { jobId, proof, proofFacts, additionalData, storedAt: Date.now() };
        await putProof(this.kv, jobId, record);
        return { jobId, proof, proofFacts, additionalData };
      }
      if (status === "completed" || status === "success" || status === "succeeded") {
        const hintMs = (json.pollAfterSeconds ?? json.poll_after_seconds ?? 0) * 1000;
        await sleep(Math.max(hintMs || 0, Math.min(BASE_POLL_MS * 2 ** attempt, MAX_POLL_MS))); continue;
      }
      if (status === "failed") {
        const code = json.error?.code ?? json.code ?? "failed";
        throw classifyStarkscanError(code as string | number, json.error?.message ?? json.message);
      }
      const hintMs = (json.pollAfterSeconds ?? json.poll_after_seconds ?? 0) * 1000;
      await sleep(Math.max(hintMs || 0, Math.min(BASE_POLL_MS * 2 ** attempt, MAX_POLL_MS)));
    }
    throw new StarkscanRetryableError(`Poll maxAttempts ${maxAttempts} exhausted for job ${jobId}`, "max_attempts_exhausted");
  }
  async prove(input: StarkscanProveInput): Promise<StarkscanProveResult> { const jobId = await this.submitJob(input); return this.pollJob(jobId); }
  async getBudgetState(): Promise<{ count: number; remaining: number }> {
    const raw = await this.kv.get(rateLimitKey(this.apiKey)); const count = raw ? Number(raw) : 0;
    return { count, remaining: Math.max(0, this.dailyBudget - count) };
  }
}
export function createStarkscanProviderFromEnv(env: { STARKSCAN_API_KEY?: string; STARKSCAN_DAILY_BUDGET?: string }, kv: StarkscanKvNamespace, opts?: Partial<Omit<StarkscanProofProviderOptions, "apiKey" | "kv">>): StarkscanProofProvider | null {
  const key = env.STARKSCAN_API_KEY?.trim(); if (!key) return null;
  const budget = env.STARKSCAN_DAILY_BUDGET ? Number(env.STARKSCAN_DAILY_BUDGET) : undefined;
  return new StarkscanProofProvider({ apiKey: key, kv, dailyBudget: budget, ...opts });
}
export { classifyStarkscanError };
