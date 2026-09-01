/**
 * Viewing Key Management
 *
 * Generates and manages viewing keys for the privacy pool.
 * Uses grindKey from @scure/starknet for valid Stark field key derivation.
 */

import {
  getPublicKey as scureGetPublicKey,
  sign as scureSign,
  grindKey,
} from "@scure/starknet";
import { hash, shortString, ec } from "starknet";
import type { ViewingKey } from "./types";

// ============ Constants ============

// Privacy pool requires viewing keys in [1, CURVE_ORDER/2]
const CURVE_ORDER = ec.starkCurve.CURVE.n;
const MAX_VIEWING_KEY = CURVE_ORDER / 2n;

// ============ Helpers ============

function bytesToHex(bytes: Uint8Array): string {
  return "0x" + Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Strip 0x prefix and ensure lowercase hex for @scure/starknet */
function stripHexPrefix(hex: string): string {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

// ============ Viewing Key Generation ============

/**
 * Generate a deterministic viewing key from the master private key.
 *
 * Privacy pool requires viewing keys in [1, CURVE_ORDER/2].
 * We use grindKey with rejection sampling until we get a valid key.
 *
 * Derivation: seed = SHA-256("zor-privacy-viewing-key-v1:" || masterKey)
 *             viewingKey = grindKey(seed) if <= MAX_VIEWING_KEY, else re-derive
 */
export async function generateViewingKey(masterPrivateKey: string): Promise<ViewingKey> {
  const masterHex = stripHexPrefix(masterPrivateKey);

  // Deterministic seed: SHA-256(domain || masterKey)
  const seedInput = new TextEncoder().encode(`zor-privacy-viewing-key-v1:${masterHex}`);
  const seedHashBuffer = await crypto.subtle.digest("SHA-256", seedInput);
  const seedHash = new Uint8Array(seedHashBuffer);
  const seedHex = bytesToHex(seedHash);

  // Rejection sampling: generate keys until we get one in [1, MAX_VIEWING_KEY]
  let attempt = 0;
  let viewingKeyHex: string;
  let viewingKeyBigInt: bigint;

  do {
    const attemptSeed = stripHexPrefix(seedHex) + attempt.toString(16).padStart(2, "0");
    viewingKeyHex = grindKey(attemptSeed);
    viewingKeyBigInt = BigInt("0x" + viewingKeyHex);
    attempt++;
  } while (viewingKeyBigInt > MAX_VIEWING_KEY || viewingKeyBigInt === 0n);

  // Derive public key
  const pubKeyBytes = scureGetPublicKey(viewingKeyHex, true);
  const pubKeyX = bytesToHex(pubKeyBytes.slice(1, 33));

  return {
    privateKey: "0x" + viewingKeyHex,
    publicKey: pubKeyX,
  };
}

/**
 * Derive viewing key from master private key (sync version).
 * Uses the same rejection sampling to ensure key is in [1, MAX_VIEWING_KEY].
 */
export function deriveViewingKeySync(masterPrivateKey: string): ViewingKey {
  const masterHex = stripHexPrefix(masterPrivateKey);

  // Deterministic seed via simple hash (FNV-1a like, 256-bit)
  const seedStr = `zor-privacy-viewing-key-v1:${masterHex}`;
  let h1 = 0xcbf29ce484222325n, h2 = 0x517cc1b727220a95n;
  for (let i = 0; i < seedStr.length; i++) {
    const c = BigInt(seedStr.charCodeAt(i));
    h1 = ((h1 ^ c) * 0x100000001b3n) & ((1n << 64n) - 1n);
    h2 = ((h2 ^ c) * 0x100000001b3n) & ((1n << 64n) - 1n);
  }
  const baseSeed = (h1 << 64n | h2).toString(16).padStart(32, "0");

  // Rejection sampling: generate keys until we get one in [1, MAX_VIEWING_KEY]
  let attempt = 0;
  let viewingKeyHex: string;
  let viewingKeyBigInt: bigint;

  do {
    const attemptSeed = baseSeed + attempt.toString(16).padStart(2, "0");
    viewingKeyHex = grindKey(attemptSeed);
    viewingKeyBigInt = BigInt("0x" + viewingKeyHex);
    attempt++;
  } while (viewingKeyBigInt > MAX_VIEWING_KEY || viewingKeyBigInt === 0n);

  const pubKeyBytes = scureGetPublicKey(viewingKeyHex, true);
  const pubKeyX = bytesToHex(pubKeyBytes.slice(1, 33));

  return {
    privateKey: "0x" + viewingKeyHex,
    publicKey: pubKeyX,
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
  const keyHex = stripHexPrefix(viewingKey);
  const msgHex = stripHexPrefix(messageHash);
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

function hexToBigInt(hex: string): bigint {
  const h = stripHexPrefix(hex);
  return h === "" ? 0n : BigInt("0x" + h);
}
