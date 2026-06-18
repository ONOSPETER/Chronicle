export interface Prediction {
  matchId: string;
  walletAddress: string;
  teamPicked: string;
  reason: string;
  timestamp: number;
  blobId?: string;
  storedOnWalrus?: boolean;
}

const WALRUS_PUBLISHER = "https://publisher.walrus-testnet.walrus.space";
const WALRUS_AGGREGATOR = "https://aggregator.walrus-testnet.walrus.space";

export async function storePrediction(prediction: Prediction): Promise<{ blobId: string; storedOnWalrus: boolean }> {
  try {
    const response = await fetch(`${WALRUS_PUBLISHER}/v1/store?epochs=5`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(prediction),
    });

    if (!response.ok) throw new Error("Walrus store failed");

    const data = await response.json();
    const blobId =
      data?.newlyCreated?.blobObject?.blobId ||
      data?.alreadyCertified?.blobId ||
      data?.blobId ||
      null;

    if (!blobId) throw new Error("No blobId returned");

    saveBlobIdLocally(prediction.matchId, blobId);
    return { blobId, storedOnWalrus: true };
  } catch {
    const localId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    saveBlobIdLocally(prediction.matchId, localId);
    return { blobId: localId, storedOnWalrus: false };
  }
}

export async function fetchPrediction(blobId: string): Promise<Prediction | null> {
  if (blobId.startsWith("local_")) return null;
  try {
    const response = await fetch(`${WALRUS_AGGREGATOR}/v1/${blobId}`);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function saveBlobIdLocally(matchId: string, blobId: string) {
  const key = `chronicle_blobs_${matchId}`;
  const existing = JSON.parse(localStorage.getItem(key) || "[]");
  if (!existing.includes(blobId)) {
    existing.push(blobId);
    localStorage.setItem(key, JSON.stringify(existing));
  }
}

export function getBlobIdsForMatch(matchId: string): string[] {
  const key = `chronicle_blobs_${matchId}`;
  return JSON.parse(localStorage.getItem(key) || "[]");
}

export function truncateAddress(address: string): string {
  if (!address || address.length < 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function truncateReason(reason: string, maxLen = 100): string {
  if (reason.length <= maxLen) return reason;
  return reason.slice(0, maxLen - 3) + "...";
}
