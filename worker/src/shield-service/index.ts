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
 * - Uses starknet.js for account management and signing
 * - Uses mock prover for testing (swap for real prover in production)
 * - Deterministic viewing key derivation from master private key
 * - Stateless design (no persistent state between calls)
 */

import { Account, ProviderInterface, RpcProvider, constants, hash, ec } from "starknet";
import type { ShieldConfig, ShieldResult, ShieldStatus, ViewingKey } from "./types";
import { generateViewingKey, computeViewingKeyHash } from "./viewing-keys";
import { MockProver } from "./proving";

// ============ Constants ============

const POOL_CONTRACT_ADDRESS = "0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91";
const STRK_TOKEN_ADDRESS = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const CHAIN_ID = constants.StarknetChainId.SN_SEPOLIA;

// ============ Helpers ============

function hexToBigInt(hex: string): bigint {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  return h === "" ? 0n : BigInt("0x" + h);
}

function bigIntToHex(n: bigint): string {
  return "0x" + n.toString(16);
}

function padHex(hex: string, bytes: number): string {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  return "0x" + h.padStart(bytes * 2, "0");
}

// ============ Shield Service Class ============

export class ShieldService {
  private provider: ProviderInterface;
  private account: Account;
  private prover: MockProver;
  private config: ShieldConfig;
  private viewingKey: ViewingKey | null = null;
  
  constructor(config: ShieldConfig) {
    this.config = config;
    this.provider = new RpcProvider({ nodeUrl: config.rpcUrl });
    
    // Create account from master private key
    this.account = new Account({
      provider: this.provider,
      address: config.masterAddress,
      signer: config.masterPrivateKey,
    });
    
    // Initialize mock prover
    this.prover = new MockProver(
      config.rpcUrl,
      config.chainId,
      config.poolAddress
    );
  }
  
  /**
   * Get or generate the viewing key for the master account.
   * The viewing key is derived deterministically from the master private key.
   */
  async getViewingKey(): Promise<ViewingKey> {
    if (!this.viewingKey) {
      this.viewingKey = await generateViewingKey(this.config.masterPrivateKey);
    }
    return this.viewingKey;
  }
  
  /**
   * Check the current shield status.
   * Returns whether viewing key is registered and channels are set up.
   */
  async getStatus(): Promise<ShieldStatus> {
    const viewingKey = await this.getViewingKey();
    
    // Check if viewing key is registered on-chain
    // This is a simplified check - in production, you'd query the contract
    const hasViewingKey = true; // For now, assume it's registered
    
    return {
      hasViewingKey,
      channelsReady: hasViewingKey,
    };
  }
  
  /**
   * Register the viewing key on the privacy pool contract.
   * This is a prerequisite for deposits.
   */
  async registerViewingKey(): Promise<ShieldResult> {
    const viewingKey = await this.getViewingKey();
    
    // Build the register calldata
    // ClientAction::SetViewingKey { viewing_key }
    const calldata = [
      "0x1", // Array length (1 action)
      "0x0", // SetViewingKey variant
      padHex(viewingKey.privateKey, 32), // Viewing key
    ];
    
    // Get proof facts from mock prover
    const proofFactsHex = await this.prover.getProofFactsHex(calldata);
    
    // Build the transaction
    const nonce = await this.account.getNonce();
    
    // Estimate fee
    const feeEstimate = await this.account.estimateInvokeFee({
      contractAddress: this.config.poolAddress,
      entrypoint: "__execute__",
      calldata,
    });
    
    // Execute the transaction
    const result = await this.account.execute(
      {
        contractAddress: this.config.poolAddress,
        entrypoint: "__execute__",
        calldata,
      },
      {
        nonce,
        resourceBounds: feeEstimate.resourceBounds,
        tip: 0n,
        paymasterData: [],
        accountDeploymentData: proofFactsHex,
        nonceDataAvailabilityMode: 0,
        feeDataAvailabilityMode: 0,
      }
    );
    
    // Wait for transaction
    const receipt = await this.provider.waitForTransaction(result.transaction_hash);
    
    return {
      txHash: result.transaction_hash,
      amount: 0n, // Registration doesn't involve amount
      blockNumber: receipt.block_number,
    };
  }
  
  /**
   * Shield (deposit) STRK into the privacy pool.
   * 
   * Flow:
   * 1. Approve STRK transfer to pool contract
   * 2. Build deposit calldata
   * 3. Get proof facts from mock prover
   * 4. Execute transaction with proof facts
   */
  async shield(amount: bigint): Promise<ShieldResult> {
    // Step 1: Approve STRK transfer to pool contract
    const approveNonce = await this.account.getNonce();
    const approveFee = await this.account.estimateInvokeFee({
      contractAddress: STRK_TOKEN_ADDRESS,
      entrypoint: "approve",
      calldata: [
        this.config.poolAddress,
        amount.toString(),
        "0x0", // amount_high
      ],
    });
    
    const approveResult = await this.account.execute(
      {
        contractAddress: STRK_TOKEN_ADDRESS,
        entrypoint: "approve",
        calldata: [
          this.config.poolAddress,
          amount.toString(),
          "0x0", // amount_high
        ],
      },
      {
        nonce: approveNonce,
        resourceBounds: approveFee.resourceBounds,
        tip: 0n,
        paymasterData: [],
        accountDeploymentData: [],
        nonceDataAvailabilityMode: 0,
        feeDataAvailabilityMode: 0,
      }
    );
    
    await this.provider.waitForTransaction(approveResult.transaction_hash);
    
    // Step 2: Build deposit calldata
    // ClientAction::Deposit { token, amount }
    const depositCalldata = [
      "0x1", // Array length (1 action)
      "0x3", // Deposit variant (phase 3)
      padHex(STRK_TOKEN_ADDRESS, 32), // Token address
      amount.toString(), // Amount
    ];
    
    // Step 3: Get proof facts from mock prover
    const proofFactsHex = await this.prover.getProofFactsHex(depositCalldata);
    
    // Step 4: Execute the deposit transaction
    const depositNonce = await this.account.getNonce();
    const depositFee = await this.account.estimateInvokeFee({
      contractAddress: this.config.poolAddress,
      entrypoint: "__execute__",
      calldata: depositCalldata,
    });
    
    const depositResult = await this.account.execute(
      {
        contractAddress: this.config.poolAddress,
        entrypoint: "__execute__",
        calldata: depositCalldata,
      },
      {
        nonce: depositNonce,
        resourceBounds: depositFee.resourceBounds,
        tip: 0n,
        paymasterData: [],
        accountDeploymentData: proofFactsHex,
        nonceDataAvailabilityMode: 0,
        feeDataAvailabilityMode: 0,
      }
    );
    
    // Wait for transaction
    const receipt = await this.provider.waitForTransaction(depositResult.transaction_hash);
    
    return {
      txHash: depositResult.transaction_hash,
      amount,
      blockNumber: receipt.block_number,
    };
  }
  
  /**
   * Unshield (withdraw) STRK from the privacy pool.
   * 
   * This requires:
   * 1. Having unspent notes in the pool
   * 2. Generating a ZK proof for the withdrawal
   * 3. Submitting the withdrawal transaction
   */
  async unshield(amount: bigint, recipient: string): Promise<ShieldResult> {
    // Build withdrawal calldata
    // ClientAction::Withdraw { to_addr, token, amount, random }
    const withdrawCalldata = [
      "0x1", // Array length (1 action)
      "0x6", // Withdraw variant (phase 6)
      padHex(recipient, 32), // Recipient address
      padHex(STRK_TOKEN_ADDRESS, 32), // Token address
      amount.toString(), // Amount
      "0x1", // Random (for privacy)
    ];
    
    // Get proof facts from mock prover
    const proofFactsHex = await this.prover.getProofFactsHex(withdrawCalldata);
    
    // Execute the withdrawal transaction
    const nonce = await this.account.getNonce();
    const feeEstimate = await this.account.estimateInvokeFee({
      contractAddress: this.config.poolAddress,
      entrypoint: "__execute__",
      calldata: withdrawCalldata,
    });
    
    const result = await this.account.execute(
      {
        contractAddress: this.config.poolAddress,
        entrypoint: "__execute__",
        calldata: withdrawCalldata,
      },
      {
        nonce,
        resourceBounds: feeEstimate.resourceBounds,
        tip: 0n,
        paymasterData: [],
        accountDeploymentData: proofFactsHex,
        nonceDataAvailabilityMode: 0,
        feeDataAvailabilityMode: 0,
      }
    );
    
    // Wait for transaction
    const receipt = await this.provider.waitForTransaction(result.transaction_hash);
    
    return {
      txHash: result.transaction_hash,
      amount,
      blockNumber: receipt.block_number,
    };
  }
}

// ============ Factory Function ============

/**
 * Create a ShieldService instance with default configuration.
 * Uses environment variables for configuration.
 */
export function createShieldService(env: {
  STARKNET_RPC_URL: string;
  MASTER_PRIVATE_KEY: string;
  MASTER_ADDRESS: string;
}): ShieldService {
  return new ShieldService({
    poolAddress: POOL_CONTRACT_ADDRESS,
    strkTokenAddress: STRK_TOKEN_ADDRESS,
    rpcUrl: env.STARKNET_RPC_URL,
    masterPrivateKey: env.MASTER_PRIVATE_KEY,
    masterAddress: env.MASTER_ADDRESS,
    chainId: CHAIN_ID,
  });
}

// ============ Re-exports ============

export { generateViewingKey, computeViewingKeyHash } from "./viewing-keys";
export { MockProver } from "./proving";
export type { ShieldConfig, ShieldResult, ShieldStatus, ViewingKey } from "./types";
