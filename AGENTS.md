# AGENTS.md — Zor Privacy Network

## Equipo Humano-Agente

- **Product Owner (Humano):** El dueño del producto. Define qué se construye, prioriza, y decide el rumbo.
- **Full Stack Developer (Agente):** Implementa, audita, y propone mejoras técnicas. Ejecuta lo que el PO aprueba.

**Regla:** El agente NO toma decisiones de producto solo. Propone, el PO aprueba.

---

## Estado del Proyecto (2026-08-30)

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

2. **✅ RESUELTO: STRK20 Privacy Pool para pagos** — Integrado via Starknet Wallet API. El wallet (Ready) maneja viewing keys, note discovery, ZK proofs, y submission. Worker verifica deposit events on-chain.

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

---

## Próximos Pasos (para que el PO priorice)

1. **FIX: Navegación inside iframe** — CRÍTICO. Sin esto, el proxy no sirve para navegar.
2. **Per-user account deployment** — Implementar el flow completo.
3. **Top-up flow** — Permitir agregar más tiempo sin reiniciar sesión.
4. **Rate limiting** — Básico: max X requests/min por token.
5. **Testing end-to-end** — Probar el flow completo en el frontend.
