# STRK20 Utilities & Reference

> Curated resources for building privacy features on Starknet with STRK20.
> Last updated: 2026-08-30

## What is STRK20?

A **note-based privacy pool** (not a mixer) for any ERC-20 on Starknet. Shielding deposits an ERC-20 into the pool as an encrypted note (UTXO). Private transfers spend existing notes and create new ones. Every private transaction carries a STARK proof verified in-protocol.

**Key properties:**
- Variable amounts (not fixed-denomination like mixers)
- Sender, recipient, amounts, token type all hidden inside the pool
- Deposits and withdrawals (the public ERC-20 legs) stay visible
- Compliance-first: FPI screens every deposit and signs it; pool verifies onchain
- Paymaster can decouple submitter address from the transaction

---

## Contracts (Deployed)

| Network | Contract | Address |
|---------|----------|---------|
| **Mainnet** | Privacy Pool v2.0 | [`0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a`](https://voyager.online/contract/0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a) |
| **Sepolia** | Privacy Pool v2.0 | [`0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91`](https://sepolia.voyager.online/contract/0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91) |
| **Mainnet** | Ekubo Anonymizer | `0x2a4ac595283d4d64b9952f5ef5c0da1775bfdb7c9d92237524a21dd8d19ebd7` |
| **Mainnet** | Vesu Anonymizer | `0x3751128dc3ebd36215f982766f14aaca8f78793e4b0f42a73e49372a8e24aae` |

**Pool Class Hash:** `0x52107fadffab71bdcbb6b2ccb68ba3e1b5558d94036538053e159d3076ad633`

---

## Integration Routes

### 1. Private Dapp (via Wallet API) — RECOMMENDED for most apps

Your dapp asks the user's privacy-enabled wallet to perform private actions. The wallet handles keys, notes, proving, and submission.

```bash
npm install starknet@^10.4.0
```

**Critical:** STRK20 support landed in starknet.js **10.4.0**. A bare `npm install starknet` resolves to `latest` (10.0.x) which has **none** of the STRK20 API.

**What you can do:**
- Shield (deposit public ERC-20 into pool)
- Private transfer (move value between registered users)
- Unshield (withdraw to public address)
- Swap (via anonymizer contract)
- Private DeFi (lending, staking via anonymizer)

**When to use:** Building on top of existing privacy wallets (Ready, Xverse).

### 2. Privacy SDK (Low-level) — For wallet builders & advanced integrations

Direct control over registration, channels, note discovery, and proving.

```bash
npm install @starkware-libs/starknet-privacy-sdk
```

**Requires Node.js >= 24** (modern WebCrypto).

**When to use:** Building a privacy wallet, advanced backend, or when you need full control.

### 3. Anonymizer Contracts — For private DeFi

Cairo helper contracts that the pool calls atomically. Pattern:

```
withdraw from pool → helper does something → deposit result to open note
```

**When to use:** Private swaps (Ekubo/AVNU), lending (Vesu), escrow, custom DeFi.

---

## SDK Quick Start

```typescript
import { Account, RpcProvider, constants } from "starknet"
import { createPrivateTransfers } from "@starkware-libs/starknet-privacy-sdk"

const provider = new RpcProvider({ nodeUrl: process.env.RPC_URL! })

const account = new Account({
  provider,
  address: process.env.ACCOUNT_ADDRESS!,
  signer: process.env.ACCOUNT_PRIVATE_KEY!,
  cairoVersion: "1",  // required for v3 transactions
})

const transfers = createPrivateTransfers({
  account,
  viewingKeyProvider: {
    getViewingKey: async () => BigInt(process.env.VIEWING_KEY!),
  },
  provingProvider: {
    url: process.env.PROVING_SERVICE_URL!,
    chainId: constants.StarknetChainId.SN_SEPOLIA,
  },
  discoveryProvider: { url: process.env.INDEXER_URL! },
  poolContractAddress: process.env.POOL_ADDRESS!,
})
```

**Gotcha:** `viewingKey` MUST be a `bigint`. A hex string silently misbehaves (wrong channel-key derivation).

### First Transaction Pattern

```typescript
const provingBlockId = (await provider.getBlockNumber()) - 10

const { callAndProof } = await transfers.build().register().execute({ provingBlockId })

const proofDetails = callAndProof.proof.proofFacts?.length
  ? { proofFacts: callAndProof.proof.proofFacts, proof: callAndProof.proof.data }
  : {}

const tx = await account.execute(callAndProof.call, { tip: 0n, ...proofDetails })
await provider.waitForTransaction(tx.transaction_hash)
```

**Key details:**
- `provingBlockId = head - 10`: notes mature 10 blocks after creation; proving at chain head risks reorg
- Omit `proofFacts`/`proof` keys entirely when arrays are empty (passing empty arrays serializes invalid v3 tx)
- `tip: 0n` is mandatory for v3 transactions in starknet.js
- This submission pattern is identical for every operation

---

## Wallet API Quick Start

```bash
npm install starknet@^10.4.0
```

```typescript
import { WalletAccountV6, strk20InvokeTransaction, STRK20_ACTION } from "starknet"
```

**Detect capabilities before offering actions** — wallet support varies.

**What stays public:**
- Deposit and withdrawal amounts (the ERC-20 legs)
- Timing of interactions
- That someone is interacting with the pool

---

## Anonymizer Contract Skeleton

```cairo
use privacy::objects::OpenNoteDeposit;

#[starknet::interface]
pub trait IEchoHelper<T> {
    fn privacy_invoke(ref self: T, deposits: Span<OpenNoteDeposit>) -> Span<OpenNoteDeposit>;
}

#[starknet::contract]
pub mod EchoHelper {
    use privacy::objects::OpenNoteDeposit;
    use super::IEchoHelper;

    #[storage]
    struct Storage {}

    #[constructor]
    fn constructor(ref self: ContractState) {}

    #[abi(embed_v0)]
    pub impl EchoHelperImpl of IEchoHelper<ContractState> {
        fn privacy_invoke(
            ref self: ContractState, deposits: Span<OpenNoteDeposit>,
        ) -> Span<OpenNoteDeposit> {
            deposits  // echo — replace with real logic
        }
    }
}
```

**Rules:**
- Return exactly `Span<OpenNoteDeposit>` — anything else makes the pool reject
- **Approve, don't transfer** — helper approves pool to pull output; pool executes the pull
- Empty span = credit nothing (valid for stateful helpers parking funds)
- Measure output by balance delta (record balance before/after external call)
- One `invoke` per transaction maximum

---

## Architecture

```
Wallet → SDK → Discovery Service (finds notes)
             → Proving Service (generates STARK proof)
             → Privacy Pool Contract (onchain)
             → Anonymizer Contracts (external DeFi calls)
```

**Components:**
| Component | Role |
|-----------|------|
| SDK | Orchestrates private transfers (register, transfer, discover) |
| Discovery Service | Indexes encrypted on-chain storage for wallet sync |
| Proving Service | Executes actions in virtual blocks, returns STARK proofs |
| Privacy Pool Contract | Source of truth for actions, storage, cryptography |
| Anonymizer Contracts | External contracts callable from private transactions |

---

## Privacy Bridge (Cross-chain)

Moves USDC between EVM chains and the privacy pool via Circle's CCTP.

**Flow:**
1. EVM wallet → pool (deposit as private note)
2. Pool → EVM chain (withdraw + bridge via OutboundAnonymizer)
3. EVM chain → pool (bridge + bind to note via InboundAnonymizer)
4. Pool → EVM wallet (cash out)

**Key:** All key material derives from a single wallet signature. Only the read-only viewing key is ever persisted.

**Repo:** https://github.com/starkware-libs/privacy-bridge

---

## Gotchas & Important Notes

1. **starknet.js version:** Must be >= 10.4.0. Check `package.json` — bare `install starknet` gets 10.0.x
2. **Node.js for SDK:** Requires >= 24 (WebCrypto)
3. **Viewing key type:** MUST be `bigint`, not hex string
4. **provingBlockId:** Always `head - 10` to avoid reorg issues
5. **Proof facts:** Only include when non-empty; empty arrays break v3 transactions
6. **Registration required:** Both sender AND recipient must be registered before private transfers
7. **Paymaster:** Use it to decouple submitter address from transaction (prevents metadata leakage)
8. **Deposit screening:** Every deposit is screened and signed by FPI; you can't bypass it
9. **Open note amounts are public** — only the owner is hidden
10. **Channel discovery scales with YOUR activity**, not total pool volume

---

## Resources

### Official
| Resource | URL |
|----------|-----|
| STRK20 Main Site | https://strk20.starknet.io/build |
| STRK20 by Example | https://strk20-by-example.org/ |
| Privacy SDK (GitHub) | https://github.com/starkware-libs/starknet-privacy |
| Privacy Bridge | https://github.com/starkware-libs/privacy-bridge |
| Whitepaper | https://eprint.iacr.org/2026/474 |

### Community
| Resource | URL |
|----------|-----|
| Awesome STRK20 | https://github.com/Akashneelesh/awesome-strk20 |
| STRK20 Starter Kit | https://github.com/Akashneelesh/strk20-starter-kit |
| Agent Skill | https://github.com/starkience/strk20-agent-skills |
| Cairo CoreStars (Telegram) | https://t.me/sncorestars |

### SDK Installation (if npm 404)
```bash
# Option 1: GitHub Packages
gh auth refresh -h github.com -s read:packages
npm config set @starkware-libs:registry https://npm.pkg.github.com
npm config set '//npm.pkg.github.com/:_authToken' "$(gh auth token)"
npm install @starkware-libs/starknet-privacy-sdk

# Option 2: From git
npm install "starkware-libs/starknet-privacy#<commit-sha>"
```

### Wallets with Privacy Support
| Wallet | Status |
|--------|--------|
| [Ready](https://www.ready.co/) | In-wallet privacy live on mainnet |
| [Xverse](https://www.xverse.app/) | Live on mainnet; Wallet API support in progress |

### For AI Agents
- Full site as one Markdown file: https://strk20-by-example.org/llms-full.txt
- Agent-readable index: https://strk20-by-example.org/llms.txt

---

## Useful PoCs

| Project | Description | Repo |
|---------|-------------|------|
| Private Airdrop | Distribute tokens privately | [awesome-strk20/pocs](https://github.com/Akashneelesh/awesome-strk20/tree/main/pocs) |
| Private Escrow | Deferred delivery to unregistered recipients | [awesome-strk20/pocs](https://github.com/Akashneelesh/awesome-strk20/tree/main/pocs) |
| Polymarket Privacy | Private swaps via CCTP | https://github.com/starkware-libs/polymarket-privacy |
| Private Payroll | Batch salary payments | https://github.com/starkware-industries/private-payroll |

---

## Request for Startups (Ideas to Build)

From https://strk20.starknet.io/rfp:

- **Private OTC Settlement** — trustless atomic block trades, 5-15bps
- **Private Pump.fun** — bonding-curve launches with hidden buyers
- **Private Prediction Market** — visible odds, invisible bettors
- **Sealed-Bid Auctions** — encrypted notes, no commit-reveal griefing
- **Private Payroll** — per-recipient amounts private, aggregate provable
- **Private Subscriptions** — gas-sponsored creator payments
- **Private Messaging** — encrypted on-chain messaging
- **Anonymous Whistleblower** — submit reports, prove authorship without identity
- **Private Poker** — fully on-chain with private hands
- **Cross-Chain Privacy Hub** — one-click privacy from any chain
- **Privacy Wallet** — Umbra-style, publish once, receive privately

---

## Cloudflare Worker Proxy — Privacy Analysis

### Does it hide the user's IP?

**Partially.** When a Worker calls `fetch(targetUrl)`, the request originates from **Cloudflare's edge IPs**, not the user's. The target server sees Cloudflare's IP.

**BUT** — Cloudflare's built-in `fetch()` automatically injects headers that leak user info:

| Header | Leaks | Can be removed? |
|--------|-------|-----------------|
| `cf-connecting-ip` | User's real IP | ❌ Injected by CF pipeline |
| `cf-ipcountry` | User's country | ❌ Injected by CF pipeline |
| `cf-ray` | Request trace ID | ❌ Injected by CF pipeline |
| `cf-worker` | Worker name/zone | ❌ **Cannot be spoofed** |

**The target site receives these headers.** Even though the source IP is Cloudflare's, the `cf-connecting-ip` header contains the user's real IP address.

### Solution 1: Strip headers manually (simple)

```typescript
export default {
  async fetch(request: Request) {
    const url = new URL(request.url);
    const target = url.searchParams.get('url');
    
    // Build clean headers — only forward safe ones
    const cleanHeaders = new Headers();
    const safeHeaders = ['accept', 'accept-language', 'content-type', 'user-agent'];
    for (const [key, value] of request.headers) {
      if (safeHeaders.includes(key.toLowerCase())) {
        cleanHeaders.set(key, value);
      }
    }
    // DO NOT forward cf-connecting-ip, cf-ipcountry, cf-ray, cf-worker
    
    return fetch(target, {
      method: request.method,
      headers: cleanHeaders,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
    });
  }
}
```

### Solution 2: stealth-fetch (recommended for real privacy)

Uses raw TCP sockets (`cloudflare:sockets`) to bypass the Workers HTTP pipeline entirely. No `cf-*` headers injected.

```bash
npm install stealth-fetch
```

```typescript
import { request } from "stealth-fetch/web"

const response = await request("https://target.com", {
  method: "GET",
  headers: { "User-Agent": "Mozilla/5.0 ..." },
})
```

- ✅ No `cf-connecting-ip`, `cf-ipcountry`, `cf-ray`
- ✅ No `cf-worker` header (the one that CAN'T be stripped normally)
- ✅ Uses WASM TLS (rustls) for HTTPS
- ⚠️ Requires `nodejs_compat` flag for full version

**Repo:** https://github.com/0xwx/stealth-fetch

### Solution 3: shadowfetch (privacy-focused alternative)

Similar approach, AGPL licensed.

**Repo:** https://github.com/tysak/shadowfetch

### ⚠️ Important: `cf-worker` header is unremovable

Even with header stripping, Cloudflare injects `cf-worker: <zone-name>` on every subrequest. Target servers can detect this and block Worker traffic. Only raw socket solutions (stealth-fetch) bypass this.

---

## Access Control Mechanisms

### Option 1: Session Token (after STRK payment)

```
User pays STRK → Worker validates tx → Generates session token → Stores in KV
→ User includes token in proxy requests → Worker validates before proxying
```

```typescript
// Worker: validate session
async function validateSession(token: string, env: Env): Promise<boolean> {
  const session = await env.SESSIONS.get(token);
  if (!session) return false;
  
  const { expiresAt } = JSON.parse(session);
  if (Date.now() > expiresAt) {
    await env.SESSIONS.delete(token);
    return false;
  }
  return true;
}
```

### Option 2: Wallet-based auth (signature verification)

```typescript
// User signs a message with their Starknet wallet
// Worker verifies the signature onchain or locally
const message = `Zor proxy session: ${Date.now()}`;
const signature = await account.signMessage(message);

// Worker verifies
const isValid = await verifySignature(walletAddress, message, signature);
```

**Pros:** No API keys to manage, wallet IS the identity
**Cons:** Requires onchain verification or trusted indexer

### Option 3: Per-user API key (simplest)

```bash
# Generate key
openssl rand -hex 32

# Store in KV
wrangler kv key put --binding=API_KEYS "user:0x123..." '{"key":"abc...", "expiresAt":1735689600000}'
```

### Option 4: Shared provider (user-only knowledge)

The proxy URL itself as a secret:
```
https://zor-proxy-<random>.workers.dev/proxy?url=...
```

**⚠️ This is security through obscurity.** Anyone with the URL can use it. Not recommended as sole access control.

---

## Recommended Architecture for Zor

```
┌─────────────┐    ┌──────────────────┐    ┌─────────────────┐
│  User Wallet │───▶│  Cloudflare      │───▶│  Target Site    │
│  (Starknet)  │    │  Worker          │    │                 │
│              │    │                  │    │  Sees:          │
│  1. Pay STRK │    │  1. Validate     │    │  - CF IP        │
│  2. Get      │    │     session      │    │  - Clean headers│
│     session  │    │  2. Strip cf-*   │    │  - No user IP   │
│  3. Browse   │    │  3. Proxy via    │    │                 │
│              │    │     stealth      │    │                 │
└─────────────┘    └──────────────────┘    └─────────────────┘
```

**Layers:**
1. **Payment gate:** STRK micropayment → session token (KV, TTL = purchased minutes)
2. **IP privacy:** Use `stealth-fetch` or strip all `cf-*` headers
3. **Header cleanup:** Forward only safe headers (accept, content-type, user-agent)
4. **Rate limiting:** Per-session token limits (prevent abuse)
5. **Logging:** Zero user IP logging on the Worker

**What the target site sees:**
- Cloudflare edge IP ✅ (user IP hidden)
- Clean User-Agent ✅
- No `cf-connecting-ip` ✅ (if using stealth-fetch)
- No `cf-worker` ✅ (only with stealth-fetch)

---

## Stealth Libraries Comparison

| Library | License | Node.js Compat | HTTP/2 | WASM TLS | Status |
|---------|---------|----------------|--------|----------|--------|
| [stealth-fetch](https://github.com/0xwx/stealth-fetch) | MIT | Required for `/` | ✅ | ✅ rustls | Active |
| [shadowfetch](https://github.com/tysak/shadowfetch) | AGPL | No | ❌ | ❌ | Active |

**Recommendation:** Use `stealth-fetch/web` (no nodejs_compat needed, HTTP/1.1 only) for the proxy.
