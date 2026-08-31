# Zor Proxy Worker!
Privacy-preserving web proxy for the Zor anonymous browsing network.!!!!mandale !!!!!!no se que onda esta piola
## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   User Browser  │────▶│  Cloudflare      │────▶│  Target Site    │
│   (React App)   │     │  Worker          │     │                 │
│                 │     │                  │     │  Sees:          │
│  1. Pay STRK    │     │  1. Validate     │     │  - CF edge IP   │
│  2. Get token   │     │     session      │     │  - Clean headers│
│  3. Browse      │     │  2. Strip cf-*   │     │  - No user IP   │
│                 │     │  3. Stealth      │     │                 │
│                 │     │     fetch        │     │                 │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

## Privacy Guarantees

- **IP Hidden**: Target sites see Cloudflare edge IP, not user's IP
- **Headers Cleaned**: `cf-connecting-ip`, `cf-ipcountry`, `cf-ray`, `cf-worker` are stripped
- **Stealth Fetch**: Uses raw TCP sockets to bypass Cloudflare's HTTP pipeline
- **No Logs**: Worker does not log user IPs or browsing history

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/activate` | Create session after STRK payment |
| `GET` | `/proxy?url=...&token=...` | Proxy request to target URL |
| `GET` | `/status?token=...` | Check session validity |
| `GET` | `/health` | Health check |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SESSIONS` | Yes | KV namespace for session storage |
| `STARKNET_RPC_URL` | Yes | Starknet RPC endpoint for tx verification |
| `POOL_CONTRACT` | Yes | STRK20 pool contract address |
| `ALLOWED_ORIGIN` | No | CORS origin (default: `*`) |

## Development

```bash
# Install dependencies
npm install

# Start local dev server
npm run dev

# Deploy to Cloudflare
npm run deploy
```

## Session Flow

1. User connects Starknet wallet
2. User pays STRK to proxy wallet
3. Frontend sends `POST /activate` with `{walletAddress, txHash, minutes}`
4. Worker verifies tx onchain via Starknet RPC
5. Worker creates session in KV with TTL
6. Worker returns `{token, expiresAt}`
7. Frontend stores token in localStorage
8. Frontend uses `GET /proxy?url=...&token=...` to browse
9. Worker validates token, strips headers, proxies via stealth-fetch
10. Target site receives clean request from Cloudflare IP

## SSRF Protection

The Worker blocks requests to:
- `localhost`, `127.0.0.1`, `0.0.0.0`
- Private IP ranges (`192.168.*`, `10.*`, `172.*`)
- Internal domains (`*.internal`)

## Deployment

### 1. Create KV namespace

```bash
wrangler kv namespace create SESSIONS
```

### 2. Update wrangler.toml

Replace the KV namespace ID with your actual ID.

### 3. Set secrets

```bash
wrangler secret put STARKNET_RPC_URL
```

### 4. Deploy

```bash
npm run deploy
```

## Security Considerations

- Session tokens are 32-byte random hex strings
- Sessions expire after purchased time
- Transaction hashes are marked as used to prevent replay
- All `cf-*` headers are stripped before forwarding
- Only safe headers (accept, content-type, user-agent) are forwarded
- Internal/private IPs are blocked to prevent SSRF
