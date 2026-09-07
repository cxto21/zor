/**
 * Prover on-demand helper — Freestyle snapshot branch + idle pause.
 *
 * Freestyle base VM  : zor-prover-base  (paused, 4 vCPU / 8 GiB / 32 GB)
 * Ready snapshot     : zor-prover-ready / sh-047525dc83b245c69c5b4e7262a481ca
 *   - Ubuntu 24.04, docker 29, image ghcr.io/starkware-libs/starknet-privacy/transaction-prover:PRIVACY-0.14.3-RC.2 pre-pulled
 *   - /home/ubuntu/run-prover.sh + systemd units zor-prover.service / zor-prover-mock.service
 * Free tier limits  : 200 vCPUh + 400 GiB*h free per month (pricing.md). A prover at 4 vCPU/8 GiB
 *   burns 4 vCPUh + 8 GiB*h per wall-clock hour. 200 vCPUh ≈ 50h of prover runtime/month free.
 *   Snapshots & paused VMs bill only disk (32 GiB * $0.000086 ≈ $0.0027/h → negligible, free tier 60k GiB*h).
 *
 * Flow (ensureProverUrl):
 * 1. If env.PROVING_SERVICE_URL is set, health-check it and return it (fast path).
 * 2. If env.FREESTYLE_API_KEY is set, try to wake a prover VM via Freestyle API:
 *    POST /v5/vms { slug, snapshotId: zor-prover-ready, firewall: outbound, idleTimeoutSeconds: 65,
 *                    tls: { rules: [{action:"allow", domain:"zor-prover-<rand>.style.dev", source:{public:true}, destination:{port:3000}}] } }
 *    Snapshot branch is <400ms p99. Poll GET /v5/vms/{id} until state=running, then GET https://<domain>/health.
 * 3. On any failure (auth, capacity, SIGILL hardware), return null → caller falls back to
 *    CallMockProofProvider (mock VIRTUAL_SNOS — correct apply_actions structure, no real proofFacts).
 *
 * Pause after use: idleTimeoutSeconds=65 on the VM handles auto-pause when no prover RPC hits arrive
 * for 65s. Worker also exposes POST /prover-wake and POST /prover-pause helpers.
 *
 * Secrets: FREESTYLE_API_KEY must be set as a Worker secret, never committed:
 *   wrangler secret put FREESTYLE_API_KEY   # paste UgykZj... value from .env
 *   or: echo $FREESTYLE_API_KEY | wrangler secret put FREESTYLE_API_KEY
 */

const FREESTYLE_API_BASE = "https://api.freestyle.sh/v5";
// Private snapshot that this repo provisioned on 2026-09-02
const READY_SNAPSHOT_SLUG = "zor-prover-ready";
const READY_SNAPSHOT_ID = "sh-047525dc83b245c69c5b4e7262a481ca";
const PROVER_PORT = 3000;

// In-worker memory cache — avoids creating a VM per request
let cachedUrl: string | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 55_000; // slightly less than VM idle timeout (65s)

export interface ProverEnv {
  PROVING_SERVICE_URL?: string;
  FREESTYLE_API_KEY?: string;
  STARKNET_RPC_URL?: string;
  STARKSCAN_API_KEY?: string;
}

type EnsureResult =
  | { url: string; source: "env" | "freestyle"; vmId?: string; domain?: string; mock: false }
  | { url: null; source: "mock"; reason: string; mock: true };

async function healthOk(url: string): Promise<boolean> {
  try {
    const h = url.replace(/\/$/, "") + "/health";
    const r = await fetch(h, { method: "GET", headers: { Accept: "application/json" } });
    // 200 ok = real prover; 503 mock = fallback health from SIGILL vm (still counts as reachable)
    return r.ok || r.status === 503;
  } catch {
    return false;
  }
}

async function freestyleFetch(apiKey: string, path: string, init: RequestInit = {}) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };
  const res = await fetch(`${FREESTYLE_API_BASE}${path}`, { ...init, headers });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { ok: res.ok, status: res.status, json, text };
}

/**
 * Try to branch a prover VM from the ready snapshot.
 * Returns the VM object + chosen domain on success.
 */
async function branchProverVm(
  apiKey: string
): Promise<{ vmId: string; domain: string; vm: unknown } | null> {
  const rand = Math.random().toString(36).slice(2, 8);
  const slug = `zor-prover-${Date.now().toString(36)}-${rand}`;
  const domain = `zor-prover-${rand}.style.dev`;

  // Prefer the slug (human readable, branchable) but fall back to id if slug not resolved
  const snapshotId = READY_SNAPSHOT_SLUG;

  const body = {
    slug,
    snapshotId,
    firewall: { rules: [{ action: "allow", source: {}, destination: { public: true } }] },
    idleTimeoutSeconds: 65,
    maxRunSeconds: 3600,
    metadata: { project: "zor", purpose: "prover-ondemand" },
    tls: {
      rules: [
        {
          action: "allow",
          domain,
          source: { public: true },
          destination: { port: PROVER_PORT },
        },
      ],
    },
  };

  let res = await freestyleFetch(apiKey, "/vms", {
    method: "POST",
    body: JSON.stringify(body),
  });

  // If slug snapshot not found (account mismatch), try the immutable id
  if (!res.ok && res.status === 400 && String(res.text).includes("snapshot")) {
    const retryBody = { ...body, snapshotId: READY_SNAPSHOT_ID };
    res = await freestyleFetch(apiKey, "/vms", {
      method: "POST",
      body: JSON.stringify(retryBody),
    });
  }

  if (!res.ok) {
    console.warn("[ensureProver] freestyle create failed", res.status, res.text.slice(0, 800));
    return null;
  }

  const vm = res.json as Record<string, unknown>;
  const vmId = (vm["id"] as string) || (vm["slug"] as string) || slug;

  // Poll until running (p99 <400ms, but allow a few seconds for TLS propagation)
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const cur = await freestyleFetch(apiKey, `/vms/${vmId}`, { method: "GET" });
    if (cur.ok) {
      const data = cur.json as Record<string, unknown>;
      const state = data["state"] as string;
      if (state === "running") {
        // Wait a heartbeat for guest systemd to bring up docker
        await new Promise((r) => setTimeout(r, 900));
        return { vmId: data["id"] as string, domain, vm: data };
      }
      if (state === "paused" || state === "stopped") {
        // Try to start it
        await freestyleFetch(apiKey, `/vms/${vmId}/start`, { method: "POST" });
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  console.warn("[ensureProver] VM did not reach running in time", vmId);
  return { vmId, domain, vm };
}

/**
 * Ensure a proving service URL is available.
 * Returns the URL to use, or null if the caller should fall back to CallMockProofProvider.
 */
export async function ensureProverUrl(env: ProverEnv): Promise<EnsureResult> {
  // Fast path: env-provided URL (e.g. Fly https://zor-prover.fly.dev)
  if (env.PROVING_SERVICE_URL) {
    const url = env.PROVING_SERVICE_URL.replace(/\/$/, "");
    if (await healthOk(url)) return { url, source: "env", mock: false };
    console.warn("[ensureProver] PROVING_SERVICE_URL health failed, trying Freestyle branch", url);
  }

  // Starkscan-first: when STARKSCAN_API_KEY is set, VaultService selects StarkscanProofProvider
  // (mainnet) and no Freestyle VM is needed. Short-circuit before any VM work.
  if (env.STARKSCAN_API_KEY?.trim()) {
    return { url: null, source: "mock", mock: true, reason: "STARKSCAN_API_KEY set — StarkscanProofProvider active, Freestyle branch skipped" };
  }

  // Memory cache — avoids spamming Freestyle on bursts
  if (cachedUrl && Date.now() - cachedAt < CACHE_TTL_MS) {
    if (await healthOk(cachedUrl)) return { url: cachedUrl, source: "freestyle", mock: false };
    cachedUrl = null;
  }

  if (!env.FREESTYLE_API_KEY) {
    return { url: null, source: "mock", mock: true, reason: "no PROVING_SERVICE_URL and no FREESTYLE_API_KEY — using CallMockProofProvider" };
  }

  try {
    const branched = await branchProverVm(env.FREESTYLE_API_KEY);
    if (!branched) {
      return { url: null, source: "mock", mock: true, reason: "Freestyle branch failed — using mock" };
    }
    const candidate = `https://${branched.domain}`;
    // Health poll (prover takes ~1-2s to bind on first boot; mock health returns 503)
    for (let i = 0; i < 8; i++) {
      if (await healthOk(candidate)) {
        cachedUrl = candidate;
        cachedAt = Date.now();
        return { url: candidate, source: "freestyle", vmId: branched.vmId, domain: branched.domain, mock: false };
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    // Even if health is not 200 yet, return the domain — caller can retry, VM will auto-pause via idleTimeout
    cachedUrl = candidate;
    cachedAt = Date.now();
    return { url: candidate, source: "freestyle", vmId: branched.vmId, domain: branched.domain, mock: false };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[ensureProver] exception", msg);
    return { url: null, source: "mock", mock: true, reason: msg };
  }
}

/**
 * Explicitly pause a prover VM by id (called after 60s idle from a Cron or Durable Object).
 * Not required when idleTimeoutSeconds is set — provided for manual ops.
 */
export async function pauseProverVm(apiKey: string, vmIdOrSlug: string): Promise<boolean> {
  const res = await freestyleFetch(apiKey, `/vms/${vmIdOrSlug}/pause`, { method: "POST" });
  return res.ok;
}

/**
 * Wake the canonical base snapshot into a named on-demand VM. Used by ops scripts
 * and by the fallback path in ensureProverUrl when the cached domain is stale.
 */
export async function wakeProverFromSnapshot(
  apiKey: string,
  opts?: { slug?: string; domain?: string; idleTimeoutSeconds?: number }
): Promise<{ vmId: string; domain: string; url: string }> {
  const slug = opts?.slug ?? `zor-prover-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const domain = opts?.domain ?? `zor-prover-${Math.random().toString(36).slice(2, 8)}.style.dev`;
  const idle = opts?.idleTimeoutSeconds ?? 65;
  const res = await freestyleFetch(apiKey, "/vms", {
    method: "POST",
    body: JSON.stringify({
      slug,
      snapshotId: READY_SNAPSHOT_SLUG,
      firewall: { rules: [{ action: "allow", source: {}, destination: { public: true } }] },
      idleTimeoutSeconds: idle,
      metadata: { project: "zor", purpose: "prover-ondemand" },
      tls: { rules: [{ action: "allow", domain, source: { public: true }, destination: { port: PROVER_PORT } }] },
    }),
  });
  if (!res.ok) throw new Error(`freestyle create failed ${res.status}: ${res.text.slice(0, 500)}`);
  const vm = res.json as Record<string, unknown>;
  return { vmId: vm["id"] as string, domain, url: `https://${domain}` };
}
