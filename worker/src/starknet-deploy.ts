/**
 * Starknet Deploy — Uses starknet.js for v3 hash computation + @scure/starknet for signing
 */

import {
  sign as starkSign,
  getPublicKey as scureGetPublicKey,
  pedersen as scurePedersen,
  computeHashOnElements,
} from "@scure/starknet";
import {
  hash,
} from "starknet";

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

function bytesToHex(bytes: Uint8Array): string {
  return "0x" + Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ============ Pedersen Hash (chain) ============

function pedersenHash(a: bigint, b: bigint): bigint {
  return hexToBigInt(scurePedersen(bigIntToHex(a), bigIntToHex(b)));
}

// ============ Key Derivation ============

async function deriveUserPrivKey(walletAddress: string): Promise<bigint> {
  const encoder = new TextEncoder();
  const data = encoder.encode(walletAddress + "zor-proxy-account-salt-2024");
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  let privKey = BigInt("0x" + Array.from(hashArray).map(b => b.toString(16).padStart(2, "0")).join(""));

  // Reduce to valid Stark range [1, N-1]
  const STARK_ORDER = BigInt("0x800000000000010FFFFFFFFFFFFFFFFB781126DCAF7B47C2D58786687B5664D16D0210");
  privKey = privKey % (STARK_ORDER - 1n) + 1n;

  return privKey;
}

function privateKeyToPublicKey(privKey: bigint): bigint {
  const pubKeyBytes = scureGetPublicKey(bigIntToHex(privKey), false);
  // Public key is the x-coordinate (first 32 bytes of uncompressed point)
  const pubKeyHex = bytesToHex(pubKeyBytes.slice(1, 33)); // skip 0x04 prefix
  return hexToBigInt(pubKeyHex);
}

// ============ Account Address ============

function computeAccountAddress(pubKey: bigint, classHash: bigint, salt: bigint, deployer: bigint): bigint {
  const innerHash = pedersenHash(classHash, salt);
  return deployer + pedersenHash(innerHash, pubKey);
}

// ============ Deploy Transaction ============

async function buildDeployTx(params: {
  privKey: bigint;
  classHash: string;
  deployerAddress: string;
  maxFee: string;
  nonce: string;
  chainId: string;
}): Promise<{ tx: any; accountAddress: string }> {
  const { privKey, classHash, deployerAddress, maxFee, nonce, chainId } = params;

  const classHashBigInt = hexToBigInt(classHash);
  const deployerBigInt = hexToBigInt(deployerAddress);
  const salt = privKey;

  const pubKey = privateKeyToPublicKey(privKey);
  const accountAddress = computeAccountAddress(pubKey, classHashBigInt, salt, deployerBigInt);

  const calldata = [classHashBigInt, salt, pubKey];

  const paddedAddress = padHex(bigIntToHex(accountAddress), 32);
  const paddedSalt = padHex(bigIntToHex(salt), 32);
  const paddedConstructorCalldata = calldata.map(v => padHex(bigIntToHex(v), 32));

  // Compute tx hash using starknet.js v3 hash computation
  const txHash = hash.calculateDeployAccountTransactionHash({
    contractAddress: paddedAddress,
    classHash,
    compiledConstructorCalldata: paddedConstructorCalldata,
    salt: paddedSalt,
    version: "0x3",
    chainId,
    nonce,
    nonceDataAvailabilityMode: 0n,
    feeDataAvailabilityMode: 0n,
    resourceBounds: {
      l1_gas: { max_amount: BigInt("0x2000"), max_price_per_unit: BigInt("0x71afd498d0000") },
      l2_gas: { max_amount: BigInt("0x120000"), max_price_per_unit: BigInt("0x174876e800") },
      l1_data_gas: { max_amount: BigInt("0x800"), max_price_per_unit: BigInt("0xe8d4a51000") },
    },
    tip: 0n,
    paymasterData: [],
  });

  // Sign with the NEW account's private key
  const sig = starkSign(txHash, bigIntToHex(privKey));
  const r = padHex(bigIntToHex(sig.r), 32);
  const s = padHex(bigIntToHex(sig.s), 32);

  return {
    tx: {
      type: "DEPLOY_ACCOUNT",
      version: "0x3",
      signature: [r, s],
      sender_address: paddedAddress,
      calldata: paddedConstructorCalldata,
      nonce,
      resource_bounds: {
        l1_gas: { max_amount: "0x2000", max_price_per_unit: "0x71afd498d0000" },
        l2_gas: { max_amount: "0x120000", max_price_per_unit: "0x174876e800" },
        l1_data_gas: { max_amount: "0x800", max_price_per_unit: "0xe8d4a51000" },
      },
      tip: "0x0",
      paymaster_data: [],
      account_deployment_data: [],
      nonce_data_availability_mode: "L1",
      fee_data_availability_mode: "L1",
    },
    accountAddress: paddedAddress,
  };
}

// ============ Invoke Transaction (for funding) ============

async function buildInvokeTx(params: {
  privKey: bigint;
  senderAddress: string;
  calldata: string[];
  nonce: string;
  maxFee: string;
  chainId: string;
}): Promise<{ tx: any }> {
  const { privKey, senderAddress, calldata, nonce, maxFee, chainId } = params;

  const paddedSender = padHex(senderAddress, 32);
  const paddedCalldata = calldata.map(v => padHex(v, 32));

  const resourceBounds = {
    l1_gas: { max_amount: BigInt("0x2000"), max_price_per_unit: BigInt("0x71afd498d0000") },
    l2_gas: { max_amount: BigInt("0x120000"), max_price_per_unit: BigInt("0x174876e800") },
    l1_data_gas: { max_amount: BigInt("0x800"), max_price_per_unit: BigInt("0xe8d4a51000") },
  };

  // Compute tx hash using starknet.js v3 hash computation
  const txHash = hash.calculateInvokeTransactionHash({
    senderAddress: paddedSender,
    version: "0x3",
    compiledCalldata: paddedCalldata,
    chainId,
    nonce,
    accountDeploymentData: [],
    nonceDataAvailabilityMode: 0n,
    feeDataAvailabilityMode: 0n,
    resourceBounds,
    tip: 0n,
    paymasterData: [],
  });

  const sig = starkSign(txHash, bigIntToHex(privKey));
  const r = padHex(bigIntToHex(sig.r), 32);
  const s = padHex(bigIntToHex(sig.s), 32);

  return {
    tx: {
      type: "INVOKE",
      version: "0x3",
      signature: [r, s],
      sender_address: paddedSender,
      calldata: paddedCalldata,
      nonce,
      resource_bounds: {
        l1_gas: { max_amount: "0x2000", max_price_per_unit: "0x71afd498d0000" },
        l2_gas: { max_amount: "0x120000", max_price_per_unit: "0x174876e800" },
        l1_data_gas: { max_amount: "0x800", max_price_per_unit: "0xe8d4a51000" },
      },
      tip: "0x0",
      paymaster_data: [],
      account_deployment_data: [],
      nonce_data_availability_mode: "L1",
      fee_data_availability_mode: "L1",
    },
  };
}

export {
  hexToBigInt,
  bigIntToHex,
  padHex,
  deriveUserPrivKey,
  privateKeyToPublicKey,
  computeAccountAddress,
  pedersenHash,
  buildDeployTx,
  buildInvokeTx,
};
