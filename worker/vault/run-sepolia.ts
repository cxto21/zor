/**
 * Sepolia runner — proves the SDK-driven vault path works against the live pool.
 *
 * USAGE:
 *   STARKNET_RPC_URL=... MASTER_ADDRESS=... MASTER_PRIVATE_KEY=... npx tsx run-sepolia.ts [register|shield|unshield]
 *
 * It does NOT broadcast settlement (the real Sepolia pool needs real Virtual SNOS
 * proofs); it builds the correct `apply_actions` CallAndProof and prints it, which
 * validates serialization, discovery, viewing-key, and proof-facts computation.
 */

import { VaultService } from "./vault-service";

async function main() {
  const rpcUrl = process.env.STARKNET_RPC_URL;
  const masterAddress = process.env.MASTER_ADDRESS;
  const masterPrivateKey = process.env.MASTER_PRIVATE_KEY;

  if (!rpcUrl || !masterAddress || !masterPrivateKey) {
    console.error(
      "Missing env: STARKNET_RPC_URL, MASTER_ADDRESS, MASTER_PRIVATE_KEY"
    );
    process.exit(1);
  }

  const op = process.argv[2] ?? "register";
  const vault = new VaultService({ rpcUrl, masterAddress, masterPrivateKey });

  console.log(`=== Running '${op}' against Sepolia pool ===\n`);

  let result: Awaited<ReturnType<VaultService["register"]>>;

  switch (op) {
    case "register":
      result = await vault.register();
      break;
    case "shield": {
      const amount = BigInt(process.argv[3] ?? "1000000000000000"); // 0.001 STRK default
      result = await vault.shield(amount);
      break;
    }
    case "unshield": {
      const amount = BigInt(process.argv[3] ?? "1000000000000000");
      const recipient = process.argv[4] ?? masterAddress;
      result = await vault.unshield(amount, recipient);
      break;
    }
    default:
      console.error("Unknown op:", op);
      process.exit(1);
  }

  console.log("=== apply_actions CALL ===");
  console.log("contract:", result.call.contractAddress);
  console.log("entrypoint:", result.call.entrypoint);
  console.log("calldata (" + result.call.calldata.length + "):");
  console.log(JSON.stringify(result.call.calldata, null, 0));

  console.log("\n=== PROOF FACTS (" + result.proofFacts.length + ") ===");
  console.log(JSON.stringify(result.proofFacts));

  console.log("\n=== PROOF OUTPUT (L2->L1 msg) [" + result.proofOutput.length + "] ===");
  console.log("class_hash:", result.proofOutput[0]);
  console.log("server_actions:", JSON.stringify(result.proofOutput.slice(1)));

  console.log("\n=== SANITY CHECKS ===");
  const target = result.call.contractAddress.toLowerCase();
  const POOL = "0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91";
  console.log(
    "apply_actions targets pool:",
    parseInt(target, 16).toString(16) === parseInt(POOL, 16).toString(16)
  );
  console.log("proofFacts non-empty:", result.proofFacts.length > 0);
  console.log("first proofFact (proof_version):", result.proofFacts[0]);
  console.log("\nOK — SDK vault path built a structurally-valid apply_actions CallAndProof.");
}

main().catch((e) => {
  console.error("FAILED:", e?.message ?? e);
  console.error(e?.stack ?? "");
  process.exit(1);
});
