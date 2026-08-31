/**
 * Mock Prover
 * 
 * Implements the proof generation using the mock approach:
 * 1. Call compile_actions on the pool contract
 * 2. Build proof facts from compiled actions
 * 3. Return proof without actual ZK proof generation
 * 
 * This is suitable for testing and development.
 * For production, use a real proving service.
 */

import { hash, ec, ProviderInterface, RpcProvider } from "starknet";
import type { ProofFacts, CompiledActions } from "./types";

// ============ Constants ============

const PROOF_VERSION = "PROOF0";
const VIRTUAL_SNOS = "VIRTUAL_SNOS";
const VIRTUAL_SNOS0 = "VIRTUAL_SNOS0";
const VIRTUAL_PROGRAM_HASH = "0x3e98c2d7703b03a7edb73ed7f075f97f1dcbaa8f717cdf6e1a57bf058265473";
const STRK_FEE_TOKEN_ADDRESS = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const STARKNET_OS_CONFIG_HASH_VERSION = "0x537461726b6e65744f73436f6e66696733";

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

// ============ Proof Facts Computation ============

/**
 * Compute the virtual OS config hash.
 * Matches Cairo's: Pedersen::hash_array([STARKNET_OS_CONFIG_HASH_VERSION, chain_id, strk_fee_token_address])
 */
function computeVirtualOsConfigHash(chainId: string): string {
  return hash.computeHashOnElements([
    STARKNET_OS_CONFIG_HASH_VERSION,
    hexToBigInt(chainId),
    hexToBigInt(STRK_FEE_TOKEN_ADDRESS),
  ]);
}

/**
 * Compute the message hash for L2-to-L1 message.
 * Matches Cairo's: poseidon([pool_address, 0, payload_len, ...serialized_actions])
 */
function computeMessageHash(
  poolAddress: string,
  poolClassHash: string,
  serverActions: string[]
): bigint {
  const messagePayload = [poolClassHash, ...serverActions];
  const feltValues = [
    hexToBigInt(poolAddress),
    0n,
    BigInt(messagePayload.length),
    ...serverActions.map(hexToBigInt),
  ];
  return ec.starkCurve.poseidonHashMany(feltValues);
}

/**
 * Build proof facts from compiled actions.
 * This is the mock proof that doesn't require actual ZK proof generation.
 */
export function buildProofFacts(
  poolAddress: string,
  poolClassHash: string,
  serverActions: string[],
  blockNumber: bigint,
  blockHash: string,
  chainId: string
): string[] {
  const messageHash = computeMessageHash(poolAddress, poolClassHash, serverActions);
  const configHash = computeVirtualOsConfigHash(chainId);
  
  return [
    padHex(hexToBigInt(PROOF_VERSION).toString(16), 32), // proof_version
    padHex(hexToBigInt(VIRTUAL_SNOS).toString(16), 32), // program_variant
    VIRTUAL_PROGRAM_HASH, // virtual_program_hash
    padHex(hexToBigInt(VIRTUAL_SNOS0).toString(16), 32), // starknet_os_output_version
    padHex(blockNumber.toString(16), 32), // base_block_number
    padHex(hexToBigInt(blockHash).toString(16), 32), // base_block_hash
    configHash, // starknet_os_config_hash
    "0x1", // message_to_l1_hashes length (Span serialization)
    padHex(messageHash.toString(16), 32), // message_to_l1_hashes[0]
  ];
}

// ============ Mock Prover ============

export class MockProver {
  private provider: ProviderInterface;
  private chainId: string;
  private poolAddress: string;
  
  constructor(
    rpcUrl: string,
    chainId: string,
    poolAddress: string
  ) {
    this.provider = new RpcProvider({ nodeUrl: rpcUrl });
    this.chainId = chainId;
    this.poolAddress = poolAddress;
  }
  
  /**
   * Compile actions by calling the pool contract's compile_actions entry point.
   * This returns the server actions without generating a real ZK proof.
   */
  async compileActions(
    calldata: string[],
    blockIdentifier?: string | number
  ): Promise<CompiledActions> {
    const [serverActions, poolClassHash] = await Promise.all([
      this.provider.callContract(
        {
          contractAddress: this.poolAddress,
          entrypoint: "compile_actions",
          calldata,
        },
        blockIdentifier
      ),
      this.provider.getClassHashAt(this.poolAddress, blockIdentifier),
    ]);
    
    return {
      poolClassHash,
      serverActions,
    };
  }
  
  /**
   * Generate mock proof facts.
   * This is the main entry point for the mock prover.
   */
  async generateProof(
    calldata: string[],
    blockIdentifier?: string | number
  ): Promise<ProofFacts> {
    // Get the base block for proof facts
    let blockNumber: bigint;
    let blockHash: string;
    
    if (blockIdentifier) {
      const block = await this.provider.getBlock(blockIdentifier);
      blockNumber = BigInt(block.block_number);
      blockHash = block.block_hash ?? "0x0";
    } else {
      // Use latest block minus 10 for safety
      const latestBlock = await this.provider.getBlock("latest");
      const currentBlockNumber = BigInt(latestBlock.block_number);
      const blocksBack = 10n;
      blockNumber = currentBlockNumber > blocksBack ? currentBlockNumber - blocksBack : 1n;
      const baseBlock = await this.provider.getBlock(Number(blockNumber));
      blockHash = baseBlock.block_hash ?? "0x0";
    }
    
    // Compile actions
    const { poolClassHash, serverActions } = await this.compileActions(calldata, blockIdentifier);
    
    // Build proof facts
    const proofFactsArray = buildProofFacts(
      this.poolAddress,
      poolClassHash,
      serverActions,
      blockNumber,
      blockHash,
      this.chainId
    );
    
    return {
      proofVersion: PROOF_VERSION,
      programVariant: VIRTUAL_SNOS,
      virtualProgramHash: VIRTUAL_PROGRAM_HASH,
      osOutputVersion: VIRTUAL_SNOS0,
      blockNumber,
      blockHash,
      configHash: proofFactsArray[6],
      messageHashes: [proofFactsArray[8]],
    };
  }
  
  /**
   * Get proof facts as hex array for transaction submission.
   */
  async getProofFactsHex(
    calldata: string[],
    blockIdentifier?: string | number
  ): Promise<string[]> {
    const latestBlock = await this.provider.getBlock("latest");
    const currentBlockNumber = BigInt(latestBlock.block_number);
    const blocksBack = 10n;
    const blockNumber = currentBlockNumber > blocksBack ? currentBlockNumber - blocksBack : 1n;
    const baseBlock = await this.provider.getBlock(Number(blockNumber));
    const blockHash = baseBlock.block_hash ?? "0x0";
    
    const { poolClassHash, serverActions } = await this.compileActions(calldata, blockIdentifier);
    
    return buildProofFacts(
      this.poolAddress,
      poolClassHash,
      serverActions,
      blockNumber,
      blockHash,
      this.chainId
    );
  }
}
