// Example — see docs/freestyle-browser-vm.md for full sketch
// This file is a template; wire into worker via Freestyle API + CDP.
// Note: playwright-core cannot run inside Cloudflare Workers; run this from a Node sidecar or via vm.exec inside the Freestyle VM.

import { Freestyle } from "freestyle";
import { chromium } from "playwright-core";

export async function ensureBrowserVM(userId: string) {
  const freestyle = new Freestyle({ apiKey: process.env.FREESTYLE_API_KEY! });
  const { vm, vmId } = await freestyle.vms.create({
    firewall: { rules: [{ action: "allow", source: {}, destination: { public: true }}]},
    snapshotId: "sh-12764625269d40af8bd0315fed0271ec", // zor-browser-ready pinned
    idleTimeoutSeconds: 65,
    metadata: { userId, purpose: "zor-dynamic-wallet" },
  });
  const cdpDomain = `zor-${userId}-${Date.now().toString(36)}.style.dev`;
  await freestyle.tls.rules.create({ action:"allow", domain: cdpDomain, source:{ public:true }, destination:{ vmId, port: 9333 }});
  return { vm, vmId, cdpDomain };
}
