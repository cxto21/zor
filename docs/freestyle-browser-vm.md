# Freestyle Browser VM — Zor Dynamic Wallet Handoff

Generated: 2026-09-02
Freestyle API: `https://api.freestyle.sh/v5` (Bearer auth)

## Summary
Zor needs per-user dynamic wallets but the STRK20 prover requires AVX512 + 8GiB, too heavy for Free tier.  
Alternative: reuse Ready (Argent X) wallet's own proving via browser automation.  
This build creates a lightweight headed Chromium VM (~1.2GB actual, 190MB Chrome + 8GiB VM default) that fits Free tier 4 vCPU / 8 GiB. Prover work is delegated to the extension's `wallet_strk20InvokeTransaction` proof generation; Chrome's CDP is used for automation.

## Snapshots (private)

| Slug | Snapshot ID | Source VM | Created |
|------|-------------|-----------|---------|
| `chromium-base` | `sh-2efb55ff565a4fada979d48baab087ec` | `vm-7c0f7504342f400491ea5ce5de73e541` | 2026-09-02T13:38:07Z |
| `zor-browser-ready` | `sh-12764625269d40af8bd0315fed0271ec` | `vm-cff54cb1ade2420a8d665b0714fddd61` (headed-builder) | 2026-09-02T13:45:14Z |

`zor-browser-ready` is the headed snapshot to branch from on-demand. It auto-deletes in 30 days if unused (`autoDeleteFromPlan=true`).

VM default resources: 4 vCPU, 8192 MiB RAM, 32768 MiB disk (`freestyle/ubuntu` + `freestyle/ubuntu` derived). Fits Free tier default.

## Builder history
- `chromium-builder` (`vm-7c0f7504342f400491ea5ce5de73e541` and earlier `vm-93...`, `vm-84...`) — transient, deleted after snapshot.
- `headed-builder` (`vm-cff54cb1ade2420a8d665b0714fddd61`) — installed `xvfb openbox x11vnc novnc websockify xauth x11-utils dbus-x11 python3 nginx`, then Ready extension, then systemd services. Deleted after snapshot.

Both builders used `firewall: { rules:[{action:"allow", source:{}, destination:{public:true}}] }` and `idleTimeoutSeconds: null`.

**Chrome install note:** `apt-get install chromium` on `freestyle/ubuntu` (Ubuntu 24.04) installs a `snap` transitional package (`chromium-browser -> chromium snap`), not a true `chromium` binary. The guide's Debian `chromium` package is not available. This build instead installs **Google Chrome Stable** via `https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb` and symlinks `/usr/bin/chromium -> /usr/bin/google-chrome` so guide paths still work. Verified `google-chrome --version` = `152.0.7977.75`.

**Headed stack `runSetup` fix:** Freestyle `vm.exec` runs as user `ubuntu`, not root. All `systemd-run`, `writeTextFile` to `/root/`, `apt`, and `systemctl` calls must use `sudo`. The helper was patched to use `sudo` and `fs.writeTextFile` to `/tmp` + `sudo mv`.

**First-run fix:** Headed Chrome without `--no-first-run --noerrdialogs` shows a ToS dialog and does **not** bind `--remote-debugging-port=9222`. Systemd unit was patched to include `--no-first-run --noerrdialogs`; without them, `curl http://127.0.0.1:9222/json/version` returns `Connection refused` and `journalctl` shows no `DevTools listening` line. With the flags, `DevTools listening on ws://127.0.0.1:9222/...` appears.

**Nginx CDP proxy fix:** Original nginx config wrote inside `sudo bash -c 'cat > ... <<NGINX'` without quoting heredoc, expanding `$http_upgrade` to empty. Patched via `vm.fs.writeTextFile` to ensure `proxy_set_header Upgrade $http_upgrade;` is literal. Also ensure `sudo systemctl restart nginx` after config (daemon-reload alone doesn't reload already-running nginx).

## Ready / Argent X Extension

- **Chrome Web Store IDs:** `cchoppbpeamodccpffhussenhhjfhob` (Ready, formerly Argent X) and `dkjgfbdknpobgclmdleeggmdebningid` (Argent X). Verified via `https://chromewebstore.google.com/detail/ready-wallet-previously-a/cchoppbpeamodccpffhussenhhjfhob` (301 to store). Direct CRX fetch via `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=149&x=id%3D...` now returns `404 error-unknownApplication` (Google deprecated that endpoint).
- **Download source used:** `https://github.com/argentlabs/argent-x/releases/download/v5.23.0/argent-extension-chrome.zip` (canonical, since Ready is Argent rebrand). Extracted to `/opt/ready-extension` via `curl -fsSL -o argent-extension-chrome.zip ... && sudo unzip -o ... -d /opt/ready-extension`. Manifest verified: `name: Argent X - Starknet Wallet`, `version: 5.23.0`, `manifest_version: 3`, `background.service_worker: background.js`, `content_scripts: inject.js -> inpage.js`.
- **Files on snapshot:** `/opt/ready-extension/manifest.json` exists (1.5K) and `ls /opt/ready-extension` contains `background.js, inject.js, inpage.js, manifest.json, assets/*` (16M unpacked). Permissions `root:root`.
- **Critical limitation discovered:** Google Chrome Stable **blocks** `--load-extension=/opt/ready-extension`. Verified via `journalctl` with `--enable-logging --v=1`: `WARNING:chrome/browser/extensions/extension_service.cc:423] --load-extension is not allowed in Google Chrome, ignoring.` The `chrome://extensions` page shows no Argent, and `curl http://127.0.0.1:9222/json` lists no `service_worker` for the extension. Using `--disable-extensions-except=/opt/ready-extension` also still ignored.
  - **Why:** `load-extension` is only allowed in Chromium (open-source) builds, not branded Google Chrome. Guide uses `/usr/bin/chromium` (Debian Chromium) which allows it; our Google Chrome substitution breaks it.
  - **Snapshot status:** `zor-browser-ready` contains the unpacked files at `/opt/ready-extension` but Chrome service `chromium-headed.service` still carries `--load-extension=/opt/ready-extension` which is silently ignored. CDP and VNC still work, but `window.starknet` injection was observed `false` on `https://example.com` via `page.evaluate`.
  - **Manual upload alternative (works now):** Open VNC viewer, navigate to `chrome://extensions`, enable Developer mode, click Load unpacked, select `/opt/ready-extension`. Can be automated via CDP mouse/keyboard: `page.goto('chrome://extensions')`, click `#devMode` toggle, click `Load unpacked` (coordinates depend on window size), use file picker automation is harder; easier is to automate via `chrome.management` CDP or to rebuild snapshot with a Chromium build that allows flag.
  - **Recommended fix for next iteration:**
    1. Rebuild `chromium-base` using **Chromium** (not Google Chrome). Options: install `chromium` from `https://storage.googleapis.com/chromium-browser-snapshots/Linux_x64/` tarball, or use `npx @puppeteer/browsers install chrome` which installs `chrome-for-testing` (brand `Chromium` variant that allows load-extension), or use Brave (`brave-browser`) which also allows it. Then `--load-extension` will work and `curl http://127.0.0.1:9222/json` will list `type: service_worker` for `chrome-extension://.../background.js`.
    2. Or patch `chromium-headed.service` to use `chromium` binary path that allows it, snapshot again.
    3. Until then, branch VMs can load extension on-demand via: `vm.exec('sudo unzip -o /tmp/ready.zip -d /opt/ready-extension && sudo systemctl restart chromium-headed')` then VNC manual load unpacked, or via CDP-driven UI.

## Systemd Services (in `zor-browser-ready`)

All enabled (`systemctl enable` so they survive snapshot branch boot):

- `xvfb.service`: `ExecStart=/usr/bin/Xvfb :0 -screen 0 1440x900x24 -nolisten tcp`
- `openbox.service`: waits for `xdpyinfo`, then `/usr/bin/openbox`, env `DISPLAY=:0, HOME=/root`
- `x11vnc.service`: `/usr/bin/x11vnc -display :0 -forever -shared -nopw -localhost -rfbport 5900`
- `novnc.service`: `/usr/bin/websockify --web /usr/share/novnc 6080 localhost:5900`
- `nginx` (site `chromium-cdp`): `listen 9333; proxy_pass http://127.0.0.1:9222; proxy_set_header Host 127.0.0.1:9222; Upgrade $http_upgrade; Connection "upgrade";` — verifies via `curl http://127.0.0.1:9333/json/version` == `http://127.0.0.1:9222/json/version`
- `chromium-headed.service`:
  ```
  Environment=DISPLAY=:0
  Environment=HOME=/root
  ExecStartPre=/bin/bash -lc 'for i in {1..30}; do xdpyinfo >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1'
  ExecStartPre=/bin/bash -lc 'mkdir -p /root/.config/chromium-headed; rm -f /root/.config/chromium-headed/Singleton*'
  ExecStart=/usr/bin/chromium --no-sandbox --disable-dev-shm-usage --no-first-run --noerrdialogs --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --remote-allow-origins=* --user-data-dir=/root/.config/chromium-headed --window-size=1440,900 --window-position=0,0 --load-extension=/opt/ready-extension https://example.com
  ```

Readiness poll (matches guide): `curl http://127.0.0.1:6080/vnc.html && curl http://127.0.0.1:9333/json/version && DISPLAY=:0 xwininfo -root -tree | grep -E 'Chrome|Chromium'` — all succeed now. `xwininfo` shows `1439x899+0+0` window with title `Example Domain - Google Chrome`.

## On-Demand Branch VM Test

Branch VM created from `zor-browser-ready`:

- Slug `zor-browser-test`, id `vm-04ce6635d48541bcaf35077a75c1fb5d`, `idleTimeoutSeconds: 65` (auto-pauses after 65s idle, saving budget), `firewall` allow public.
- TLS rules (HTTP): `zor-browser-vnc-mtk5f9l8-90za.style.dev -> 6080`, `zor-browser-cdp-mtk5f9l8-91q1.style.dev -> 9333` (ids `tls-b3df7c64ef7745af8a77139c44afb6b9`, `tls-e21a1578aa4f49098705553e4f89993a`)
- VNC: `https://zor-browser-vnc-mtk5f9l8-90za.style.dev/vnc.html?autoconnect=true&reconnect=true&resize=scale&path=websockify`
- CDP: `https://zor-browser-cdp-mtk5f9l8-91q1.style.dev/json/version` (also `/json`)
- Internal poll after boot: `curl http://127.0.0.1:9333/json/version` and `curl http://127.0.0.1:6080/vnc.html` both `OK` within 0s (services start on boot, no extra wait).
- Playwright Core via edge WSS:
  ```js
  const v = await fetch(`https://zor-browser-cdp-mtk5f9l8-91q1.style.dev/json/version`).then(r=>r.json());
  const wsUrl = v.webSocketDebuggerUrl.replace("ws://127.0.0.1:9222", `wss://zor-browser-cdp-mtk5f9l8-91q1.style.dev`);
  const browser = await chromium.connectOverCDP(wsUrl);
  const page = browser.contexts()[0].pages()[0] ?? await browser.contexts()[0].newPage();
  await page.goto("https://example.com");
  // title: Example Domain, screenshot 17537 bytes saved to /tmp/freestyle-build/branch_screenshot.png
  ```
  Verified: connectOverCDP succeeds, `page.title()` returns `Example Domain`, screenshot captured.

- Branch VM left running for inspection. Snapshot `lastUsedAt` updated to `2026-09-02T13:45:31Z` after branch.

Resource usage: `ps aux` shows Chrome ~190M, Xvfb 17M, nginx 8M — well under 1.2GB estimate.

## Worker Integration Sketch

Branch on demand, use CDP to drive Ready wallet, then idle-pause.

```ts
import { Freestyle } from "freestyle";
import { chromium } from "playwright-core";

const freestyle = new Freestyle({ apiKey: process.env.FREESTYLE_API_KEY });

export async function ensureBrowserVM(userId: string) {
  const { vm, vmId } = await freestyle.vms.create({
    firewall: { rules: [{ action: "allow", source: {}, destination: { public: true }}]},
    snapshotId: "zor-browser-ready", // or sh-12764625269d40af8bd0315fed0271ec pinned
    idleTimeoutSeconds: 65, // auto-pause when idle, resume on next TLS hit
    metadata: { userId, purpose: "zor-dynamic-wallet" },
  });
  const cdpDomain = `zor-${userId}-${Date.now().toString(36)}.style.dev`;
  const vncDomain = `zor-vnc-${userId}-${Date.now().toString(36)}.style.dev`;
  await freestyle.tls.rules.create({ action:"allow", domain: cdpDomain, source:{ public:true }, destination:{ vmId, port: 9333 }});
  await freestyle.tls.rules.create({ action:"allow", domain: vncDomain, source:{ public:true }, destination:{ vmId, port: 6080 }});
  // wait for readiness (poll edge or internal)
  for(let i=0;i<30;i++){
    try{ await fetch(`https://${cdpDomain}/json/version`).then(r=>{if(!r.ok) throw new Error()}); break; }catch{ await new Promise(r=>setTimeout(r,2000)); }
  }
  return { vm, vmId, cdpDomain, vncDomain };
}

export async function withWallet(cdpDomain: string, fn: (page:any)=>Promise<any>) {
  const v = await fetch(`https://${cdpDomain}/json/version`).then(r=>r.json() as Promise<{webSocketDebuggerUrl:string}>);
  const wsUrl = v.webSocketDebuggerUrl.replace("ws://127.0.0.1:9222", `wss://${cdpDomain}`);
  const browser = await chromium.connectOverCDP(wsUrl);
  try {
    const ctx = browser.contexts()[0];
    if(!ctx) throw new Error("no context");
    const page = ctx.pages()[0] ?? await ctx.newPage();
    // Ready wallet injects window.starknet / window.ready after extension loads.
    // If extension was not auto-loaded (Google Chrome limitation), first do manual load via VNC or switch to Chromium snapshot.
    return await fn(page);
  } finally {
    await browser.close(); // disconnects, Chrome keeps running under systemd
  }
}

// Example per-user dynamic wallet (after extension is active)
//
// await withWallet(cdpDomain, async (page) => {
//   await page.goto("https://example.com", {waitUntil:"domcontentloaded"});
//   // The extension's inpage.js should expose window.starknet
//   const account = await page.evaluate(async () => {
//     // Ready wallet API — exact method names depend on wallet discovery spec
//     // @ts-ignore
//     const starknet = (window as any).starknet;
//     if(!starknet) throw new Error("starknet not injected");
//     await starknet.enable();
//     const addr = await starknet.request({ type: "wallet_requestAccounts" });
//     return addr;
//   });
//   // For privacy pool shield, the wallet's own prover runs in extension context:
//   // await page.evaluate(() => (window as any).starknet.request({ type: "wallet_strk20InvokeTransaction", params:{...}}))
// });

export async function releaseVM(vmId: string) {
  // Option 1: let idleTimeout pause it (cheap, resume on next request)
  await freestyle.vms.get(vmId).then(()=>{}); // keepalive
  // Option 2: explicit pause to save immediately
  // await freestyle.vms.ref(vmId).pause();
  // Option 3: teardown
  // await freestyle.vms.delete(vmId);
  // TLS rules are tied to VM and auto-delete with it; otherwise delete manually:
  // await freestyle.tls.rules.delete(tlsId);
}
```

Notes:
- Pin snapshotId `sh-12764625269d40af8bd0315fed0271ec` for immutable deploys, or use slug `zor-browser-ready` for latest.
- For extension to be present, either rebuild snapshot with Chromium (allows `--load-extension`) or, for current snapshot, after branching, load unpacked via VNC: `chrome://extensions` -> Developer mode -> Load unpacked -> `/opt/ready-extension`. That path exists on every branch.
- Wallet state is in `/root/.config/chromium-headed` (user-data-dir). For per-user isolation, either use separate `user-data-dir` per user (pass via CDP launcher flag requires restart) or, simpler, use separate branch VM per user (the `idleTimeout 65s` VM is already per-user, so wallet state is isolated by VM).
- After wallet operation, let VM idle-pause (65s) rather than delete — resume is faster than cold boot and preserves wallet session.
- Free tier fits: branch VM is same 4 vCPU/8GiB as snapshot; actual Chrome + X footprint <300M, no AVX512 needed.

## Cleanup

- Branch VM `zor-browser-test` (vm-04ce6635d48541bcaf35077a75c1fb5d) left running; delete via `await freestyle.vms.delete("zor-browser-test")` and TLS rules auto-delete (or `freestyle.tls.rules.delete(tlsId)`).
- Snapshots persist until 30d of no branch, then auto-delete. To keep longer, remove `autoDeleteSeconds` via `freestyle.vms.snapshots.update`.

## Files to Update in `worker` for On-Demand Flow

- `worker/src/browser.ts` (new): `ensureBrowserVM`, `withWallet`, `releaseVM` helpers above; reads `FREESTYLE_API_KEY` from env.
- `worker/wrangler.toml`: add `[vars] FREESTYLE_API_KEY` or secret via `wrangler secret put FREESTYLE_API_KEY`; also `BROWSER_SNAPSHOT_ID = "sh-12764625269d40af8bd0315fed0271ec"` and `BROWSER_CDP_PORT = 9333`.
- `worker/package.json`: add `freestyle` and `playwright-core` (dev at worker build time; note worker is Cloudflare Worker, so CDP connection must happen from a separate Node service or via `stealth-fetch`? Actually `playwright-core` cannot run inside Cloudflare Worker — run it in a separate Node helper or in the Freestyle VM itself via `vm.exec`. For Worker, call Freestyle API to branch, then fetch `https://<cdpDomain>/json/version` via regular fetch (Worker can fetch), then drive CDP via `fetch` + `WebSocket` if needed, or offload to a small Node sidecar. Document this architecture.
- `docs/freestyle-browser-vm.md` (this file) — handoff source of truth.
- `tmp/freestyle-build/` artifacts: `branch_screenshot.png` (Example Domain), `summary2.json`, `branch_test.log`.

## Next Steps (PO decision)

1. Re-snapshot `zor-browser-ready` with Chromium (allow load-extension) so `--load-extension` works without manual VNC.
2. Verify `window.starknet` injection on branch after fix via `page.evaluate`.
3. Implement worker sidecar for CDP wallet automation (since Cloudflare Workers cannot run `playwright-core` directly).
4. Add top-up/pause flow: reuse VM per user, `vm.pause()` after wallet use, `vm.start()` on next request.
