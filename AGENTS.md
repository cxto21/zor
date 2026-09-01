# AGENTS.md — Zor Privacy Network

## Equipo Humano-Agente

- **Product Owner (Humano):** El dueño del producto. Define qué se construye, prioriza, y decide el rumbo.
- **Full Stack Developer (Agente):** Implementa, audita, y propone mejoras técnicas. Ejecuta lo que el PO aprueba.

**Regla:** El agente NO toma decisiones de producto solo. Propone, el PO aprueba.

---

## Estado del Proyecto (2026-09-01)

### Lo que funciona
- ✅ Worker proxy con stealth-fetch (raw TCP sockets)
- ✅ Server-side URL rewriting (href, src, action, srcset) + client-side injector
- ✅ Click interceptor for iframe navigation (keeps links inside proxy)
- ✅ Balance-based billing (STRK20 micropayments)
- ✅ **STRK20 Privacy Pool integration** (via Starknet Wallet API)
  - Wallet (Ready) handles: viewing keys, note discovery, ZK proofs, submission
  - Deposit via `strk20InvokeTransaction` — wallet generates proof
  - Worker verifies deposit events on-chain (`/verify-deposit` endpoint)
  - Privacy: deposit event is public, but notes are encrypted after deposit
- ✅ Deposit flow: get deposit address → send STRK → activate session
- ✅ Session management: token, balance check, countdown, localStorage restore
- ✅ Retro Windows 95 UI (Browser, URL bar, nav buttons)
- ✅ Security headers stripped (X-Frame-Options, CSP)
- ✅ Response header sanitization (control chars filtered)
- ✅ NAT64 fallback (stealth-fetch → regular fetch)

### Deployments
- **Worker (production):** https://zor-proxy-worker-production.cxto21h.workers.dev
- **Worker (default):** https://zor-proxy-worker.cxto21h.workers.dev
- **Frontend:** https://zor-frontend.pages.dev
- **Master Account (Sepolia):** 0x12f8b399a2eff402e22ea47be559d7e369cb5a18bcb426834a079947018a2d
- **Proxy Wallet (Sepolia):** 0x6bac485e95d541c9d3e5bed098b47d137143a6a9e51d62b4e3ba31249d9700bd

### Gaps Críticos (sin resolver)

1. **✅ RESUELTO: Navegación inside iframe** — Click interceptor inyectado en el injector. Intercepta clicks en `<a href>` y `<form action>`, reescribe URLs a proxy, y navega el iframe a través del proxy. Server-side rewriting + click interceptor = cobertura completa.

2. **✅ SDK INTEGRATION: STRK20 Privacy Pool vault service (Opción B)** — El bloqueo anterior era `compile_actions` via `starknet_call` (rompe `NO_REPLAY_PROTECTION`). **RESUELTO** con el SDK oficial: `worker/vault/vault-service.ts` usa `createPrivateTransfers` + `CallMockProofProvider(validateSignature:false)` que produce un `CallAndProof` para `apply_actions` (NO compile_actions). Verificado contra Sepolia Alchemy: `register()` → 32-element calldata; `shield()` → 56-element calldata (register + channel + subchannel + deposit + encrypted note + surplus); ambos con class_hash `0x7e2bbd...` correcto y 9 proof_facts VIRTUAL_SNOS. **Settlement pendiente**: `apply_actions` en el pool real de Sepolia necesita pruebas VIRTUAL_SNOS genuinas (el pool valida proof_facts contra el blockifier). Para settlement se necesita: (a) prover real (starknet-privacy prover / AVNU), o (b) devnet local con pool compilado (requiere más RAM/CPU que el sandbox actual).
   - Files: `worker/vault/vault-service.ts`, `worker/vault/run-sepolia.ts`
   - SDK: `@starkware-libs/starknet-privacy-sdk@0.14.3-rc.6` (no npmjs, GitHub Packages only)
   - `CallMockProofProvider` with `validateSignature:false` uses plain `compile_actions` VIEW → works on Alchemy without `simulateTransaction`

3. **✅ RESUELTO: Per-user account deployment** — Worker deriva key única por usuario, calcula dirección OZ Account. Frontend usa starknet.js para deploy. Master account fondea la cuenta nueva via `/fund-account` endpoint.

4. **No hay top-up flow** — El usuario puede comprar una vez pero no puede agregar más tiempo sin terminar la sesión y empezar una nueva.

5. **No hay rate limiting** — El proxy no tiene abuso prevention. Cualquiera con un token puede hacer requests ilimitados.

6. **No hay logging** — No se trackea usage, errores, o patterns de abuso.

7. **CSS/JS no se reescriben en links** — `<link href="style.css">` y `<script src="app.js">` se reescriben, pero si el JS construye URLs dinámicas (`fetch('/api/data')`), esas se pierden sin el injector client-side.

### Gaps Menores (mejorable)

7. **No hay top-up desde el browser** — Una vez que el balance se agota, el usuario tiene que volver al home y empezar el flow de pago de nuevo.

8. **No hay feedback visual de loading en el iframe** — El loading bar es estimado, no real.

9. **No hay 404/error handling en el proxy** — Si el target site responde con error, el proxy lo pasa sin modifier.

10. **No hay cache** — Cada request va al target sin caching, lento para páginas estáticas.

---

## Decisiones Tomadas

| Fecha | Decisión | Razón |
|-------|----------|-------|
| 2026-08-30 | Server-side URL rewriting + client-side injector | Combinación: server-side para HTML estático, client-side para URLs dinámicas |
| 2026-08-30 | Stealth-fetch con fallback a regular fetch | NAT64 en algunos hosts rompe stealth-fetch |
| 2026-08-30 | Balance-based billing (no session timer) | Más justo: el usuario paga por uso real, no por tiempo fijo |
| 2026-08-30 | Master account para deploy de per-user wallets | Un solo deploy, múltiples cuentas derivadas |
| 2026-08-30 | STRK20 Privacy Pool via Starknet Wallet API | Wallet maneja ZK proofs — sin proving service ni discovery service propio |
| 2026-09-01 | Master-account V3 tx: resource bounds BigInt + padding consistente | Fix de "Invalid Tx version" / "Account validation failed" en /shield y /fund-account |
| 2026-09-01 | Pool shield requiere prover oficial (Virtual SNOS) o devnet con mock prover | `compile_actions` NO es el entrypoint de liquidación; `apply_actions` + proof_facts lo es |
| 2026-09-01 | Vault SDK integration (Option B) — official SDK path against live Sepolia | `CallMockProofProvider` with `validateSignature:false` works on Alchemy; produces correct `CallAndProof` for `apply_actions` |

---

## Próximos Pasos (para que el PO priorice)

1. **STRK20 Pool shield server-side (ACTIVO)** — Decidir el approach del prover:
   - (a) Integrar el SDK prover oficial de starknet-privacy (Virtual SNOS + proofs reales, `apply_actions`), o
   - (b) Levantar un devnet local con mock prover para el flujo completo shield/unshield, o
   - (c) Simplificar: desplegar un pool de prueba view-only donde `compile_actions` sea view pura (valida el flujo deposito/retiro end-to-end sin el proving completo).
2. **Per-user account deployment** — Verificar flujo completo.
3. **Top-up flow** — Permitir agregar más tiempo sin reiniciar sesión.
4. **Rate limiting** — Básico: max X requests/min por token.
5. **Testing end-to-end** — Probar el flow completo en el frontend.
