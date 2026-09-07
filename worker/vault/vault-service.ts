/**
 * Vault Service — SDK-driven STRK20 privacy pool integration (Master-Receiver Model).
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
 * Master-Receiver Pivot: Single master account (0x12f8b...) is registered once in the pool.
 * Users (already registered via Ready wallet) private-transfer STRK to MASTER_ADDRESS via
 * wallet.strk20InvokeTransaction. Worker attributes payments by sender channel via discoverNotes.
 *
 * Proving: Uses ProvingServiceProofProvider when PROVING_SERVICE_URL is set (real VIRTUAL_SNOS
 * proofs via transaction-prover). Falls back to CallMockProofProvider for local dev (Alchemy
 * Sepolia without simulateTransaction). Real proofs need 10-block maturity (provingBlockId = head-10)
 * so the blockifier can verify the block hash in proofFacts.
 *
 * NOTE: Settlement via `apply_actions` on the REAL Sepolia pool requires genuine
 * Virtual SNOS proofs (the pool validates `proof_facts` against the blockifier).
 * This service produces the correct upstream structure and is the foundation for
 * that; wiring a real prover (starknet-privacy prover / AVNU paymaster) or a devnet
 * with a mock-compatible pool swaps only the `provingProvider`.
 *
 * Prover requirement: real VIRTUAL_SNOS proof needs PROVING_SERVICE_URL
 * (ghcr.io/starkware-libs/starknet-privacy/transaction-prover:PRIVACY-0.14.3-RC.2 on Fly/Railway)
 * with 10-block maturity (provingBlockId = head-10).
 */

import {
  Account,
  Contract,
  RpcProvider,
  constants,
  type Call,
} from "starknet";
import {
  createPrivateTransfers,
  ProvingServiceProofProvider,
} from "@starkware-libs/starknet-privacy-sdk";
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

  constructor(
    private config: {
      rpcUrl: string;
      masterAddress: string;
      masterPrivateKey: string;
      provingServiceUrl?: string;
    },
  ) {
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
    // NOTE: ContractDiscoveryProvider is kept for now; IndexerDiscoveryProvider is preferred
    // for prod (requires indexer URL, not yet deployed) but not exported in this env.
    this.poolContract = new Contract({
      abi: PrivacyPoolABI,
      address: POOL_CONTRACT_ADDRESS,
      providerOrAccount: this.provider,
    }).typedv2(PrivacyPoolABI);

    // Proving provider: real VIRTUAL_SNOS via proving service if configured, else mock for local dev.
    // Real prover: ghcr.io/starkware-libs/starknet-privacy/transaction-prover:PRIVACY-0.14.3-RC.2
    // Requires 10-block maturity (provingBlockId = head-10) so blockifier can verify block hash.
    const provingProvider = config.provingServiceUrl
      ? new ProvingServiceProofProvider(config.provingServiceUrl, CHAIN_ID)
      : new CallMockProofProvider(this.provider as unknown as never, CHAIN_ID, {
          validateSignature: false,
        });

    this.privateTransfers = createPrivateTransfers({
      account,
      viewingKeyProvider: {
        // Reuse the deterministic [1, N/2] viewing-key derivation already in the worker.
        // Must return BigInt (not string) — SDK ViewKey range check expects bigint.
        getViewingKey: async () => BigInt((await generateViewingKey(config.masterPrivateKey)).privateKey),
      },
      provingProvider,
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

  /**
   * Discover notes for the master account (incoming private transfers).
   * Used by /verify-private-transfer to attribute payments by sender channel.
   */
  async discoverNotes(params?: { blockIdentifier?: unknown }) {
    return this.privateTransfers.discoverNotes(params as never);
  }

  /**
   * Discover channels for given recipients (sender attribution).
   */
  async discoverChannels(recipients: unknown, params?: unknown) {
    return this.privateTransfers.discoverChannels(recipients as never, params as never);
  }

  /** Whether a real proving service is configured (vs mock fallback). */
  isMockProver(): boolean {
    return !this.config.provingServiceUrl;
  }

  /** Expose raw privateTransfers for advanced callers (e.g. verify-private-transfer). */
  get rawTransfers() {
    return this.privateTransfers;
  }
}

// ============ Factory ============

export function createVaultService(env: {
  STARKNET_RPC_URL: string;
  MASTER_ADDRESS: string;
  MASTER_PRIVATE_KEY: string;
  PROVING_SERVICE_URL?: string;
}): VaultService {
  return new VaultService({
    rpcUrl: env.STARKNET_RPC_URL,
    masterAddress: env.MASTER_ADDRESS,
    masterPrivateKey: env.MASTER_PRIVATE_KEY,
    provingServiceUrl: env.PROVING_SERVICE_URL,
  });
}
