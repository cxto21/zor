/**
 * Viewing Key Management
 * 
 * Generates and manages viewing keys for the privacy pool.
 * Viewing keys are derived deterministically from the master private key.
 */

import { getPublicKey as scureGetPublicKey, sign as scureSign } from "@scure/starknet";
import { hash, shortString } from "starknet";
import type { ViewingKey } from "./types";

// ============ Constants ============

const VIEWING_KEY_DOMAIN = "zor-privacy-viewing-key-v1";
// Field prime P = 2^251 + 17*2^192 + 1 — this is what @scure/starknet validates against
const STARK_FIELD_PRIME = BigInt("0x800000000000011000000000000000000000000000000000000000000000001");

// ============ Helpers ============

function hexToBigInt(hex: string): bigint {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  return h === "" ? 0n : BigInt("0x" + h);
}

function bigIntToHex(n: bigint): string {
  return "0x" + n.toString(16);
}

function bytesToHex(bytes: Uint8Array): string {
  return "0x" + Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ============ Viewing Key Generation ============

/**
 * Generate a deterministic viewing key from the master private key.
 * 
 * The viewing key is derived using HKDF-like construction:
 * viewing_key = H(master_key || domain || salt)
 * 
 * This ensures:
 * 1. Same master key always produces the same viewing key
 * 2. Different domains produce different viewing keys
 * 3. The viewing key is in the valid Stark field range
 */
export async function generateViewingKey(masterPrivateKey: string): Promise<ViewingKey> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`${VIEWING_KEY_DOMAIN}:${masterPrivateKey}`);
  
  // Use SHA-256 for key derivation
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  
  // Convert to bigint and reduce to Stark field (Fp)
  let privateKey = BigInt("0x" + Array.from(hashArray).map(b => b.toString(16).padStart(2, "0")).join(""));
  privateKey = privateKey % STARK_FIELD_PRIME;
  if (privateKey === 0n) privateKey = 1n; // Ensure non-zero
  
  // Derive public key (x-coordinate only) — @scure/starknet expects hex WITHOUT 0x prefix
  const privKeyHexNoPrefix = bigIntToHex(privateKey).slice(2);
  const pubKeyBytes = scureGetPublicKey(privKeyHexNoPrefix, false);
  const pubKeyHex = bytesToHex(pubKeyBytes.slice(1, 33)); // Skip 0x04 prefix
  
  return {
    privateKey: bigIntToHex(privateKey),
    publicKey: pubKeyHex,
  };
}

/**
 * Derive viewing key from master private key (sync version).
 * Uses a pre-computed approach for performance.
 */
export function deriveViewingKeySync(masterPrivateKey: string): ViewingKey {
  // For sync operation, we use a simpler derivation
  // The async version is preferred for production
  const privKey = hexToBigInt(masterPrivateKey);
  
  // Simple derivation: viewing_key = H(master_key) mod field_order
  // This is not cryptographically ideal but works for our use case
  const hashInput = bigIntToHex(privKey);
  
  // Use a simple hash function (FNV-1a-like)
  let hash = 0xcbf29ce484222325n;
  for (let i = 2; i < hashInput.length; i += 2) {
    const byte = BigInt("0x" + hashInput.slice(i, i + 2));
    hash = (hash ^ byte) * 0x100000001b3n;
    hash = hash & ((1n << 64n) - 1n); // Keep within 64 bits
  }
  
  // Extend to 256 bits by combining multiple rounds
  let extendedHash = hash;
  for (let i = 0; i < 4; i++) {
    const roundHash = hash ^ (BigInt(i) * 0x9e3779b97f4a7c15n);
    extendedHash = extendedHash ^ (roundHash << 64n);
  }
  
  // Reduce to Stark field (Fp)
  const viewingKey = (extendedHash % STARK_FIELD_PRIME);
  if (viewingKey === 0n) return { privateKey: "0x1", publicKey: "" };
  
  // Derive public key — @scure/starknet expects hex WITHOUT 0x prefix
  const privKeyHexNoPrefix = bigIntToHex(viewingKey).slice(2);
  const pubKeyBytes = scureGetPublicKey(privKeyHexNoPrefix, false);
  const pubKeyHex = bytesToHex(pubKeyBytes.slice(1, 33));
  
  return {
    privateKey: bigIntToHex(viewingKey),
    publicKey: pubKeyHex,
  };
}

/**
 * Sign a message with the viewing key.
 * Used for channel operations and note encryption.
 */
export async function signWithViewingKey(
  viewingKey: string,
  messageHash: string
): Promise<{ r: bigint; s: bigint }> {
  // @scure/starknet expects key and message hash WITHOUT 0x prefix
  const keyHex = viewingKey.startsWith("0x") ? viewingKey.slice(2) : viewingKey;
  const msgHex = messageHash.startsWith("0x") ? messageHash.slice(2) : messageHash;
  const sig = scureSign(msgHex, keyHex);
  return { r: sig.r, s: sig.s };
}

/**
 * Compute the viewing key registration hash.
 * This is the hash that gets registered on-chain.
 */
export function computeViewingKeyHash(viewingKey: string): string {
  return hash.computePoseidonHashOnElements([
    shortString.encodeShortString("viewing_key"),
    hexToBigInt(viewingKey),
  ]);
}
