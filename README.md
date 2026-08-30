# Zor Privacy Network

Anonymous web proxy on Starknet with STRK20 micropayments.

## Architecture

- **Frontend**: React + Vite → Cloudflare Pages
- **Worker**: Cloudflare Worker (proxy + billing + session management)
- **Payments**: STRK20 (ERC20 STRK on Sepolia)

## Master Account (Sepolia)

Used by the worker to deploy per-user deposit addresses.

```
Address:  0x6a3f39d449c5f31b9e0efa76d8862b00bd3ff49ca34ef7cdd4a50cd40e7d2f0
Public:   0x7d7425c0bf1d64aa4ed5a13fa2eab80e50826d1470a31e2a6b5b9cf2cbbee1
Class:    0x036086a210c59e0256efec074f90388c8c756cde41b147b6eb6e8249f7e5b72e
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