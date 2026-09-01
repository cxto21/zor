/**
 * Mock Prover
 *
 * Implements the proof generation using the mock approach:
 * 1. Call compile_actions on the pool contract via __execute__
 * 2. Build proof facts from compiled actions
 * 3. Return proof without actual ZK proof generation
 *
 * ABI for compile_actions:
 *   fn compile_actions(
 *       user_addr: ContractAddress,
 *       user_private_key: felt252,  // viewing key
 *       client_actions: Span<ClientAction>,
 *   ) -> Span<ServerAction>
 *
 * ClientAction is a Cairo enum:
 *   0: SetViewingKey(SetViewingKeyInput)
 *   1: OpenChannel(OpenChannelInput)
 *   2: OpenSubchannel(OpenSubchannelInput)
 *   3: CreateEncNote(CreateEncNoteInput)
 *   4: CreateOpenNote(CreateOpenNoteInput)
 *   5: Deposit(DepositInput)  { token, amount }
 *   6: UseNote(UseNoteInput)
 *   7: Withdraw(WithdrawInput)
 *   8: InvokeExternal(InvokeExternalInput)
 *   9: ComputeAndInvoke(ComputeAndInvokeInput)
 *
 * The pool is an Account contract, so all external calls go through __execute__.
 */

import { hash, ec, ProviderInterface, RpcProvider, CallData } from "starknet";
import type { ProofFacts, CompiledActions } from "./types";

// ============ Constants ============

const PROOF_VERSION = "PROOF0";
const VIRTUAL_SNOS = "VIRTUAL_SNOS";
const VIRTUAL_SNOS0 = "VIRTUAL_SNOS0";
const VIRTUAL_PROGRAM_HASH = "0x3e98c2d7703b03a7edb73ed7f075f97f1dcbaa8f717cdf6e1a57bf058265473";
const STRK_FEE_TOKEN_ADDRESS = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const STARKNET_OS_CONFIG_HASH_VERSION = "0x537461726b6e65744f73436f6e66696733";

// ClientAction variant indices (from ABI enum order)
const CLIENT_ACTION_VARIANT = {
  SetViewingKey: 0,
  OpenChannel: 1,
  OpenSubchannel: 2,
  CreateEncNote: 3,
  CreateOpenNote: 4,
  Deposit: 5,
  UseNote: 6,
  Withdraw: 7,
  InvokeExternal: 8,
  ComputeAndInvoke: 9,
} as const;

// ============ Helpers ============

function hexToBigInt(hex: string): bigint {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  return h === "" ? 0n : BigInt("0x" + h);
}

function padHex(hex: string, bytes: number): string {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  return "0x" + h.padStart(bytes * 2, "0");
}

function padFelt(value: bigint | string): string {
  const hex = typeof value === "string" ? value : "0x" + value.toString(16);
  return padHex(hex, 32);
}

// ============ Cairo Enum Serialization ============

/**
 * Serialize a ClientAction Deposit into Cairo enum format.
 *
 * Cairo enum: [variant_index, ...flattened_fields]
 * DepositInput { token: ContractAddress, amount: u128 }
 * => [5, token_address, amount]
 */
export function serializeDepositAction(tokenAddress: string, amount: bigint): string[] {
  return [
    CLIENT_ACTION_VARIANT.Deposit.toString(),
    padFelt(tokenAddress),
    padFelt(amount),
  ];
}

/**
 * Serialize a ClientAction SetViewingKey into Cairo enum format.
 * SetViewingKeyInput { random: felt252 }
 * => [0, random]
 */
export function serializeSetViewingKeyAction(random: bigint): string[] {
  return [
    CLIENT_ACTION_VARIANT.SetViewingKey.toString(),
    padFelt(random),
  ];
}

// ============ Calldata Building ============

/**
 * Build compile_actions calldata.
 *
 * compile_actions expects: (user_addr, user_private_key, client_actions: Span<ClientAction>)
 * In felt format: [user_addr, user_private_key, actions_array_len, ...action1, ...action2, ...]
 */
export function buildCompileActionsCalldata(
  userAddr: string,
  viewingKey: string,
  clientActions: string[][]
): string[] {
  const flatActions = clientActions.flat();
  return [
    padFelt(userAddr),
    padFelt(viewingKey),
    clientActions.length.toString(),
    ...flatActions,
  ];
}

/**
 * Wrap a compile_actions call into __execute__ calldata.
 *
 * __execute__ expects: Array<Call>
 * Call { to: ContractAddress, selector: felt252, calldata: Span<felt252> }
 *
 * Calldata layout: [array_len=1, to, selector, calldata_len, ...calldata]
 */
export function wrapInExecuteCall(
  poolAddress: string,
  innerCalldata: string[]
): string[] {
  const compileActionsSelector = hash.getSelectorFromName("compile_actions");

  return new CallData([
    {
      type: "struct",
      name: "core::starknet::account::Call",
      members: [
        { name: "to", type: "core::starknet::contract_address::ContractAddress" },
        { name: "selector", type: "core::felt252" },
        { name: "calldata", type: "core::array::Span::<core::felt252>" },
      ],
    },
  ]).compile("__execute__", [
    [
      {
        to: poolAddress,
        selector: compileActionsSelector,
        calldata: innerCalldata,
      },
    ],
  ]);
}

// ============ Proof Facts Computation ============

function computeVirtualOsConfigHash(chainId: string): string {
  return hash.computeHashOnElements([
    STARKNET_OS_CONFIG_HASH_VERSION,
    hexToBigInt(chainId),
    hexToBigInt(STRK_FEE_TOKEN_ADDRESS),
  ]);
}

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
    padHex(hexToBigInt(PROOF_VERSION).toString(16), 32),
    padHex(hexToBigInt(VIRTUAL_SNOS).toString(16), 32),
    VIRTUAL_PROGRAM_HASH,
    padHex(hexToBigInt(VIRTUAL_SNOS0).toString(16), 32),
    padHex(blockNumber.toString(16), 32),
    padHex(hexToBigInt(blockHash).toString(16), 32),
    configHash,
    "0x1",
    padHex(messageHash.toString(16), 32),
  ];
}

// ============ Mock Prover ============

export class MockProver {
  private provider: ProviderInterface;
  private chainId: string;
  private poolAddress: string;

  constructor(rpcUrl: string, chainId: string, poolAddress: string) {
    this.provider = new RpcProvider({ nodeUrl: rpcUrl });
    this.chainId = chainId;
    this.poolAddress = poolAddress;
  }

  /**
   * Compile actions by calling compile_actions directly.
   *
   * compile_actions is a VIEW function on the pool contract (state_mutability: "view"),
   * so it can be called directly via starknet_call without __execute__.
   */
  async compileActions(
    userAddr: string,
    viewingKey: string,
    clientActions: string[][],
    blockIdentifier?: string | number
  ): Promise<CompiledActions> {
    const innerCalldata = buildCompileActionsCalldata(userAddr, viewingKey, clientActions);

    const [result, poolClassHash] = await Promise.all([
      this.provider.callContract(
        {
          contractAddress: this.poolAddress,
          entrypoint: "compile_actions",
          calldata: innerCalldata,
        },
        blockIdentifier
      ),
      this.provider.getClassHashAt(this.poolAddress, blockIdentifier),
    ]);

    return {
      poolClassHash,
      serverActions: result,
    };
  }

  /**
   * Generate mock proof facts.
   * This is the main entry point for the mock prover.
   */
  async generateProof(
    userAddr: string,
    viewingKey: string,
    clientActions: string[][],
    blockIdentifier?: string | number
  ): Promise<ProofFacts> {
    let blockNumber: bigint;
    let blockHash: string;

    if (blockIdentifier) {
      const block = await this.provider.getBlock(blockIdentifier);
      blockNumber = BigInt(block.block_number);
      blockHash = block.block_hash ?? "0x0";
    } else {
      const latestBlock = await this.provider.getBlock("latest");
      const currentBlockNumber = BigInt(latestBlock.block_number);
      const blocksBack = 10n;
      blockNumber = currentBlockNumber > blocksBack ? currentBlockNumber - blocksBack : 1n;
      const baseBlock = await this.provider.getBlock(Number(blockNumber));
      blockHash = baseBlock.block_hash ?? "0x0";
    }

    const { poolClassHash, serverActions } = await this.compileActions(
      userAddr, viewingKey, clientActions, blockIdentifier
    );

    const proofFactsArray = buildProofFacts(
      this.poolAddress, poolClassHash, serverActions,
      blockNumber, blockHash, this.chainId
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
    userAddr: string,
    viewingKey: string,
    clientActions: string[][],
    blockIdentifier?: string | number
  ): Promise<string[]> {
    const latestBlock = await this.provider.getBlock("latest");
    const currentBlockNumber = BigInt(latestBlock.block_number);
    const blocksBack = 10n;
    const blockNumber = currentBlockNumber > blocksBack ? currentBlockNumber - blocksBack : 1n;
    const baseBlock = await this.provider.getBlock(Number(blockNumber));
    const blockHash = baseBlock.block_hash ?? "0x0";

    const { poolClassHash, serverActions } = await this.compileActions(
      userAddr, viewingKey, clientActions, blockIdentifier
    );

    return buildProofFacts(
      this.poolAddress, poolClassHash, serverActions,
      blockNumber, blockHash, this.chainId
    );
  }
}
