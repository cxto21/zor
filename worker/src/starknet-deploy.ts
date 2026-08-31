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
  encodeShortString,
  typedData,
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

  // Compute tx hash using starknet.js v3 hash computation
  const compiledConstructorCalldata = calldata.map(v => bigIntToHex(v));
  const txHash = hash.calculateDeployAccountTransactionHash({
    contractAddress: bigIntToHex(accountAddress),
    classHash,
    compiledConstructorCalldata,
    salt: bigIntToHex(salt),
    version: encodeShortString("0x3"),
    chainId,
    nonce,
    nonceDataAvailabilityMode: 0,
    feeDataAvailabilityMode: 0,
    resourceBounds: {
      l1_gas: { max_amount: "0x0", max_price_per_unit: "0x0" },
      l2_gas: { max_amount: "0x186a0", max_price_per_unit: "0x2386f26fc10000" },
      l1_data_gas: { max_amount: "0x200", max_price_per_unit: "0x2386f26fc10000" },
    },
    tip: "0x0",
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
      sender_address: padHex(bigIntToHex(accountAddress), 32),
      calldata: calldata.map(v => padHex(bigIntToHex(v), 32)),
      nonce,
      resource_bounds: {
        l1_gas: { max_amount: "0x0", max_price_per_unit: "0x0" },
        l2_gas: { max_amount: "0x186a0", max_price_per_unit: "0x2386f26fc10000" },
        l1_data_gas: { max_amount: "0x200", max_price_per_unit: "0x2386f26fc10000" },
      },
      tip: "0x0",
      paymaster_data: [],
      account_deployment_data: [],
      nonce_data_availability_mode: "L1",
      fee_data_availability_mode: "L1",
    },
    accountAddress: padHex(bigIntToHex(accountAddress), 32),
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

  const resourceBounds = {
    l1_gas: { max_amount: "0x0", max_price_per_unit: "0x0" },
    l2_gas: { max_amount: "0x186a0", max_price_per_unit: "0x2386f26fc10000" },
    l1_data_gas: { max_amount: "0x200", max_price_per_unit: "0x2386f26fc10000" },
  };

  // Compute tx hash using starknet.js v3 hash computation
  const txHash = hash.calculateInvokeTransactionHash({
    senderAddress,
    version: encodeShortString("0x3"),
    compiledCalldata: calldata,
    chainId,
    nonce,
    accountDeploymentData: [],
    nonceDataAvailabilityMode: 0,
    feeDataAvailabilityMode: 0,
    resourceBounds,
    tip: "0x0",
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
      sender_address: senderAddress,
      calldata: calldata.map(v => padHex(v, 32)),
      nonce,
      resource_bounds: {
        l1_gas: { max_amount: "0x0", max_price_per_unit: "0x0" },
        l2_gas: { max_amount: "0x186a0", max_price_per_unit: "0x2386f26fc10000" },
        l1_data_gas: { max_amount: "0x200", max_price_per_unit: "0x2386f26fc10000" },
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
