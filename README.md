# Zor Privacy Network 2026.
kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk
Observe the ZKrrr. Developed at the first STRK20 Hackathon. 2026. No sinful economic pretensions.

Anonymous web proxy on Starknet with STRK20 micropayments.

## PoC Architecture

- **Frontend**: React + Vite → Cloudflare Pages
- **Worker**: Cloudflare Worker (proxy + billing + session management)
- **Payments**: STRK20 (ERC20 STRK on Sepolia)

## Master Account (Sepolia)

Used by the worker to deploy per-user deposit addresses.

```
Address:  0x179c3a952b2247a19c9fc5e23ebb6f8478a2efb8f5449557b04b2a4d74888a9
Public:   0x7d7425c0bf1d64aa4ed5a13fa2eab80e50826d1470a31e2a6b5b9cf2cbbee1
Class:    0x061dac032f228abef9c6626f995015233097ae253a7f72d68552db02f2971b8f
```

> ⚠️ Secrets are stored in Cloudflare Workers (MASTER_PRIVATE_KEY, etc). Never commit private keys.

## Flow

1. Connect Starknet wallet (Sepolia)
2. Worker generates unique deposit address (deployed via master account)
3. User sends STRK to deposit address
4. Worker verifies balance and activates session
5. Browse anonymously — balance deducted in real time

## Deployed

- Frontend: https://zor-frontend.pages.dev
- Worker: https://zor-proxy-worker-production.cxto21h.workers.dev
- KV Namespace: a7462b9e44c241fe830333d45cb1954c

## Vision

- Both payments and browsing over PQC. Target: Neutralize "Harvest Now, Decrypt Later".
- Compatible with STRK20 privacy pools (@starkware-libs/starknet-privacy-sdk)