import { useState, useEffect, useCallback, useRef } from "react";
import {
  Wallet,
  Zap,
  ChevronDown,
  ChevronUp,
  CheckCircle,
  AlertCircle,
  Loader2,
  Globe,
  RefreshCw,
  Radio,
} from "lucide-react";
import {
  FALLBACK_ACTIVE_MATCH,
  FALLBACK_PAST_MATCHES,
  SEED_PREDICTIONS,
  getVoteSplit,
  getCommunityAccuracy,
  mapWorldCupData,
  type ActiveMatch,
  type PastMatch,
} from "@/lib/matchData";
import { storePrediction, truncateAddress, truncateReason, type Prediction } from "@/lib/walrus";
import { generatePostMortem } from "@/lib/gemini";
import { fetchWorldCupData, getCacheAge, clearCache } from "@/lib/scoreUpdate";

const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours

type StorageStatus = "walrus" | "local" | null;
type DataStatus = "idle" | "loading" | "live" | "cached" | "fallback";

interface PastMatchState {
  analysisText: string | null;
  analysisLoading: boolean;
  analysisOpen: boolean;
  analysisError: string | null;
}

const MOCK_WALLET_ADDRESSES = [
  "0x742d35Cc6634C0532925a3b8D4C9E3d1a4b5f2e8",
  "0x9f8e2c1d5b3a7f4c6e8d2b1a3c5e7f9d2b4c6e8",
];

function formatCacheAge(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

export default function Chronicle() {
  // ── Match data state ──────────────────────────────────────────────────────
  const [activeMatch, setActiveMatch] = useState<ActiveMatch>(FALLBACK_ACTIVE_MATCH);
  const [pastMatches, setPastMatches] = useState<PastMatch[]>(FALLBACK_PAST_MATCHES);
  const [dataStatus, setDataStatus] = useState<DataStatus>("idle");
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [dataTimestamp, setDataTimestamp] = useState<string | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Wallet state ─────────────────────────────────────────────────────────
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [walletConnecting, setWalletConnecting] = useState(false);

  // ── Prediction state ─────────────────────────────────────────────────────
  const [selectedTeam, setSelectedTeam] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [storageStatus, setStorageStatus] = useState<StorageStatus>(null);
  const [predictions, setPredictions] = useState<Prediction[]>(SEED_PREDICTIONS);

  // ── Past match analysis state ─────────────────────────────────────────────
  const [pastMatchStates, setPastMatchStates] = useState<Record<string, PastMatchState>>({});

  // Sync pastMatchStates when pastMatches changes
  useEffect(() => {
    setPastMatchStates((prev) => {
      const next: Record<string, PastMatchState> = {};
      for (const m of pastMatches) {
        next[m.id] = prev[m.id] ?? {
          analysisText: null,
          analysisLoading: false,
          analysisOpen: false,
          analysisError: null,
        };
      }
      return next;
    });
  }, [pastMatches]);

  // ── Live data fetch ───────────────────────────────────────────────────────
  const loadLiveData = useCallback(async (force = false) => {
    setDataStatus("loading");
    try {
      const data = await fetchWorldCupData(force);
      if (data) {
        const { activeMatch: am, pastMatches: pm } = mapWorldCupData(data);
        setActiveMatch(am);
        setPastMatches(pm);
        setDataTimestamp(data.timestamp);
        const age = getCacheAge();
        setLastUpdated(age !== null ? formatCacheAge(age) : "just now");
        setDataStatus(force ? "live" : "cached");
        // Reset selection if active match changed
        setSelectedTeam(null);
        setSubmitted(false);
        setStorageStatus(null);
      } else {
        setDataStatus("fallback");
      }
    } catch {
      setDataStatus("fallback");
    }
  }, []);

  // On mount: load data, then schedule next refresh
  useEffect(() => {
    loadLiveData(false);

    const schedule = () => {
      refreshTimerRef.current = setTimeout(() => {
        loadLiveData(true);
        schedule();
      }, REFRESH_INTERVAL_MS);
    };
    schedule();

    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [loadLiveData]);

  // ── Derived state ─────────────────────────────────────────────────────────
  const userVoted = predictions.some(
    (p) => p.matchId === activeMatch.id && p.walletAddress === walletAddress
  );
  const activeSplit = getVoteSplit(activeMatch.id, activeMatch.teamA, predictions);
  const recentActive = predictions
    .filter((p) => p.matchId === activeMatch.id)
    .slice(-10)
    .reverse();

  // ── Wallet ────────────────────────────────────────────────────────────────
  const handleConnectWallet = useCallback(async () => {
    setWalletConnecting(true);
    await new Promise((r) => setTimeout(r, 900));
    const addr = MOCK_WALLET_ADDRESSES[Math.floor(Math.random() * MOCK_WALLET_ADDRESSES.length)];
    setWalletAddress(addr);
    setWalletConnecting(false);
  }, []);

  const handleDisconnect = useCallback(() => {
    setWalletAddress(null);
    setSelectedTeam(null);
    setReason("");
    setSubmitted(false);
    setStorageStatus(null);
  }, []);

  // ── Submit prediction ─────────────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    if (!walletAddress || !selectedTeam || submitting || userVoted) return;
    setSubmitting(true);

    const prediction: Prediction = {
      matchId: activeMatch.id,
      walletAddress,
      teamPicked: selectedTeam,
      reason: truncateReason(reason.trim() || "No reason given"),
      timestamp: Date.now(),
    };

    const { blobId, storedOnWalrus } = await storePrediction(prediction);
    prediction.blobId = blobId;
    prediction.storedOnWalrus = storedOnWalrus;

    setPredictions((prev) => [...prev, prediction]);
    setSubmitting(false);
    setSubmitted(true);
    setStorageStatus(storedOnWalrus ? "walrus" : "local");
  }, [walletAddress, selectedTeam, reason, submitting, userVoted, activeMatch.id]);

  // ── AI analysis ───────────────────────────────────────────────────────────
  const handleToggleAnalysis = useCallback(
    async (matchId: string) => {
      const match = pastMatches.find((m) => m.id === matchId);
      if (!match) return;

      const current = pastMatchStates[matchId];
      if (!current) return;

      if (current.analysisOpen) {
        setPastMatchStates((prev) => ({
          ...prev,
          [matchId]: { ...prev[matchId], analysisOpen: false },
        }));
        return;
      }

      if (current.analysisText) {
        setPastMatchStates((prev) => ({
          ...prev,
          [matchId]: { ...prev[matchId], analysisOpen: true },
        }));
        return;
      }

      setPastMatchStates((prev) => ({
        ...prev,
        [matchId]: { ...prev[matchId], analysisLoading: true, analysisOpen: true, analysisError: null },
      }));

      try {
        const split = getVoteSplit(matchId, match.teamA, predictions);
        const reasons = predictions
          .filter((p) => p.matchId === matchId)
          .map((p) => p.reason)
          .filter(Boolean);

        const text = await generatePostMortem({
          teamA: match.teamA,
          teamB: match.teamB,
          winner: match.winner,
          result: match.result,
          teamAPercent: split.aPercent,
          teamBPercent: split.bPercent,
          reasons,
        });

        setPastMatchStates((prev) => ({
          ...prev,
          [matchId]: { ...prev[matchId], analysisText: text, analysisLoading: false },
        }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Analysis failed";
        setPastMatchStates((prev) => ({
          ...prev,
          [matchId]: { ...prev[matchId], analysisLoading: false, analysisError: msg },
        }));
      }
    },
    [pastMatches, pastMatchStates, predictions]
  );

  // ── Manual refresh ────────────────────────────────────────────────────────
  const handleManualRefresh = useCallback(async () => {
    clearCache();
    await loadLiveData(true);
  }, [loadLiveData]);

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen font-sans" style={{ background: "#0a0e1a" }}>

      {/* HEADER */}
      <header
        className="sticky top-0 z-50 border-b"
        style={{ background: "rgba(10,14,26,0.95)", borderColor: "#1f2937", backdropFilter: "blur(12px)" }}
      >
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight" style={{ color: "#f0b429" }} data-testid="app-title">
              Chronicle
            </h1>
            <p className="text-xs" style={{ color: "#6b7280" }}>
              The World Cup's Living Witness
            </p>
          </div>

          <div className="flex items-center gap-3">
            {/* Data status indicator */}
            <div className="hidden sm:flex items-center gap-2">
              {dataStatus === "loading" && (
                <span className="flex items-center gap-1.5 text-xs" style={{ color: "#6b7280" }}>
                  <Loader2 className="w-3 h-3 animate-spin" /> Fetching...
                </span>
              )}
              {(dataStatus === "live" || dataStatus === "cached") && lastUpdated && (
                <span
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full"
                  style={{ background: "rgba(16,185,129,0.1)", color: "#10b981", border: "1px solid rgba(16,185,129,0.2)" }}
                  title={dataTimestamp ?? undefined}
                  data-testid="data-status-badge"
                >
                  <Radio className="w-3 h-3" />
                  Live · {lastUpdated}
                </span>
              )}
              {dataStatus === "fallback" && (
                <span
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full"
                  style={{ background: "rgba(234,179,8,0.1)", color: "#eab308", border: "1px solid rgba(234,179,8,0.2)" }}
                  data-testid="data-status-fallback"
                >
                  Demo data
                </span>
              )}
              <button
                onClick={handleManualRefresh}
                disabled={dataStatus === "loading"}
                className="p-1.5 rounded-lg transition-all disabled:opacity-40"
                style={{ background: "#111827", border: "1px solid #1f2937", color: "#6b7280" }}
                title="Refresh World Cup data"
                data-testid="button-refresh-data"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${dataStatus === "loading" ? "animate-spin" : ""}`} />
              </button>
            </div>

            {/* Wallet */}
            <div data-testid="wallet-connect-area">
              {walletAddress ? (
                <div className="flex items-center gap-2">
                  <div
                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm"
                    style={{ background: "#111827", border: "1px solid #1f2937" }}
                    data-testid="wallet-address"
                  >
                    <div className="w-2 h-2 rounded-full bg-emerald-400" />
                    <span style={{ color: "#d1d5db" }}>{truncateAddress(walletAddress)}</span>
                  </div>
                  <button
                    onClick={handleDisconnect}
                    className="text-xs px-3 py-1.5 rounded-lg transition-all"
                    style={{ background: "#1f2937", color: "#9ca3af", border: "1px solid #374151" }}
                    data-testid="button-disconnect"
                  >
                    Disconnect
                  </button>
                </div>
              ) : (
                <button
                  onClick={handleConnectWallet}
                  disabled={walletConnecting}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg font-semibold text-sm transition-all disabled:opacity-60"
                  style={{ background: "#f0b429", color: "#0a0e1a" }}
                  data-testid="button-connect-wallet"
                >
                  {walletConnecting ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Wallet className="w-4 h-4" />
                  )}
                  {walletConnecting ? "Connecting..." : "Connect Wallet"}
                </button>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8 space-y-10">

        {/* ACTIVE MATCH */}
        <section data-testid="active-match-section">
          <div className="mb-3 flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${activeMatch.isLive ? "bg-red-400" : "bg-emerald-400"} animate-pulse`} />
            <span className="text-xs font-semibold tracking-widest uppercase" style={{ color: "#6b7280" }}>
              {activeMatch.isLive ? "Live Match" : "Live Prediction"}
            </span>
            {dataStatus === "loading" && (
              <Loader2 className="w-3 h-3 animate-spin" style={{ color: "#4b5563" }} />
            )}
          </div>

          <div className="rounded-2xl p-6 md:p-8" style={{ background: "#111827", border: "1px solid #1f2937" }}>
            {/* Match header */}
            <div className="flex items-center justify-between mb-1">
              <span
                className="text-xs font-semibold px-2.5 py-1 rounded-full"
                style={{ background: "rgba(240,180,41,0.1)", color: "#f0b429", border: "1px solid rgba(240,180,41,0.2)" }}
              >
                {activeMatch.stage}
              </span>
              <span className="text-xs" style={{ color: "#6b7280" }}>
                {activeMatch.isLive && <span className="text-red-400 font-bold mr-1">● LIVE</span>}
                {activeMatch.date}
              </span>
            </div>

            {/* Teams */}
            <div className="flex gap-4 mt-6 mb-6">
              <button
                className={`vote-btn-a flex-1 rounded-xl p-5 text-center cursor-pointer transition-all ${selectedTeam === activeMatch.teamA ? "selected" : ""}`}
                onClick={() => !submitted && !userVoted && setSelectedTeam(activeMatch.teamA)}
                disabled={submitted || userVoted}
                data-testid="button-vote-team-a"
              >
                <div className="text-3xl mb-2">{activeMatch.teamA.split(" ")[0]}</div>
                <div className="font-bold text-sm" style={{ color: "#e5e7eb" }}>
                  {activeMatch.teamA.replace(/^\S+\s/, "")}
                </div>
                <div className="text-xs mt-1 font-semibold" style={{ color: selectedTeam === activeMatch.teamA ? "#f0b429" : "#6b7280" }}>
                  {selectedTeam === activeMatch.teamA ? "✓ Selected" : "Pick to win"}
                </div>
              </button>

              <div className="flex items-center justify-center w-12 shrink-0">
                <span className="font-bold text-lg" style={{ color: "#374151" }}>VS</span>
              </div>

              <button
                className={`vote-btn-b flex-1 rounded-xl p-5 text-center cursor-pointer transition-all ${selectedTeam === activeMatch.teamB ? "selected" : ""}`}
                onClick={() => !submitted && !userVoted && setSelectedTeam(activeMatch.teamB)}
                disabled={submitted || userVoted}
                data-testid="button-vote-team-b"
              >
                <div className="text-3xl mb-2">{activeMatch.teamB.split(" ")[0]}</div>
                <div className="font-bold text-sm" style={{ color: "#e5e7eb" }}>
                  {activeMatch.teamB.replace(/^\S+\s/, "")}
                </div>
                <div className="text-xs mt-1 font-semibold" style={{ color: selectedTeam === activeMatch.teamB ? "#f0b429" : "#6b7280" }}>
                  {selectedTeam === activeMatch.teamB ? "✓ Selected" : "Pick to win"}
                </div>
              </button>
            </div>

            {/* Reason + submit */}
            {!submitted && !userVoted ? (
              <div>
                <div className="mb-4">
                  <label className="block text-sm mb-2" style={{ color: "#9ca3af" }}>
                    Why do you think this?
                  </label>
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value.slice(0, 200))}
                    placeholder="Share your read on this match..."
                    rows={3}
                    maxLength={200}
                    className="w-full rounded-xl px-4 py-3 text-sm resize-none focus:outline-none transition-all"
                    style={{ background: "#0f172a", border: "1px solid #1f2937", color: "#e5e7eb", lineHeight: "1.6" }}
                    onFocus={(e) => (e.target.style.borderColor = "#f0b429")}
                    onBlur={(e) => (e.target.style.borderColor = "#1f2937")}
                    data-testid="input-reason"
                  />
                  <div className="text-right text-xs mt-1" style={{ color: "#4b5563" }}>
                    {reason.length}/200
                  </div>
                </div>
                <button
                  onClick={handleSubmit}
                  disabled={!walletAddress || !selectedTeam || submitting}
                  className="w-full py-3 rounded-xl font-bold text-sm transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ background: "#f0b429", color: "#0a0e1a" }}
                  data-testid="button-submit-prediction"
                >
                  {submitting ? (
                    <span className="flex items-center justify-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" /> Sealing...
                    </span>
                  ) : "Submit Prediction"}
                </button>
                <p className="text-center text-xs mt-2" style={{ color: "#4b5563" }}>
                  {walletAddress ? "Sign with wallet · Identity verified" : "Connect wallet to submit"}
                </p>
              </div>
            ) : (
              <div
                className="rounded-xl p-4 flex items-center gap-3"
                style={{ background: "rgba(240,180,41,0.08)", border: "1px solid rgba(240,180,41,0.2)" }}
                data-testid="prediction-confirmation"
              >
                <CheckCircle className="w-5 h-5 shrink-0" style={{ color: "#f0b429" }} />
                <div>
                  <div className="font-semibold text-sm" style={{ color: "#f0b429" }}>
                    Your prediction is sealed on Chronicle
                  </div>
                  {storageStatus && (
                    <div className="mt-1">
                      {storageStatus === "walrus" ? (
                        <span className="walrus-badge text-xs px-2 py-0.5 rounded-full inline-flex items-center gap-1">
                          <Globe className="w-3 h-3" /> Stored on Walrus
                        </span>
                      ) : (
                        <span className="local-badge text-xs px-2 py-0.5 rounded-full inline-flex items-center gap-1">
                          <Zap className="w-3 h-3" /> Stored locally
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>

        {/* COMMUNITY PULSE */}
        <section data-testid="community-pulse-section">
          <div className="mb-4">
            <h2 className="text-lg font-bold" style={{ color: "#e5e7eb" }}>
              What the crowd believes
            </h2>
            <p className="text-xs mt-0.5" style={{ color: "#6b7280" }}>
              {activeSplit.total} predictions sealed
            </p>
          </div>

          <div className="rounded-2xl p-6 mb-4" style={{ background: "#111827", border: "1px solid #1f2937" }}>
            <div className="flex justify-between text-xs mb-2">
              <span className="font-semibold" style={{ color: "#60a5fa" }}>
                {activeMatch.teamA} — {activeSplit.aPercent}%
              </span>
              <span className="font-semibold" style={{ color: "#f87171" }}>
                {activeSplit.bPercent}% — {activeMatch.teamB}
              </span>
            </div>
            <div className="h-3 rounded-full overflow-hidden" style={{ background: "#1f2937" }} data-testid="community-vote-bar">
              <div
                className="h-full rounded-full animate-bar-fill"
                style={{ width: `${activeSplit.aPercent}%`, background: "linear-gradient(90deg, #3b82f6, #60a5fa)" }}
              />
            </div>
          </div>

          <div className="space-y-2" data-testid="prediction-feed">
            {recentActive.length === 0 ? (
              <div className="rounded-xl p-6 text-center" style={{ background: "#111827", border: "1px solid #1f2937" }}>
                <p className="text-sm" style={{ color: "#4b5563" }}>No predictions yet. Be the first to speak.</p>
              </div>
            ) : (
              recentActive.map((pred, i) => (
                <div
                  key={`${pred.walletAddress}-${pred.timestamp}`}
                  className="prediction-item rounded-xl px-4 py-3 flex items-start gap-3"
                  style={{ background: "#111827", border: "1px solid #1f2937", animationDelay: `${i * 50}ms` }}
                  data-testid={`prediction-item-${i}`}
                >
                  <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-xs font-bold" style={{ background: "#1f2937", color: "#f0b429" }}>
                    {pred.walletAddress.slice(2, 4).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-mono" style={{ color: "#9ca3af" }}>
                        {truncateAddress(pred.walletAddress)}
                      </span>
                      <span className="text-xs px-2 py-0.5 rounded-full font-semibold" style={{ background: "rgba(240,180,41,0.1)", color: "#f0b429" }}>
                        {pred.teamPicked.replace(/^\S+\s/, "")}
                      </span>
                    </div>
                    <p className="text-sm mt-1" style={{ color: "#d1d5db", lineHeight: "1.5" }}>
                      {pred.reason}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        {/* CHRONICLE MEMORY */}
        <section data-testid="chronicle-memory-section">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold" style={{ color: "#e5e7eb" }}>Chronicle Memory</h2>
              <p className="text-xs mt-0.5" style={{ color: "#6b7280" }}>
                Past matches — {pastMatches.length} concluded
                {dataTimestamp && (
                  <span style={{ color: "#374151" }}> · data from {dataTimestamp}</span>
                )}
              </p>
            </div>
          </div>

          {pastMatches.length === 0 ? (
            <div className="rounded-2xl p-8 text-center" style={{ background: "#111827", border: "1px solid #1f2937" }}>
              <p className="text-sm" style={{ color: "#4b5563" }}>No concluded matches yet.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {pastMatches.map((match) => {
                const split = getVoteSplit(match.id, match.teamA, predictions);
                const accuracy = getCommunityAccuracy(match, predictions);
                const state = pastMatchStates[match.id] ?? {
                  analysisText: null,
                  analysisLoading: false,
                  analysisOpen: false,
                  analysisError: null,
                };
                const winnerLabel = match.teamA.includes(match.winner) ? match.teamA : match.teamB;

                return (
                  <div
                    key={match.id}
                    className="rounded-2xl overflow-hidden"
                    style={{ background: "#111827", border: "1px solid #1f2937" }}
                    data-testid={`past-match-${match.id}`}
                  >
                    <div className="p-6">
                      <div className="flex items-start justify-between gap-4 mb-4">
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: "#1f2937", color: "#9ca3af" }}>
                              {match.stage}
                            </span>
                            <span className="text-xs" style={{ color: "#4b5563" }}>{match.date}</span>
                          </div>
                          <div className="font-bold text-base" style={{ color: "#e5e7eb" }}>
                            {match.teamA} <span style={{ color: "#374151" }}>vs</span> {match.teamB}
                          </div>
                          <div className="text-sm mt-1" style={{ color: "#9ca3af" }}>{match.result}</div>
                        </div>

                        {accuracy.wasRight ? (
                          <div className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg" style={{ background: "rgba(16,185,129,0.1)", border: "1px solid rgba(16,185,129,0.2)" }}>
                            <CheckCircle className="w-3.5 h-3.5" style={{ color: "#10b981" }} />
                            <span className="text-xs font-semibold" style={{ color: "#10b981" }}>Crowd RIGHT</span>
                          </div>
                        ) : (
                          <div className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg" style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)" }}>
                            <AlertCircle className="w-3.5 h-3.5" style={{ color: "#ef4444" }} />
                            <span className="text-xs font-semibold" style={{ color: "#ef4444" }}>Crowd WRONG</span>
                          </div>
                        )}
                      </div>

                      <div className="mb-4">
                        <div className="flex justify-between text-xs mb-1.5">
                          <span style={{ color: "#60a5fa" }}>{match.teamA} — {split.aPercent}%</span>
                          <span style={{ color: "#f87171" }}>{split.bPercent}% — {match.teamB}</span>
                        </div>
                        <div className="h-2 rounded-full overflow-hidden" style={{ background: "#1f2937" }}>
                          <div className="h-full rounded-full" style={{ width: `${split.aPercent}%`, background: "linear-gradient(90deg, #3b82f6, #60a5fa)" }} />
                        </div>
                        <p className="text-xs mt-1.5" style={{ color: "#6b7280" }}>
                          {accuracy.wasRight
                            ? `The crowd got this RIGHT — ${accuracy.winnerPercent}% called ${winnerLabel}`
                            : `The crowd got this WRONG — ${accuracy.loserPercent}% predicted the wrong side`}
                        </p>
                      </div>

                      <button
                        onClick={() => handleToggleAnalysis(match.id)}
                        className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all"
                        style={{ background: "rgba(240,180,41,0.08)", border: "1px solid rgba(240,180,41,0.2)", color: "#f0b429" }}
                        data-testid={`button-view-analysis-${match.id}`}
                      >
                        <Zap className="w-3.5 h-3.5" />
                        {state.analysisOpen ? "Hide" : "View"} Chronicle Analysis
                        {state.analysisOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                      </button>
                    </div>

                    {state.analysisOpen && (
                      <div className="analysis-card border-t px-6 py-5" style={{ borderColor: "rgba(240,180,41,0.15)" }} data-testid={`analysis-panel-${match.id}`}>
                        <div className="flex items-center gap-2 mb-3">
                          <Zap className="w-3.5 h-3.5" style={{ color: "#f0b429" }} />
                          <span className="text-xs font-bold tracking-widest uppercase" style={{ color: "#f0b429" }}>Chronicle Analysis</span>
                        </div>
                        {state.analysisLoading && (
                          <div className="flex items-center gap-2 text-sm" style={{ color: "#6b7280" }}>
                            <Loader2 className="w-4 h-4 animate-spin" /> Generating analysis...
                          </div>
                        )}
                        {state.analysisError && (
                          <div className="text-sm" style={{ color: "#ef4444" }}>{state.analysisError}</div>
                        )}
                        {state.analysisText && (
                          <p className="text-sm leading-relaxed" style={{ color: "#d1d5db" }} data-testid={`analysis-text-${match.id}`}>
                            {state.analysisText}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </main>

      {/* FOOTER */}
      <footer className="mt-16 border-t py-6 text-center" style={{ borderColor: "#1f2937" }}>
        <p className="text-xs" style={{ color: "#374151" }}>
          Predictions stored on Walrus • Powered by Chronicle
          {dataStatus === "live" || dataStatus === "cached" ? " • Live data via Gemini Search" : ""}
        </p>
      </footer>
    </div>
  );
}
