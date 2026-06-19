// Ed25519Keypair is loaded lazily (dynamic import) so a crypto/polyfill
// failure in some browsers doesn't crash the entire module at load time.

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

// ─── Config (values injected by vite.config.ts define) ───────────────────────

const WALRUS_PUBLISHER = "https://publisher.walrus-testnet.walrus.space";
const WALRUS_AGGREGATOR = "https://aggregator.walrus-testnet.walrus.space";

const MEMWAL_SERVER_URL = (import.meta.env.VITE_MEMWAL_SERVER_URL as string) || "https://relayer.memory.walrus.xyz";
const MEMWAL_ACCOUNT_ID = import.meta.env.VITE_MEMWAL_ACCOUNT_ID as string;
const MEMWAL_PRIVATE_KEY = import.meta.env.VITE_MEMWAL_PRIVATE_KEY as string;
const MEMWAL_PUBKEY = import.meta.env.VITE_MEMWAL_PUBKEY as string;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.slice(i, i + 2), 16);
  }
  return bytes;
}

function saveBlobId(matchId: string, blobId: string) {
  try {
    const key = `chronicle_blobs_${matchId}`;
    const existing: string[] = JSON.parse(localStorage.getItem(key) || "[]");
    if (!existing.includes(blobId)) {
      existing.push(blobId);
      localStorage.setItem(key, JSON.stringify(existing));
    }
  } catch {
    // Ignore localStorage quota errors
  }
}

export function getBlobIds(matchId: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(`chronicle_blobs_${matchId}`) || "[]");
  } catch {
    return [];
  }
}

// ─── Method 1: Memwal relayer (Ed25519 delegated signing) ─────────────────────

async function storeOnMemwal(prediction: Prediction): Promise<string | null> {
  if (!MEMWAL_PRIVATE_KEY || !MEMWAL_ACCOUNT_ID) return null;

  try {
    // Dynamic import prevents crypto init errors from crashing the whole module
    const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");
    const keypair = Ed25519Keypair.fromSecretKey(hexToBytes(MEMWAL_PRIVATE_KEY));

    const payload = JSON.stringify(prediction);
    const msgBytes = new TextEncoder().encode(payload);
    const { signature } = await keypair.signPersonalMessage(msgBytes);

    const body = JSON.stringify({
      accountId: MEMWAL_ACCOUNT_ID,
      data: prediction,
      payload,
      signature,
      pubkey: MEMWAL_PUBKEY,
      epochs: 5,
    });

    // Try common Memwal endpoint patterns
    for (const path of ["/store", "/v1/store", "/api/store", "/memories"]) {
      try {
        const res = await fetch(`${MEMWAL_SERVER_URL}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          const data = await res.json();
          const blobId = data?.blobId ?? data?.blob_id ?? data?.id ?? data?.data?.blobId ?? null;
          if (blobId) {
            console.log(`[Chronicle] Memwal sealed. blobId: ${blobId}`);
            return blobId;
          }
        }
      } catch {
        // Try next endpoint path
      }
    }
    return null;
  } catch (err) {
    console.warn("[Chronicle] Memwal storage skipped:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ─── Method 2: Direct Walrus publisher ───────────────────────────────────────

async function storeOnWalrus(prediction: Prediction): Promise<string | null> {
  try {
    const res = await fetch(`${WALRUS_PUBLISHER}/v1/store?epochs=5`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(prediction),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const blobId =
      data?.newlyCreated?.blobObject?.blobId ??
      data?.alreadyCertified?.blobId ??
      data?.blobId ??
      null;
    if (blobId) {
      console.log(`[Chronicle] Walrus sealed. blobId: ${blobId}`);
      return blobId;
    }
    return null;
  } catch (err) {
    console.warn("[Chronicle] Walrus publisher skipped:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ─── Main store function ──────────────────────────────────────────────────────

export async function storePrediction(
  prediction: Prediction
): Promise<{ blobId: string; storedOnWalrus: boolean; storageMethod: string }> {
  try {
    // 1. Memwal (preferred — delegated signing)
    const memwalId = await storeOnMemwal(prediction);
    if (memwalId) {
      saveBlobId(prediction.matchId, memwalId);
      return { blobId: memwalId, storedOnWalrus: true, storageMethod: "memwal" };
    }

    // 2. Direct Walrus publisher
    const walrusId = await storeOnWalrus(prediction);
    if (walrusId) {
      saveBlobId(prediction.matchId, walrusId);
      return { blobId: walrusId, storedOnWalrus: true, storageMethod: "walrus" };
    }
  } catch (err) {
    console.warn("[Chronicle] All remote storage failed:", err instanceof Error ? err.message : err);
  }

  // 3. Local fallback
  const localId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  saveBlobId(prediction.matchId, localId);
  return { blobId: localId, storedOnWalrus: false, storageMethod: "local" };
}

// ─── Retrieve blob ────────────────────────────────────────────────────────────

export async function fetchPrediction(blobId: string): Promise<Prediction | null> {
  if (blobId.startsWith("local_")) return null;
  try {
    const res = await fetch(`${WALRUS_AGGREGATOR}/v1/${blobId}`, {
      signal: AbortSignal.timeout(8000),
    });
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

export function truncateReason(reason: string, max = 120): string {
  return reason.length <= max ? reason : reason.slice(0, max - 3) + "...";
}
