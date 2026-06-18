import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

export interface Prediction {
  matchId: string;
  walletAddress: string;
  teamPicked: string;
  reason: string;
  timestamp: number;
  blobId?: string;
  storedOnWalrus?: boolean;
  storageMethod?: "memwal" | "walrus" | "local";
}

// ─── Config ──────────────────────────────────────────────────────────────────

const WALRUS_PUBLISHER = "https://publisher.walrus-testnet.walrus.space";
const WALRUS_AGGREGATOR = "https://aggregator.walrus-testnet.walrus.space";

const MEMWAL_SERVER_URL =
  (import.meta.env.VITE_MEMWAL_SERVER_URL as string) ||
  "https://relayer.memory.walrus.xyz";
const MEMWAL_ACCOUNT_ID = import.meta.env.VITE_MEMWAL_ACCOUNT_ID as string;
const MEMWAL_PRIVATE_KEY = import.meta.env.VITE_MEMWAL_PRIVATE_KEY as string;
const MEMWAL_PUBKEY = import.meta.env.VITE_MEMWAL_PUBKEY as string;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function saveBlobId(matchId: string, blobId: string) {
  const key = `chronicle_blobs_${matchId}`;
  const existing: string[] = JSON.parse(localStorage.getItem(key) || "[]");
  if (!existing.includes(blobId)) {
    existing.push(blobId);
    localStorage.setItem(key, JSON.stringify(existing));
  }
}

export function getBlobIds(matchId: string): string[] {
  return JSON.parse(localStorage.getItem(`chronicle_blobs_${matchId}`) || "[]");
}

// ─── Method 1: Memwal relayer (delegated signing) ─────────────────────────────

async function storeOnMemwal(
  prediction: Prediction
): Promise<string | null> {
  if (!MEMWAL_PRIVATE_KEY || !MEMWAL_ACCOUNT_ID) return null;

  try {
    const keypair = Ed25519Keypair.fromSecretKey(hexToBytes(MEMWAL_PRIVATE_KEY));
    const payload = JSON.stringify(prediction);
    const msgBytes = new TextEncoder().encode(payload);
    const { signature } = await keypair.signPersonalMessage(msgBytes);

    // Try the most likely Memwal endpoint patterns
    const body = JSON.stringify({
      accountId: MEMWAL_ACCOUNT_ID,
      data: prediction,
      payload,
      signature,
      pubkey: MEMWAL_PUBKEY,
      epochs: 5,
    });

    // Try primary endpoint
    for (const path of ["/store", "/v1/store", "/api/store", "/memories"]) {
      try {
        const res = await fetch(`${MEMWAL_SERVER_URL}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        if (res.ok) {
          const data = await res.json();
          const blobId =
            data?.blobId ?? data?.blob_id ?? data?.id ?? data?.data?.blobId ?? null;
          if (blobId) {
            console.log(`[Chronicle] Stored on Memwal. blobId: ${blobId}`);
            return blobId;
          }
        }
      } catch {
        // try next path
      }
    }
    return null;
  } catch (err) {
    console.warn("[Chronicle] Memwal storage failed:", err);
    return null;
  }
}

// ─── Method 2: Direct Walrus publisher ───────────────────────────────────────

async function storeOnWalrus(prediction: Prediction): Promise<string | null> {
  try {
    const res = await fetch(
      `${WALRUS_PUBLISHER}/v1/store?epochs=5`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(prediction),
      }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const blobId =
      data?.newlyCreated?.blobObject?.blobId ??
      data?.alreadyCertified?.blobId ??
      data?.blobId ??
      null;
    if (blobId) {
      console.log(`[Chronicle] Stored on Walrus. blobId: ${blobId}`);
      return blobId;
    }
    return null;
  } catch (err) {
    console.warn("[Chronicle] Walrus publisher failed:", err);
    return null;
  }
}

// ─── Main store function (tries all methods in priority order) ────────────────

export async function storePrediction(
  prediction: Prediction
): Promise<{ blobId: string; storedOnWalrus: boolean; storageMethod: string }> {
  // 1. Try Memwal (delegated signing, most decentralised)
  const memwalId = await storeOnMemwal(prediction);
  if (memwalId) {
    saveBlobId(prediction.matchId, memwalId);
    return { blobId: memwalId, storedOnWalrus: true, storageMethod: "memwal" };
  }

  // 2. Try direct Walrus publisher
  const walrusId = await storeOnWalrus(prediction);
  if (walrusId) {
    saveBlobId(prediction.matchId, walrusId);
    return { blobId: walrusId, storedOnWalrus: true, storageMethod: "walrus" };
  }

  // 3. Local fallback
  const localId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  saveBlobId(prediction.matchId, localId);
  return { blobId: localId, storedOnWalrus: false, storageMethod: "local" };
}

// ─── Retrieve blobs ───────────────────────────────────────────────────────────

export async function fetchPrediction(blobId: string): Promise<Prediction | null> {
  if (blobId.startsWith("local_")) return null;
  try {
    const res = await fetch(`${WALRUS_AGGREGATOR}/v1/${blobId}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ─── Formatters ───────────────────────────────────────────────────────────────

export function truncateAddress(addr: string): string {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function truncateReason(reason: string, max = 100): string {
  return reason.length <= max ? reason : reason.slice(0, max - 3) + "...";
}
