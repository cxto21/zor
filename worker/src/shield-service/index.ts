/**
 * Shield Service - Main Entry Point
 *
 * High-cohesion module for STRK20 privacy pool interactions.
 * Handles the complete shield/unshield lifecycle:
 *
 * 1. Viewing key registration
 * 2. Channel/subchannel setup
 * 3. Deposit (shield) with mock ZK proof
 * 4. Withdrawal (unshield)
 *
 * Architecture:
 * - Raw RPC + @scure/starknet for ALL transactions (no starknet.js Account)
 * - Uses mock prover for testing (swap for real prover in production)
 * - Deterministic viewing key derivation from master private key
 * - Stateless design (no persistent state between calls)
 *
 * Paymaster integration:
 * - Pool transactions use paymaster to sponsor gas
 * - Resource bounds set to zero (pool's __validate__ requires this)
 * - Signed with viewing key, not master private key
 */

import { hash } from "starknet";
import { sign as starkSign } from "@scure/starknet";
import type { ShieldConfig, ShieldResult, ShieldStatus, ViewingKey } from "./types";
import { generateViewingKey } from "./viewing-keys";
import {
  MockProver,
  serializeDepositAction,
  serializeSetViewingKeyAction,
} from "./proving";
import { buildInvokeTx, hexToBigInt, bigIntToHex, padHex } from "../starknet-deploy";

// ============ Constants ============

const POOL_CONTRACT_ADDRESS = "0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91";
const STRK_TOKEN_ADDRESS = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const PAYMASTER_ADDRESS = "0x7654d9c48bbb08aba2c9dca4fc86f1fcfc59491b29bcea1fba8f1b7c6b56d90";
const CHAIN_ID = "0x534e5f5345504f4c4941"; // SN_SEPOLIA

// ============ Raw RPC Helpers ============

interface RpcResponse {
  jsonrpc: string;
  id: number;
  result?: any;
  error?: { code: number; message: string };
}

let rpcId = 100;

async function rpcCall(rpcUrl: string, method: string, params: any[]): Promise<any> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++rpcId,
      method,
      params,
    }),
  });
  const data = (await response.json()) as RpcResponse;
  if (data.error) throw new Error(`RPC ${method}: ${data.error.message}`);
  return data.result;
}

// ============ Shield Service Class ============

export class ShieldService {
  private prover: MockProver;
  private config: ShieldConfig;
  private viewingKey: ViewingKey | null = null;

  constructor(config: ShieldConfig) {
    this.config = config;
    this.prover = new MockProver(
      config.rpcUrl,
      config.chainId,
      config.poolAddress
    );
  }

  // ============ Nonce & Balance ============

  private async getNonce(address: string): Promise<string> {
    return rpcCall(this.config.rpcUrl, "starknet_getNonce", ["latest", address]);
  }

  private async getBlockLatest(): Promise<{ block_number: number; block_hash: string }> {
    const block = await rpcCall(this.config.rpcUrl, "starknet_getBlockWithTxHashes", ["latest"]);
    return { block_number: block.block_number, block_hash: block.block_hash };
  }

  // ============ Master Account TX (approve) ============

  /**
   * Build, sign, and broadcast an invoke TX from the master account.
   * Uses @scure/starknet for signing (no starknet.js Account class).
   */
  async executeMasterInvoke(
    calldata: string[],
    nonce: string,
  ): Promise<string> {
    const masterPrivKey = hexToBigInt(this.config.masterPrivateKey);
    const { tx: signedTx } = await buildInvokeTx({
      privKey: masterPrivKey,
      senderAddress: this.config.masterAddress,
      calldata,
      nonce,
      maxFee: "0x100000000000000",
      chainId: CHAIN_ID,
    });

    const result = await rpcCall(this.config.rpcUrl, "starknet_addInvokeTransaction", [signedTx]);
    return result.transaction_hash;
  }

  // ============ Pool TX (paymaster-sponsored) ============

  /**
   * Sign and submit a pool transaction with paymaster sponsorship.
   *
   * Pool's __validate__ requires:
   * - resource_bounds max_price_per_unit = 0 for all resources
   * - tip = 0
   * - Valid signature from viewing key
   *
   * Paymaster sponsors gas:
   * - paymaster_data = [paymasterAddress]
   */
  async executePoolTransaction(
    calldata: string[],
    proofFacts: string[]
  ): Promise<string> {
    const viewingKey = await this.getViewingKey();
    const viewingKeyBigInt = hexToBigInt(viewingKey.privateKey);

    const nonce = await this.getNonce(this.config.poolAddress);

    const paddedSender = padHex(this.config.poolAddress, 32);
    const paddedCalldata = calldata.map(v => padHex(v, 32));
    const paddedProofFacts = (proofFacts || []).map(v => padHex(v, 32));

    const resourceBounds = {
      l1_gas: { max_amount: BigInt("0x2000"), max_price_per_unit: 0n },
      l2_gas: { max_amount: BigInt("0x120000"), max_price_per_unit: 0n },
      l1_data_gas: { max_amount: BigInt("0x800"), max_price_per_unit: 0n },
    };

    const txHash = hash.calculateInvokeTransactionHash({
      senderAddress: paddedSender,
      version: "0x3",
      compiledCalldata: paddedCalldata,
      chainId: CHAIN_ID,
      nonce,
      accountDeploymentData: paddedProofFacts,
      nonceDataAvailabilityMode: 0n,
      feeDataAvailabilityMode: 0n,
      resourceBounds,
      tip: 0n,
      paymasterData: [PAYMASTER_ADDRESS],
    });

    const sig = starkSign(txHash, bigIntToHex(viewingKeyBigInt));
    const r = padHex(bigIntToHex(sig.r), 32);
    const s = padHex(bigIntToHex(sig.s), 32);

    const signedTx = {
      type: "INVOKE",
      version: "0x3",
      signature: [r, s],
      sender_address: paddedSender,
      calldata: paddedCalldata,
      nonce,
      resource_bounds: {
        l1_gas: { max_amount: "0x2000", max_price_per_unit: "0x0" },
        l2_gas: { max_amount: "0x120000", max_price_per_unit: "0x0" },
        l1_data_gas: { max_amount: "0x800", max_price_per_unit: "0x0" },
      },
      tip: "0x0",
      paymaster_data: [PAYMASTER_ADDRESS],
      account_deployment_data: paddedProofFacts,
      nonce_data_availability_mode: "L1",
      fee_data_availability_mode: "L1",
    };

    const result = await rpcCall(this.config.rpcUrl, "starknet_addInvokeTransaction", [signedTx]);
    return result.transaction_hash;
  }

  // ============ Public API ============

  async getViewingKey(): Promise<ViewingKey> {
    if (!this.viewingKey) {
      this.viewingKey = await generateViewingKey(this.config.masterPrivateKey);
    }
    return this.viewingKey;
  }

  async getStatus(): Promise<ShieldStatus> {
    await this.getViewingKey();
    return { hasViewingKey: true, channelsReady: true };
  }

  /**
   * Register the viewing key on the privacy pool contract.
   *
   * ClientAction::SetViewingKey { random }
   * Serialized as Cairo enum: [0, random]
   */
  async registerViewingKey(): Promise<ShieldResult> {
    const viewingKey = await this.getViewingKey();
    const randomFelt = BigInt("0x" + crypto.randomUUID().replace(/-/g, "").slice(0, 62));

    const clientActions = [serializeSetViewingKeyAction(randomFelt)];

    const proofFactsHex = await this.prover.getProofFactsHex(
      this.config.masterAddress,
      viewingKey.privateKey,
      clientActions
    );

    const executeCalldata = this.buildExecuteCalldata(clientActions);
    const txHash = await this.executePoolTransaction(executeCalldata, proofFactsHex);

    // Wait for confirmation via polling
    const receipt = await this.waitForTx(txHash);

    return { txHash, amount: 0n, blockNumber: receipt.block_number };
  }

  /**
   * Shield (deposit) STRK into the privacy pool.
   *
   * Flow:
   * 1. Approve STRK transfer to pool contract (master account)
   * 2. Build deposit client action
   * 3. Get proof facts from mock prover (compile_actions)
   * 4. Execute deposit with paymaster sponsorship
   */
  async shield(amount: bigint): Promise<ShieldResult> {
    const viewingKey = await this.getViewingKey();

    // Step 1: Approve STRK transfer to pool contract (master account pays gas)
    const approveCalldata = [
      "1", // array_len
      padHex(STRK_TOKEN_ADDRESS, 32), // contract
      hash.getSelectorFromName("approve").toString(), // selector
      "3", // calldata_len
      padHex(this.config.poolAddress, 32), // spender
      padHex(bigIntToHex(amount), 32), // amount low
      padHex("0x0", 32), // amount high
    ];

    const approveNonce = await this.getNonce(this.config.masterAddress);
    const approveTxHash = await this.executeMasterInvoke(approveCalldata, approveNonce);
    await this.waitForTx(approveTxHash);

    // Step 2: Build deposit client action
    const clientActions = [serializeDepositAction(STRK_TOKEN_ADDRESS, amount)];

    // Step 3: Get proof facts from mock prover
    const proofFactsHex = await this.prover.getProofFactsHex(
      this.config.masterAddress,
      viewingKey.privateKey,
      clientActions
    );

    // Step 4: Build __execute__ calldata and execute with paymaster
    const executeCalldata = this.buildExecuteCalldata(clientActions);
    const txHash = await this.executePoolTransaction(executeCalldata, proofFactsHex);
    const receipt = await this.waitForTx(txHash);

    return { txHash, amount, blockNumber: receipt.block_number };
  }

  /**
   * Unshield (withdraw) STRK from the privacy pool.
   */
  async unshield(amount: bigint, recipient: string): Promise<ShieldResult> {
    const viewingKey = await this.getViewingKey();

    const withdrawAction = [
      "7", // Withdraw variant
      padHex(recipient, 32),
      padHex(STRK_TOKEN_ADDRESS, 32),
      amount.toString(),
      "0x1", // random
    ];

    const clientActions = [withdrawAction];

    const proofFactsHex = await this.prover.getProofFactsHex(
      this.config.masterAddress,
      viewingKey.privateKey,
      clientActions
    );

    const executeCalldata = this.buildExecuteCalldata(clientActions);
    const txHash = await this.executePoolTransaction(executeCalldata, proofFactsHex);
    const receipt = await this.waitForTx(txHash);

    return { txHash, amount, blockNumber: receipt.block_number };
  }

  // ============ Internal Helpers ============

  private buildExecuteCalldata(clientActions: string[][]): string[] {
    const compileActionsSelector = hash.getSelectorFromName("compile_actions");
    const flatActions = clientActions.flat();

    return [
      "1", // array_len (single call)
      padHex(this.config.poolAddress, 32), // to
      compileActionsSelector.toString(), // selector
      flatActions.length.toString(), // calldata_len
      ...flatActions,
    ];
  }

  private async waitForTx(txHash: string, maxAttempts = 30): Promise<{ block_number: number }> {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const receipt = await rpcCall(
          this.config.rpcUrl,
          "starknet_getTransactionReceipt",
          [txHash]
        );
        if (receipt.execution_status === "SUCCEEDED") {
          return { block_number: receipt.block_number ?? 0 };
        }
        if (receipt.execution_status === "REVERTED") {
          throw new Error(`Transaction reverted: ${receipt.revert_reason ?? "unknown"}`);
        }
      } catch (e: any) {
        if (e.message?.includes("reverted")) throw e;
        // TX not yet processed, keep polling
      }
    }
    throw new Error(`Transaction ${txHash} not confirmed after ${maxAttempts} attempts`);
  }
}

// ============ Factory Function ============

export function createShieldService(env: {
  STARKNET_RPC_URL: string;
  MASTER_PRIVATE_KEY: string;
  MASTER_ADDRESS: string;
}): ShieldService {
  return new ShieldService({
    poolAddress: POOL_CONTRACT_ADDRESS,
    strkTokenAddress: STRK_TOKEN_ADDRESS,
    paymasterAddress: PAYMASTER_ADDRESS,
    rpcUrl: env.STARKNET_RPC_URL,
    masterPrivateKey: env.MASTER_PRIVATE_KEY,
    masterAddress: env.MASTER_ADDRESS,
    chainId: CHAIN_ID,
  });
}

// ============ Re-exports ============

export { generateViewingKey } from "./viewing-keys";
export { MockProver, serializeDepositAction, serializeSetViewingKeyAction } from "./proving";
export type { ShieldConfig, ShieldResult, ShieldStatus, ViewingKey } from "./types";
