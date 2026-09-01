/**
 * Shield Service Types
 *
 * High-cohesion module for STRK20 privacy pool interactions.
 * Handles viewing key management, deposit (shield), and withdrawal (unshield).
 */

// ============ Core Types ============

export interface ShieldConfig {
  /** Privacy pool contract address */
  poolAddress: string;
  /** STRK token contract address */
  strkTokenAddress: string;
  /** Paymaster contract address for gas sponsorship */
  paymasterAddress: string;
  /** RPC node URL */
  rpcUrl: string;
  /** Master account private key (hex with 0x) */
  masterPrivateKey: string;
  /** Master account address */
  masterAddress: string;
  /** Chain ID (hex) */
  chainId: string;
}

export interface ViewingKey {
  /** Private viewing key (bigint as hex) */
  privateKey: string;
  /** Public viewing key (x-coordinate) */
  publicKey: string;
}

export interface ShieldResult {
  /** Transaction hash */
  txHash: string;
  /** Amount shielded (in wei) */
  amount: bigint;
  /** Block number (when confirmed) */
  blockNumber?: number;
}

export interface ShieldStatus {
  /** Whether the master account has a registered viewing key */
  hasViewingKey: boolean;
  /** Whether channels are set up */
  channelsReady: boolean;
  /** Current private balance (if discoverable) */
  privateBalance?: bigint;
}

// ============ Channel Types ============

export interface Channel {
  /** Recipient address */
  recipient: string;
  /** Channel ID (hash of sender + recipient) */
  channelId: string;
  /** Shared key for this channel */
  sharedKey: string;
}

export interface Subchannel {
  /** Token address */
  token: string;
  /** Subchannel ID (hash of channel + token) */
  subchannelId: string;
  /** Current nonce for this subchannel */
  nonce: number;
}

// ============ Note Types ============

export interface PrivateNote {
  /** Note ID (hash) */
  noteId: string;
  /** Token address */
  token: string;
  /** Amount (in wei) */
  amount: bigint;
  /** Encryption key for this note */
  encryptionKey: string;
  /** Whether this note has been spent */
  spent: boolean;
}

// ============ Proof Types ============

export interface ProofFacts {
  /** Proof version */
  proofVersion: string;
  /** Program variant */
  programVariant: string;
  /** Virtual program hash */
  virtualProgramHash: string;
  /** OS output version */
  osOutputVersion: string;
  /** Base block number */
  blockNumber: bigint;
  /** Base block hash */
  blockHash: string;
  /** Starknet OS config hash */
  configHash: string;
  /** Message hashes */
  messageHashes: string[];
}

export interface CompiledActions {
  /** Pool class hash */
  poolClassHash: string;
  /** Serialized server actions */
  serverActions: string[];
}
