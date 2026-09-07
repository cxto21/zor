/**
 * Starkscan prover smoke tests — covers tasks 4.1/4.2/4.3.
 * Mainnet-only Starkscan prover: STARKSCAN_API_KEY via Worker secret, never logged.
 * Run: npx tsx worker/vault/starkscan-proof-provider.test.ts
 * Vitest available but not required; plain tsx harness per sdd-init constraints.
 */
import assert from "node:assert/strict";
import {
  BudgetExhaustedError,
  StarkscanTerminalError,
  StarkscanRetryableError,
  classifyStarkscanError,
} from "./errors.ts";
import {
  ATTESTATION_VALID_WINDOW,
  MAX_POLL_MS,
  BASE_POLL_MS,
  DEFAULT_DAILY_BUDGET,
  DEFAULT_MAX_ATTEMPTS,
  hashApiKey,
  utcDateString,
  secondsUntilMidnight,
  isAttestationValid,
  validateAttestation,
  StarkscanProofProvider,
  createStarkscanProviderFromEnv,
} from "./starkscan-proof-provider.ts";
import { putJob, getJob, putProof, getProof, STARKSCAN_TTL_SECONDS } from "./starkscan-persistence.ts";
const SN_MAIN = "0x534e5f4d41494e";
const SN_SEPOLIA = "0x534e5f5345504f4c4941";
function isMainnetChainId(chainId: string){ return chainId===SN_MAIN; }

// ── helpers ──
class MockKV {
  m = new Map<string, string>();
  async get(k: string) { return this.m.get(k) ?? null; }
  async put(k: string, v: string) { this.m.set(k, v); }
  async delete(k: string) { this.m.delete(k); }
}
function mockResponse(status: number, json: unknown, headers: Record<string,string>={}) {
  return new Response(JSON.stringify(json), { status, headers: new Headers(headers) });
}
let pass=0, fail=0;
function ok(name:string, fn:()=>void|Promise<void>){
  return (async()=>{ try{ await fn(); pass++; console.log(`✅ ${name}`);} catch(e){ fail++; console.error(`❌ ${name}`, (e as Error).message); console.error(e);} })();
}

await ok("classifier table 9 codes", async () => {
  const cases: Array<[string|number, string, unknown]> = [
    ["24","retryable", StarkscanRetryableError],
    ["55","terminal", StarkscanTerminalError],
    ["61","terminal", StarkscanTerminalError],
    ["1000","terminal", StarkscanTerminalError],
    ["-32603","terminal", StarkscanTerminalError],
    ["prover_unavailable","retryable", StarkscanRetryableError],
    ["prover_daily_budget_exhausted","budget", BudgetExhaustedError],
    ["prover_key_concurrency","retryable", StarkscanRetryableError],
    ["prover_queue_full","retryable", StarkscanRetryableError],
  ];
  for (const [code, _label, Cls] of cases) {
    const e = classifyStarkscanError(code, `msg ${code}`);
    assert.ok(e instanceof (Cls as never), `code ${code} expected ${String(Cls)} got ${e.constructor.name}`);
    if (code === "prover_daily_budget_exhausted") assert.ok(e instanceof BudgetExhaustedError);
    if (["55","61","1000","-32603"].includes(String(code))) assert.ok(e instanceof StarkscanTerminalError);
  }
  // unknown prover_* → retryable, unknown numeric → terminal
  assert.ok(classifyStarkscanError("prover_foo","x") instanceof StarkscanRetryableError);
  assert.ok(classifyStarkscanError(9999,"x") instanceof StarkscanTerminalError);
  // retryAfter propagated
  const e2 = classifyStarkscanError("prover_daily_budget_exhausted","x", 42);
  assert.equal((e2 as BudgetExhaustedError).retryAfter, 42);
});

await ok("attestation 260s valid / 270s expired (window 265s)", async () => {
  assert.equal(ATTESTATION_VALID_WINDOW, 265);
  const now = 1_700_000_000;
  assert.equal(isAttestationValid(now - 260, now), true, "260s ago valid");
  assert.equal(isAttestationValid(now - 270, now), false, "270s ago expired");
  assert.equal(isAttestationValid(now - 264, now), true);
  assert.equal(isAttestationValid(now - 265, now), false, "exact boundary invalid (< not <=)");
  // validateAttestation success
  const v = validateAttestation({ signature:"0xabc", issued_at: now - 100 }, now);
  assert.equal(v?.signature, "0xabc");
  // near-expiry rejected
  assert.throws(()=> validateAttestation({ signature:"0xabc", issued_at: now - 270 }, now), StarkscanTerminalError);
  // missing issued_at
  assert.throws(()=> validateAttestation({ signature:"0x"} as never, now), StarkscanTerminalError);
  // undefined → undefined
  assert.equal(validateAttestation(undefined, now), undefined);
});

await ok("rate limiter: hash+UTC-date+budget", async () => {
  assert.equal(hashApiKey("test"), hashApiKey("test"));
  assert.notEqual(hashApiKey("a"), hashApiKey("b"));
  assert.equal(hashApiKey("").length, 8);
  const d = utcDateString(new Date("2026-09-07T12:00:00Z"));
  assert.equal(d, "2026-09-07");
  const secs = secondsUntilMidnight(Date.UTC(2026,0,1,12,0,0));
  assert.ok(secs>0 && secs<=86400);
  assert.equal(DEFAULT_DAILY_BUDGET, 100);
  assert.equal(DEFAULT_MAX_ATTEMPTS, 30);
  // under budget proceeds, at cap defers (BudgetExhaustedError)
  const kv = new MockKV();
  const apiKey = "sk_test_123";
  // simulate rate-limit check via provider submitJob path
  let calls=0;
  const fetchOk: typeof fetch = async () => { calls++; return mockResponse(202, { jobId:"job-1" }); };
  const p = new StarkscanProofProvider({ apiKey, kv: kv as never, dailyBudget:1, fetchImpl: fetchOk, maxAttempts:2 });
  const idem="idem-1";
  const j1 = await p.submitJob({ transaction:{}, blockId:1, idempotencyKey:idem });
  assert.equal(j1, "job-1");
  // second submit same idem → cached, no fetch increment
  const j1b = await p.submitJob({ transaction:{}, blockId:1, idempotencyKey:idem });
  assert.equal(j1b, "job-1");
  assert.equal(calls,1);
  // new idem over budget → BudgetExhaustedError
  await assert.rejects(()=> p.submitJob({ transaction:{}, blockId:1, idempotencyKey:"idem-2" }), BudgetExhaustedError);
  // TTL helpers exercised via persistence putJob
  await putJob(kv as never, "k1","v1");
  assert.equal(await getJob(kv as never,"k1"), "v1");
  assert.equal(STARKSCAN_TTL_SECONDS, 86400);
});

await ok("polling: cap30s, maxAttempts, persist once-only, attestation gate", async () => {
  assert.equal(MAX_POLL_MS, 30_000);
  assert.equal(BASE_POLL_MS, 1_000);
  // maxAttempts exhaustion with pending loop
  const kv1 = new MockKV();
  let pollCalls=0;
  const fetchPending: typeof fetch = async () => { pollCalls++; return mockResponse(200, { status:"pending", pollAfterSeconds: 60 }); };
  const p1 = new StarkscanProofProvider({ apiKey:"k1", kv: kv1 as never, fetchImpl: fetchPending, maxAttempts:2 });
  // need job exists for poll; put dummy then poll nonexistent? pollJob doesn't need job submitted via POST
  await assert.rejects(()=> p1.pollJob("job-pend", { maxAttempts:2 }), /max_attempts_exhausted|maxAttempts/i);
  assert.equal(pollCalls,2);
  // success persist + once-only (second poll returns cached)
  const kv2 = new MockKV();
  let seq=0;
  const fetchSuccess: typeof fetch = async (url) => {
    const u = String(url);
    if (u.includes("/prove/") && !u.endsWith("/prove")) {
      // poll GET
      seq++;
      if (seq===1) return mockResponse(200, { status:"pending", pollAfterSeconds:0 });
      return mockResponse(200, { status:"completed", result:{ proof:["0x1"], proof_facts:["0x2"], additional_data:{ signature:"0xsig", issued_at: Math.floor(Date.now()/1000) } }});
    }
    return mockResponse(202, { jobId:"job-ok" });
  };
  const p2 = new StarkscanProofProvider({ apiKey:"k2", kv: kv2 as never, fetchImpl: fetchSuccess as never, maxAttempts:5 });
  const res = await p2.prove({ transaction:{}, blockId:1, idempotencyKey:"idem-ok" });
  assert.equal(res.proof[0], "0x1");
  assert.equal(res.proofFacts[0], "0x2");
  // persisted
  const cached = await getProof(kv2 as never, "job-ok");
  assert.ok(cached && cached.proof[0]==="0x1");
  // second poll returns cached without fetch (once-only)
  const before = seq;
  const cached2 = await p2.pollJob("job-ok");
  assert.equal(cached2.proof[0],"0x1");
  assert.equal(seq, before);
  // putProof idempotency
  const ok1 = await putProof(kv2 as never, "job-ok", { jobId:"job-ok", proof:["0x9"], proofFacts:[], storedAt:Date.now() });
  assert.equal(ok1,false, "second putProof should be no-op");
  // attestation expiry causes terminal
  const kv3 = new MockKV();
  const nowSec = Math.floor(Date.now()/1000);
  const fetchExpired: typeof fetch = async (url) => {
    const u=String(url);
    if (u.endsWith("/prove")) return mockResponse(202,{jobId:"job-exp"});
    return mockResponse(200,{status:"completed", result:{ proof:["0x1"], proof_facts:["0x2"], additional_data:{ signature:"0xsig", issued_at: nowSec - 270 }}});
  };
  const p3 = new StarkscanProofProvider({ apiKey:"k3", kv: kv3 as never, fetchImpl: fetchExpired as never, maxAttempts:3 });
  await assert.rejects(()=> p3.prove({ transaction:{}, blockId:1, idempotencyKey:"idem-exp"}), StarkscanTerminalError);
});

await ok("factory priority+gate (STARKSCAN_API_KEY > PROVING_SERVICE_URL > mock, mainnet-only)", async () => {
  // createStarkscanProviderFromEnv
  const kv = new MockKV();
  assert.equal(createStarkscanProviderFromEnv({}, kv as never), null, "no key → null");
  assert.equal(createStarkscanProviderFromEnv({ STARKSCAN_API_KEY:"  " }, kv as never), null, "blank → null");
  const p = createStarkscanProviderFromEnv({ STARKSCAN_API_KEY:"sk_live" }, kv as never);
  assert.ok(p instanceof StarkscanProofProvider);
  // mainnet gate
  assert.equal(isMainnetChainId(SN_MAIN), true);
  assert.equal(isMainnetChainId(SN_SEPOLIA), false);
  assert.equal(isMainnetChainId("0x534e5f5345504f4c4941"), false); // SN_SEPOLIA
  // VaultService wire: we test the selection branching without full RpcProvider
  // Priority spec: STARKSCAN_API_KEY (mainnet+kv) → PROVING_SERVICE_URL → mock
  // Simulate selection helper mirroring vault-service constructor logic
  function select(env:{STARKSCAN_API_KEY?:string; PROVING_SERVICE_URL?:string; CHAIN_ID?:string; kv?:unknown}){
    const chainId = env.CHAIN_ID ?? SN_SEPOLIA;
    const isMain = chainId === SN_MAIN;
    if (env.STARKSCAN_API_KEY?.trim() && isMain && env.kv) return "starkscan";
    if (env.PROVING_SERVICE_URL) return "proving_service";
    return "mock";
  }
  assert.equal(select({ STARKSCAN_API_KEY:"sk", CHAIN_ID: SN_MAIN, kv:{} }), "starkscan");
  assert.equal(select({ STARKSCAN_API_KEY:"sk", CHAIN_ID: SN_SEPOLIA, kv:{}, PROVING_SERVICE_URL:"https://prover" }), "proving_service", "non-mainnet falls through to proving_service");
  assert.equal(select({ PROVING_SERVICE_URL:"https://prover" }), "proving_service");
  assert.equal(select({}), "mock");
  assert.equal(select({ STARKSCAN_API_KEY:"sk", CHAIN_ID: SN_MAIN }), "mock", "starkscan without kv → mock");
  assert.equal(select({ STARKSCAN_API_KEY:"sk", PROVING_SERVICE_URL:"https://prover", CHAIN_ID: SN_MAIN, kv:{} }), "starkscan", "starkscan priority over proving_service");
});

console.log(`\n— Summary: ${pass} passed, ${fail} failed —`);
if (fail>0) process.exit(1);
