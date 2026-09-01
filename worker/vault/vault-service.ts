/**
 * Vault Service — SDK-driven STRK20 privacy pool integration.
 *
 * Replaces the broken ad-hoc mock (`compile_actions` via starknet_call) with the
 * OFFICIAL starknet-privacy SDK flow:
 *
 *   1. Compile high-level `Actions` → `ClientAction[]` (ActionCompiler)
 *   2. Build + sign a proof invocation against the pool `__execute__` with the viewing key
 *   3. Prove → `CallAndProof` whose `.call` targets `apply_actions` (NOT compile_actions)
 *      and whose `.proof.proofFacts` carry the VIRTUAL_SNOS facts the pool validates
 *      in `accountDeploymentData`.
 *
 * The proving provider is `CallMockProofProvider` with `validateSignature: false`,
 * which falls back to the plain `compile_actions` VIEW — so it runs on any node
 * (Alchemy Sepolia included) without needing `simulateTransaction`.
 *
 * NOTE: Settlement via `apply_actions` on the REAL Sepolia pool requires genuine
 * Virtual SNOS proofs (the pool validates `proof_facts` against the blockifier).
 * This service produces the correct upstream structure and is the foundation for
 * that; wiring a real prover (starknet-privacy prover / AVNU paymaster) or a devnet
 * with a mock-compatible pool swaps only the `provingProvider`.
 */

import {
  Account,
  Contract,
  RpcProvider,
  constants,
  type Call,
} from "starknet";
import { createPrivateTransfers } from "@starkware-libs/starknet-privacy-sdk";
import {
  CallMockProofProvider,
  ContractDiscoveryProvider,
} from "@starkware-libs/starknet-privacy-sdk/testing";
import { PrivacyPoolABI } from "@starkware-libs/starknet-privacy-sdk/abi";
import { generateViewingKey } from "../src/shield-service/viewing-keys";

// ============ Constants ============

const POOL_CONTRACT_ADDRESS =
  "0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91";
const STRK_TOKEN_ADDRESS =
  "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const CHAIN_ID = constants.StarknetChainId.SN_SEPOLIA;

// ============ Public Result Types ============

export type VaultExecuteResult = {
  /** The `apply_actions` call that must be submitted to settle this action. */
  call: Call;
  /** Proof facts to put in `accountDeploymentData` of the settlement V3 INVOKE. */
  proofFacts: string[];
  /** L2-to-L1 message payload `[class_hash, ...server_actions]`. */
  proofOutput: string[];
  /** Minimal PRIVACY note-free summary for the worker/frontend. */
  warnings: { code: string; message: string }[];
};

// ============ Vault Service ============

export class VaultService {
  private provider: RpcProvider;
  private poolContract: Contract;
  private privateTransfers: ReturnType<typeof createPrivateTransfers>;

  constructor(private config: { rpcUrl: string; masterAddress: string; masterPrivateKey: string }) {
    this.provider = new RpcProvider({ nodeUrl: config.rpcUrl });

    // A real starknet.js Account is the `PrivateTransfersUser` the SDK expects:
    // it supplies `signTransaction`/`getPubKey` for signing proof invocations.
    const account = new Account({
      provider: this.provider,
      address: config.masterAddress,
      signer: config.masterPrivateKey,
      cairoVersion: "1",
    });

    // Typed contract instance used by ContractDiscoveryProvider (on-chain reads only).
    this.poolContract = new Contract({
      abi: PrivacyPoolABI,
      address: POOL_CONTRACT_ADDRESS,
      providerOrAccount: this.provider,
    }).typedv2(PrivacyPoolABI);

    this.privateTransfers = createPrivateTransfers({
      account,
      viewingKeyProvider: {
        // Reuse the deterministic [1, N/2] viewing-key derivation already in the worker.
        getViewingKey: async () => {
          const vk = await generateViewingKey(config.masterPrivateKey);
          return vk.privateKey;
        },
      },
      provingProvider: new CallMockProofProvider(this.provider, CHAIN_ID, {
        validateSignature: false,
      }),
      discoveryProvider: new ContractDiscoveryProvider(this.poolContract as never),
      poolContractAddress: POOL_CONTRACT_ADDRESS,
    });
  }

  private toResult(r: { callAndProof: { call: Call; proof: { proofFacts: string[]; output: string[] } } }): VaultExecuteResult {
    return {
      call: r.callAndProof.call,
      proofFacts: r.callAndProof.proof.proofFacts,
      proofOutput: r.callAndProof.proof.output,
      warnings: [],
    };
  }

  private get defaultOptions() {
    return {
      autoRegister: true,
      autoSetup: true,
      autoDiscover: { channels: "missing" as const, notes: "all" as const },
      autoSelectNotes: "all" as const,
    };
  }

  /**
   * Build the register proof call (SetViewingKey + auto channel setup).
   */
  async register(): Promise<VaultExecuteResult> {
    const result = await this.privateTransfers
      .build(this.defaultOptions)
      .register()
      .execute();
    return this.toResult(result);
  }

  /**
   * Build the shield (deposit) proof call for STRK into the pool.
   *
   * Builder chain: .with(STRK).deposit([{ amount }]).done().execute()
   */
  async shield(amount: bigint): Promise<VaultExecuteResult> {
    const result = await this.privateTransfers
      .build(this.defaultOptions)
      .with(STRK_TOKEN_ADDRESS)
      .deposit({ amount })
      .done()
      .execute();
    return this.toResult(result);
  }

  /**
   * Build the unshield (withdraw) proof call for STRK out of the pool.
   *
   * Builder chain: .with(STRK).withdraw({ recipient, amount }).done().execute()
   */
  async unshield(amount: bigint, recipient: string): Promise<VaultExecuteResult> {
    const result = await this.privateTransfers
      .build(this.defaultOptions)
      .with(STRK_TOKEN_ADDRESS)
      .withdraw({ recipient, amount })
      .done()
      .execute();
    return this.toResult(result);
  }
}

// ============ Factory ============

export function createVaultService(env: {
  STARKNET_RPC_URL: string;
  MASTER_ADDRESS: string;
  MASTER_PRIVATE_KEY: string;
}): VaultService {
  return new VaultService({
    rpcUrl: env.STARKNET_RPC_URL,
    masterAddress: env.MASTER_ADDRESS,
    masterPrivateKey: env.MASTER_PRIVATE_KEY,
  });
}
