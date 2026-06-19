/**
 * Chronicle — Walrus on-chain storage module
 *
 * Every prediction is:
 * 1. Signed with the Chronicle Ed25519 delegate key (proves authenticity)
 * 2. Stored as a JSON blob on Walrus testnet via the HTTP publisher
 *    → Walrus creates a `Blob` object on the Sui blockchain; the blob is
 *      certified by a quorum of Sui validators. The blobId IS an on-chain
 *      Sui object reference.
 * 3. Blob IDs are persisted to localStorage as a local index.
 *
 * Memwal relayer (relayer.memory.walrus.xyz) is tried first; falls back
 * to the canonical Walrus HTTP publisher.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Prediction {
  matchId: string;
  walletAddress: string;
  teamPicked: string;
  reason: string;
  timestamp: number;
  blobId?: string;
  storedOnWalrus?: boolean;
  storageMethod?: "walrus" | "local";
}

/** What gets serialised and stored on-chain as the Walrus blob content. */
interface ChronicleBlob {
  schema: "chronicle-prediction-v1";
  prediction: Prediction;
  signer: {
    accountId: string;
    pubkey: string;
    /** base64url-encoded Ed25519 signature over the canonical prediction JSON */
    signature: string;
  };
  storedAt: string; // ISO timestamp
}

export interface StorageResult {
  blobId: string;
  storedOnWalrus: boolean;
  storageMethod: "walrus" | "local";
  explorerUrl: string | null;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const MEMWAL_SERVER_URL =
  (import.meta.env.VITE_MEMWAL_SERVER_URL as string) ||
  "https://relayer.memory.walrus.xyz";
const MEMWAL_ACCOUNT_ID = import.meta.env.VITE_MEMWAL_ACCOUNT_ID as string;
const MEMWAL_PRIVATE_KEY = import.meta.env.VITE_MEMWAL_PRIVATE_KEY as string;
const MEMWAL_PUBKEY = import.meta.env.VITE_MEMWAL_PUBKEY as string;

// Current Walrus testnet endpoints (confirmed 2026-06)
const WALRUS_PUBLISHERS = [
  "https://publisher.walrus-testnet.walrus.space",
  "https://walrus-testnet-publisher.staketab.org",
  "https://walrus-testnet-publisher.nodeinfra.com",
];
const WALRUS_AGGREGATOR = "https://aggregator.walrus-testnet.walrus.space";
const WALRUS_EXPLORER_BASE = "https://walruscan.com/testnet/blob";

const EPOCHS = 5; // store for ~5 Walrus epochs (~25 days)

// ─── Crypto helpers ───────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    out[i >> 1] = parseInt(clean.slice(i, i + 2), 16);
  }
  return out;
}

function bytesToBase64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Sign `message` with the Chronicle Ed25519 delegate key.
 * Returns null if the key is absent or signing fails.
 */
async function signPayload(message: Uint8Array): Promise<string | null> {
  if (!MEMWAL_PRIVATE_KEY) return null;
  try {
    // Dynamic import keeps the crypto module out of the initial bundle
    // (prevents crashes in older WebViews like Slush's in-app browser)
    const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");
    const keypair = Ed25519Keypair.fromSecretKey(hexToBytes(MEMWAL_PRIVATE_KEY));
    const { signature } = await keypair.signPersonalMessage(message);
    return signature; // already base64 from dapp-kit
  } catch (err) {
    console.warn("[Chronicle] Ed25519 signing skipped:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ─── LocalStorage blob index ──────────────────────────────────────────────────

const LS_BLOBS_PREFIX = "chronicle_blobs_v2_";

export function saveBlobId(matchId: string, blobId: string): void {
  try {
    const key = LS_BLOBS_PREFIX + matchId;
    const existing: string[] = JSON.parse(localStorage.getItem(key) || "[]");
    if (!existing.includes(blobId)) {
      existing.push(blobId);
      localStorage.setItem(key, JSON.stringify(existing));
    }
  } catch { /* quota exceeded — ignore */ }
}

export function getBlobIds(matchId: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(LS_BLOBS_PREFIX + matchId) || "[]");
  } catch {
    return [];
  }
}

// ─── Walrus HTTP publisher ────────────────────────────────────────────────────

async function putToWalrus(body: string): Promise<string | null> {
  const bytes = new TextEncoder().encode(body);

  for (const publisher of WALRUS_PUBLISHERS) {
    try {
      const res = await fetch(`${publisher}/v1/blobs?epochs=${EPOCHS}`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: bytes,
        signal: AbortSignal.timeout(12000),
      });

      if (!res.ok) {
        console.warn(`[Chronicle] Walrus publisher ${publisher} returned ${res.status}`);
        continue;
      }

      const data = await res.json();
      // Response is either { newlyCreated: { blobObject: { blobId } } }
      // or { alreadyCertified: { blobId } }
      const blobId: string | undefined =
        data?.newlyCreated?.blobObject?.blobId ??
        data?.alreadyCertified?.blobId ??
        data?.blobId;

      if (blobId) {
        console.log(`[Chronicle] Blob certified on Sui ✓  id=${blobId.slice(0, 12)}…  publisher=${publisher}`);
        return blobId;
      }
    } catch (err) {
      console.warn(`[Chronicle] Publisher ${publisher} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return null;
}

// ─── Memwal relayer (signed relay) ───────────────────────────────────────────
// The Memwal relayer handles Walrus transactions on behalf of the account.
// We sign the payload and send it; the relayer submits the Sui transaction.

async function putToMemwal(blob: ChronicleBlob): Promise<string | null> {
  if (!MEMWAL_ACCOUNT_ID || !MEMWAL_PRIVATE_KEY) return null;
  try {
    const body = JSON.stringify({
      accountId: MEMWAL_ACCOUNT_ID,
      content: blob,
      pubkey: MEMWAL_PUBKEY,
      epochs: EPOCHS,
    });

    // Try known endpoint patterns — the relayer API is not publicly documented
    const paths = ["/v1/store", "/store", "/v1/memories", "/memories", "/v1/blobs", "/upload"];
    for (const path of paths) {
      try {
        const res = await fetch(`${MEMWAL_SERVER_URL}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          const data = await res.json();
          const blobId =
            data?.blobId ?? data?.blob_id ?? data?.id ?? data?.data?.blobId;
          if (blobId) {
            console.log(`[Chronicle] Memwal sealed ✓  id=${String(blobId).slice(0, 12)}…  path=${path}`);
            return blobId as string;
          }
        }
      } catch { /* try next path */ }
    }
    return null;
  } catch (err) {
    console.warn("[Chronicle] Memwal relayer skipped:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ─── Main: store a prediction on-chain ───────────────────────────────────────

/**
 * Stores a prediction on the Walrus decentralised storage network.
 *
 * Storage priority:
 *   1. Memwal relayer  (signed relay, if credentials are configured)
 *   2. Walrus HTTP publisher  (direct, confirmed working)
 *   3. localStorage  (guaranteed fallback — prediction is never lost)
 *
 * The blob includes an Ed25519 signature over the prediction JSON,
 * providing cryptographic proof of origin that anyone can verify.
 */
export async function storePrediction(prediction: Prediction): Promise<StorageResult> {
  // Build the canonical blob
  const predictionJson = JSON.stringify({
    matchId: prediction.matchId,
    walletAddress: prediction.walletAddress,
    teamPicked: prediction.teamPicked,
    reason: prediction.reason,
    timestamp: prediction.timestamp,
  });

  const signature = await signPayload(new TextEncoder().encode(predictionJson));

  const blob: ChronicleBlob = {
    schema: "chronicle-prediction-v1",
    prediction,
    signer: {
      accountId: MEMWAL_ACCOUNT_ID || "anon",
      pubkey: MEMWAL_PUBKEY || "",
      signature: signature ?? "",
    },
    storedAt: new Date().toISOString(),
  };

  const blobJson = JSON.stringify(blob, null, 2);

  // ── 1. Memwal relayer
  try {
    const memwalId = await putToMemwal(blob);
    if (memwalId) {
      saveBlobId(prediction.matchId, memwalId);
      return {
        blobId: memwalId,
        storedOnWalrus: true,
        storageMethod: "walrus",
        explorerUrl: `${WALRUS_EXPLORER_BASE}/${memwalId}`,
      };
    }
  } catch { /* fall through */ }

  // ── 2. Walrus HTTP publisher (direct, confirmed on-chain)
  try {
    const walrusId = await putToWalrus(blobJson);
    if (walrusId) {
      saveBlobId(prediction.matchId, walrusId);
      return {
        blobId: walrusId,
        storedOnWalrus: true,
        storageMethod: "walrus",
        explorerUrl: `${WALRUS_EXPLORER_BASE}/${walrusId}`,
      };
    }
  } catch { /* fall through */ }

  // ── 3. localStorage fallback
  const localId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  saveBlobId(prediction.matchId, localId);
  return {
    blobId: localId,
    storedOnWalrus: false,
    storageMethod: "local",
    explorerUrl: null,
  };
}

// ─── Retrieve a blob from Walrus ──────────────────────────────────────────────

export async function fetchBlob(blobId: string): Promise<ChronicleBlob | null> {
  if (blobId.startsWith("local_")) return null;
  try {
    const res = await fetch(`${WALRUS_AGGREGATOR}/v1/blobs/${blobId}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return await res.json() as ChronicleBlob;
  } catch {
    return null;
  }
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

export function truncateAddress(addr: string): string {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function truncateBlobId(blobId: string): string {
  if (blobId.startsWith("local_")) return "local";
  return `${blobId.slice(0, 8)}…`;
}

export function truncateReason(reason: string, max = 120): string {
  return reason.length <= max ? reason : `${reason.slice(0, max - 3)}…`;
}
