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
  CalendarCheck,
  Clock,
} from "lucide-react";
import {
  FALLBACK_ACTIVE_MATCHES,
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
import {
  fetchWorldCupData,
  getCacheAge,
  clearCache,
  hasDailyCheck,
  getDailyCheckDate,
} from "@/lib/scoreUpdate";

// Refresh once per day (24 hrs)
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

type DataStatus = "idle" | "loading" | "live" | "cached" | "fallback";

interface MatchVoteState {
  selectedTeam: string | null;
  reason: string;
  submitting: boolean;
  submitted: boolean;
  storageStatus: "walrus" | "local" | null;
}

interface PastMatchAnalysis {
  text: string | null;
  loading: boolean;
  open: boolean;
  error: string | null;
}

const MOCK_WALLETS = [
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

function defaultVoteState(): MatchVoteState {
  return { selectedTeam: null, reason: "", submitting: false, submitted: false, storageStatus: null };
}

export default function Chronicle() {
  // ── Data state ────────────────────────────────────────────────────────────
  const [activeMatches, setActiveMatches] = useState<ActiveMatch[]>(FALLBACK_ACTIVE_MATCHES);
  const [pastMatches, setPastMatches] = useState<PastMatch[]>(FALLBACK_PAST_MATCHES);
  const [dataStatus, setDataStatus] = useState<DataStatus>("idle");
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [checkedDate, setCheckedDate] = useState<string | null>(getDailyCheckDate());
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Wallet ────────────────────────────────────────────────────────────────
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [walletConnecting, setWalletConnecting] = useState(false);

  // ── Per-match vote state ──────────────────────────────────────────────────
  const [voteStates, setVoteStates] = useState<Record<string, MatchVoteState>>({});

  // ── All predictions ───────────────────────────────────────────────────────
  const [predictions, setPredictions] = useState<Prediction[]>(SEED_PREDICTIONS);

  // ── Selected match for community pulse ───────────────────────────────────
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null);

  // ── Past match analysis ───────────────────────────────────────────────────
  const [analyses, setAnalyses] = useState<Record<string, PastMatchAnalysis>>({});

  // Sync voteStates & analyses when match lists change
  useEffect(() => {
    setVoteStates((prev) => {
      const next: Record<string, MatchVoteState> = {};
      for (const m of activeMatches) next[m.id] = prev[m.id] ?? defaultVoteState();
      return next;
    });
    if (selectedMatchId === null && activeMatches.length > 0) {
      setSelectedMatchId(activeMatches[0].id);
    }
  }, [activeMatches]);

  useEffect(() => {
    setAnalyses((prev) => {
      const next: Record<string, PastMatchAnalysis> = {};
      for (const m of pastMatches) {
        next[m.id] = prev[m.id] ?? { text: null, loading: false, open: false, error: null };
      }
      return next;
    });
  }, [pastMatches]);

  // ── Live data fetch ───────────────────────────────────────────────────────
  const loadData = useCallback(async (force = false) => {
    setDataStatus("loading");
    try {
      const data = await fetchWorldCupData(force);
      if (data) {
        const { activeMatches: am, pastMatches: pm } = mapWorldCupData(data);
        setActiveMatches(am);
        setPastMatches(pm);
        const age = getCacheAge();
        setLastUpdated(age !== null ? formatCacheAge(age) : "just now");
        setCheckedDate(getDailyCheckDate());
        setDataStatus(force ? "live" : "cached");
      } else {
        setDataStatus("fallback");
      }
    } catch {
      setDataStatus("fallback");
    }
  }, []);

  useEffect(() => {
    loadData(false);
    const schedule = () => {
      refreshTimerRef.current = setTimeout(() => {
        loadData(true);
        schedule();
      }, REFRESH_INTERVAL_MS);
    };
    schedule();
    return () => { if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current); };
  }, [loadData]);

  // ── Wallet connect ────────────────────────────────────────────────────────
  const handleConnect = useCallback(async () => {
    setWalletConnecting(true);
    await new Promise((r) => setTimeout(r, 900));
    setWalletAddress(MOCK_WALLETS[Math.floor(Math.random() * MOCK_WALLETS.length)]);
    setWalletConnecting(false);
  }, []);

  const handleDisconnect = useCallback(() => {
    setWalletAddress(null);
    setVoteStates((prev) => {
      const next: Record<string, MatchVoteState> = {};
      for (const id of Object.keys(prev)) next[id] = defaultVoteState();
      return next;
    });
  }, []);

  // ── Submit prediction ─────────────────────────────────────────────────────
  const handleSubmit = useCallback(async (matchId: string) => {
    const vs = voteStates[matchId];
    if (!walletAddress || !vs?.selectedTeam || vs.submitting || vs.submitted) return;

    setVoteStates((p) => ({ ...p, [matchId]: { ...p[matchId], submitting: true } }));

    const prediction: Prediction = {
      matchId,
      walletAddress,
      teamPicked: vs.selectedTeam,
      reason: truncateReason(vs.reason.trim() || "No reason given"),
      timestamp: Date.now(),
    };

    const { blobId, storedOnWalrus } = await storePrediction(prediction);
    prediction.blobId = blobId;
    prediction.storedOnWalrus = storedOnWalrus;

    setPredictions((p) => [...p, prediction]);
    setVoteStates((p) => ({
      ...p,
      [matchId]: {
        ...p[matchId],
        submitting: false,
        submitted: true,
        storageStatus: storedOnWalrus ? "walrus" : "local",
      },
    }));
  }, [voteStates, walletAddress]);

  // ── AI analysis ───────────────────────────────────────────────────────────
  const handleToggleAnalysis = useCallback(async (matchId: string) => {
    const match = pastMatches.find((m) => m.id === matchId);
    const current = analyses[matchId];
    if (!match || !current) return;

    if (current.open) {
      setAnalyses((p) => ({ ...p, [matchId]: { ...p[matchId], open: false } }));
      return;
    }
    if (current.text) {
      setAnalyses((p) => ({ ...p, [matchId]: { ...p[matchId], open: true } }));
      return;
    }

    setAnalyses((p) => ({ ...p, [matchId]: { ...p[matchId], loading: true, open: true, error: null } }));

    try {
      const split = getVoteSplit(matchId, match.teamA, predictions);
      const reasons = predictions.filter((p) => p.matchId === matchId).map((p) => p.reason);
      const text = await generatePostMortem({
        teamA: match.teamA,
        teamB: match.teamB,
        winner: match.winner,
        result: match.result,
        teamAPercent: split.aPercent,
        teamBPercent: split.bPercent,
        reasons,
      });
      setAnalyses((p) => ({ ...p, [matchId]: { ...p[matchId], text, loading: false } }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Analysis failed";
      setAnalyses((p) => ({ ...p, [matchId]: { ...p[matchId], loading: false, error: msg } }));
    }
  }, [pastMatches, analyses, predictions]);

  // ── Manual refresh ────────────────────────────────────────────────────────
  const handleRefresh = useCallback(async () => {
    clearCache();
    await loadData(true);
  }, [loadData]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const pulseMatch = activeMatches.find((m) => m.id === selectedMatchId) ?? activeMatches[0];
  const pulseSplit = pulseMatch
    ? getVoteSplit(pulseMatch.id, pulseMatch.teamA, predictions)
    : { aPercent: 50, bPercent: 50, total: 0 };
  const recentPulse = pulseMatch
    ? predictions.filter((p) => p.matchId === pulseMatch.id).slice(-10).reverse()
    : [];

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen font-sans" style={{ background: "#0a0e1a" }}>

      {/* ── HEADER ─────────────────────────────────────────────────────────── */}
      <header
        className="sticky top-0 z-50 border-b"
        style={{ background: "rgba(10,14,26,0.95)", borderColor: "#1f2937", backdropFilter: "blur(12px)" }}
      >
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight" style={{ color: "#f0b429" }} data-testid="app-title">
              Chronicle
            </h1>
            <p className="text-xs" style={{ color: "#6b7280" }}>The World Cup's Living Witness</p>
          </div>

          <div className="flex items-center gap-2 flex-wrap justify-end">
            {/* Daily check marker */}
            {checkedDate && (
              <div
                className="hidden sm:flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full"
                style={{ background: "rgba(16,185,129,0.08)", color: "#10b981", border: "1px solid rgba(16,185,129,0.15)" }}
                title={`Data fetched on ${checkedDate}`}
                data-testid="daily-check-badge"
              >
                <CalendarCheck className="w-3 h-3" />
                Checked {checkedDate}
              </div>
            )}

            {/* Data status */}
            <div className="hidden sm:flex items-center gap-1.5">
              {dataStatus === "loading" && (
                <span className="flex items-center gap-1.5 text-xs" style={{ color: "#6b7280" }}>
                  <Loader2 className="w-3 h-3 animate-spin" /> Fetching...
                </span>
              )}
              {(dataStatus === "live" || dataStatus === "cached") && lastUpdated && (
                <span
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full"
                  style={{ background: "rgba(16,185,129,0.1)", color: "#10b981", border: "1px solid rgba(16,185,129,0.2)" }}
                  data-testid="data-status-badge"
                >
                  <Radio className="w-3 h-3" /> Live · {lastUpdated}
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
                onClick={handleRefresh}
                disabled={dataStatus === "loading"}
                className="p-1.5 rounded-lg transition-all disabled:opacity-40"
                style={{ background: "#111827", border: "1px solid #1f2937", color: "#6b7280" }}
                title="Refresh today's data"
                data-testid="button-refresh"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${dataStatus === "loading" ? "animate-spin" : ""}`} />
              </button>
            </div>

            {/* Wallet */}
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
                onClick={handleConnect}
                disabled={walletConnecting}
                className="flex items-center gap-2 px-4 py-2 rounded-lg font-semibold text-sm transition-all disabled:opacity-60"
                style={{ background: "#f0b429", color: "#0a0e1a" }}
                data-testid="button-connect-wallet"
              >
                {walletConnecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wallet className="w-4 h-4" />}
                {walletConnecting ? "Connecting..." : "Connect Wallet"}
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8 space-y-10">

        {/* ── TODAY'S MATCHES ─────────────────────────────────────────────── */}
        <section data-testid="active-matches-section">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <div className={`w-2 h-2 rounded-full animate-pulse ${activeMatches.some(m => m.isLive) ? "bg-red-400" : "bg-emerald-400"}`} />
                <span className="text-xs font-semibold tracking-widest uppercase" style={{ color: "#6b7280" }}>
                  {activeMatches.some(m => m.isLive) ? "Live Now" : "Today's Predictions"}
                </span>
                {dataStatus === "loading" && <Loader2 className="w-3 h-3 animate-spin" style={{ color: "#4b5563" }} />}
              </div>
              <p className="text-xs" style={{ color: "#4b5563" }}>
                {activeMatches.length} match{activeMatches.length !== 1 ? "es" : ""} · click a match to cast your prediction
              </p>
            </div>
          </div>

          {/* Match cards grid */}
          <div className="space-y-4">
            {activeMatches.map((match) => {
              const vs = voteStates[match.id] ?? defaultVoteState();
              const userVoted = predictions.some(
                (p) => p.matchId === match.id && p.walletAddress === walletAddress
              ) || vs.submitted;
              const isSelected = selectedMatchId === match.id;

              return (
                <div
                  key={match.id}
                  className="rounded-2xl overflow-hidden transition-all"
                  style={{
                    background: "#111827",
                    border: isSelected ? "1px solid rgba(240,180,41,0.4)" : "1px solid #1f2937",
                    boxShadow: isSelected ? "0 0 20px rgba(240,180,41,0.08)" : "none",
                  }}
                  data-testid={`active-match-${match.id}`}
                >
                  {/* Match header — always visible, click to focus */}
                  <div
                    className="px-6 pt-5 pb-4 cursor-pointer"
                    onClick={() => setSelectedMatchId(match.id)}
                  >
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-2">
                        <span
                          className="text-xs font-semibold px-2.5 py-1 rounded-full"
                          style={{ background: "rgba(240,180,41,0.1)", color: "#f0b429", border: "1px solid rgba(240,180,41,0.2)" }}
                        >
                          {match.stage}
                        </span>
                        {match.isLive && (
                          <span
                            className="text-xs font-bold px-2 py-0.5 rounded-full flex items-center gap-1"
                            style={{ background: "rgba(239,68,68,0.15)", color: "#f87171", border: "1px solid rgba(239,68,68,0.3)" }}
                          >
                            <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse inline-block" />
                            LIVE
                          </span>
                        )}
                      </div>
                      <span className="text-xs flex items-center gap-1" style={{ color: "#6b7280" }}>
                        <Clock className="w-3 h-3" />
                        {match.date}
                      </span>
                    </div>

                    {/* Teams row */}
                    <div className="flex items-center gap-3">
                      <div className="flex-1 text-center">
                        <div className="text-3xl mb-1">{match.teamA.split(" ")[0]}</div>
                        <div className="font-bold text-sm" style={{ color: "#e5e7eb" }}>
                          {match.teamA.replace(/^\S+\s/, "")}
                        </div>
                        {match.isLive && match.scoreA !== null && (
                          <div className="text-2xl font-bold mt-1" style={{ color: "#f0b429" }}>
                            {match.scoreA}
                          </div>
                        )}
                      </div>
                      <div className="text-center w-10 shrink-0">
                        <span className="font-bold text-base" style={{ color: "#374151" }}>
                          {match.isLive ? "–" : "VS"}
                        </span>
                      </div>
                      <div className="flex-1 text-center">
                        <div className="text-3xl mb-1">{match.teamB.split(" ")[0]}</div>
                        <div className="font-bold text-sm" style={{ color: "#e5e7eb" }}>
                          {match.teamB.replace(/^\S+\s/, "")}
                        </div>
                        {match.isLive && match.scoreB !== null && (
                          <div className="text-2xl font-bold mt-1" style={{ color: "#f0b429" }}>
                            {match.scoreB}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Vote panel — vote buttons always visible, textarea only when expanded */}
                  <div className="px-6 pb-6">
                    {userVoted ? (
                      <div
                        className="rounded-xl p-3 flex items-center gap-3"
                        style={{ background: "rgba(240,180,41,0.08)", border: "1px solid rgba(240,180,41,0.2)" }}
                        data-testid={`prediction-confirmation-${match.id}`}
                      >
                        <CheckCircle className="w-4 h-4 shrink-0" style={{ color: "#f0b429" }} />
                        <div>
                          <div className="font-semibold text-xs" style={{ color: "#f0b429" }}>
                            Prediction sealed on Chronicle
                          </div>
                          {vs.storageStatus && (
                            <span className={`${vs.storageStatus === "walrus" ? "walrus-badge" : "local-badge"} text-xs px-2 py-0.5 rounded-full inline-flex items-center gap-1 mt-1`}>
                              <Globe className="w-3 h-3" />
                              {vs.storageStatus === "walrus" ? "Stored on Walrus" : "Stored locally"}
                            </span>
                          )}
                        </div>
                      </div>
                    ) : (
                      <>
                        {/* Team buttons */}
                        <div className="flex gap-3 mb-3">
                          <button
                            className={`vote-btn-a flex-1 rounded-xl py-3 text-center transition-all text-sm font-semibold ${vs.selectedTeam === match.teamA ? "selected" : ""}`}
                            onClick={() => setVoteStates((p) => ({ ...p, [match.id]: { ...p[match.id], selectedTeam: match.teamA } }))}
                            disabled={!walletAddress}
                            data-testid={`button-vote-a-${match.id}`}
                          >
                            <span style={{ color: vs.selectedTeam === match.teamA ? "#f0b429" : "#e5e7eb" }}>
                              {vs.selectedTeam === match.teamA ? "✓ " : ""}{match.teamA.replace(/^\S+\s/, "")}
                            </span>
                          </button>
                          <button
                            className={`vote-btn-b flex-1 rounded-xl py-3 text-center transition-all text-sm font-semibold ${vs.selectedTeam === match.teamB ? "selected" : ""}`}
                            onClick={() => setVoteStates((p) => ({ ...p, [match.id]: { ...p[match.id], selectedTeam: match.teamB } }))}
                            disabled={!walletAddress}
                            data-testid={`button-vote-b-${match.id}`}
                          >
                            <span style={{ color: vs.selectedTeam === match.teamB ? "#f0b429" : "#e5e7eb" }}>
                              {vs.selectedTeam === match.teamB ? "✓ " : ""}{match.teamB.replace(/^\S+\s/, "")}
                            </span>
                          </button>
                        </div>

                        {/* Reason + submit — only when a team is selected */}
                        {vs.selectedTeam && (
                          <div className="animate-fade-in-up">
                            <textarea
                              value={vs.reason}
                              onChange={(e) =>
                                setVoteStates((p) => ({
                                  ...p,
                                  [match.id]: { ...p[match.id], reason: e.target.value.slice(0, 200) },
                                }))
                              }
                              placeholder="Why do you think this? (optional)"
                              rows={2}
                              maxLength={200}
                              className="w-full rounded-xl px-3 py-2.5 text-sm resize-none focus:outline-none transition-all mb-3"
                              style={{ background: "#0f172a", border: "1px solid #1f2937", color: "#e5e7eb", lineHeight: "1.6" }}
                              onFocus={(e) => (e.target.style.borderColor = "#f0b429")}
                              onBlur={(e) => (e.target.style.borderColor = "#1f2937")}
                              data-testid={`input-reason-${match.id}`}
                            />
                            <button
                              onClick={() => handleSubmit(match.id)}
                              disabled={vs.submitting}
                              className="w-full py-2.5 rounded-xl font-bold text-sm transition-all disabled:opacity-60"
                              style={{ background: "#f0b429", color: "#0a0e1a" }}
                              data-testid={`button-submit-${match.id}`}
                            >
                              {vs.submitting ? (
                                <span className="flex items-center justify-center gap-2">
                                  <Loader2 className="w-4 h-4 animate-spin" /> Sealing...
                                </span>
                              ) : "Submit Prediction"}
                            </button>
                          </div>
                        )}

                        {!walletAddress && (
                          <p className="text-center text-xs mt-2" style={{ color: "#4b5563" }}>
                            Connect wallet to predict
                          </p>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* ── COMMUNITY PULSE ──────────────────────────────────────────────── */}
        <section data-testid="community-pulse-section">
          <div className="mb-4">
            <h2 className="text-lg font-bold" style={{ color: "#e5e7eb" }}>What the crowd believes</h2>
            {pulseMatch && (
              <p className="text-xs mt-0.5" style={{ color: "#6b7280" }}>
                {pulseMatch.teamA.replace(/^\S+\s/, "")} vs {pulseMatch.teamB.replace(/^\S+\s/, "")} · {pulseSplit.total} prediction{pulseSplit.total !== 1 ? "s" : ""}
              </p>
            )}
          </div>

          {/* Match selector tabs */}
          {activeMatches.length > 1 && (
            <div className="flex gap-2 mb-4 flex-wrap">
              {activeMatches.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setSelectedMatchId(m.id)}
                  className="text-xs px-3 py-1.5 rounded-full font-semibold transition-all"
                  style={{
                    background: selectedMatchId === m.id ? "rgba(240,180,41,0.15)" : "#111827",
                    border: selectedMatchId === m.id ? "1px solid rgba(240,180,41,0.4)" : "1px solid #1f2937",
                    color: selectedMatchId === m.id ? "#f0b429" : "#6b7280",
                  }}
                  data-testid={`pulse-tab-${m.id}`}
                >
                  {m.teamA.split(" ")[0]} vs {m.teamB.split(" ")[0]}
                </button>
              ))}
            </div>
          )}

          {pulseMatch && (
            <>
              <div className="rounded-2xl p-5 mb-4" style={{ background: "#111827", border: "1px solid #1f2937" }}>
                <div className="flex justify-between text-xs mb-2">
                  <span className="font-semibold" style={{ color: "#60a5fa" }}>{pulseMatch.teamA} — {pulseSplit.aPercent}%</span>
                  <span className="font-semibold" style={{ color: "#f87171" }}>{pulseSplit.bPercent}% — {pulseMatch.teamB}</span>
                </div>
                <div className="h-3 rounded-full overflow-hidden" style={{ background: "#1f2937" }} data-testid="community-vote-bar">
                  <div
                    className="h-full rounded-full animate-bar-fill"
                    style={{ width: `${pulseSplit.aPercent}%`, background: "linear-gradient(90deg, #3b82f6, #60a5fa)" }}
                  />
                </div>
              </div>

              <div className="space-y-2" data-testid="prediction-feed">
                {recentPulse.length === 0 ? (
                  <div className="rounded-xl p-5 text-center" style={{ background: "#111827", border: "1px solid #1f2937" }}>
                    <p className="text-sm" style={{ color: "#4b5563" }}>No predictions yet. Be the first to speak.</p>
                  </div>
                ) : (
                  recentPulse.map((pred, i) => (
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
                          <span className="text-xs font-mono" style={{ color: "#9ca3af" }}>{truncateAddress(pred.walletAddress)}</span>
                          <span className="text-xs px-2 py-0.5 rounded-full font-semibold" style={{ background: "rgba(240,180,41,0.1)", color: "#f0b429" }}>
                            {pred.teamPicked.replace(/^\S+\s/, "")}
                          </span>
                        </div>
                        <p className="text-sm mt-1" style={{ color: "#d1d5db", lineHeight: "1.5" }}>{pred.reason}</p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </section>

        {/* ── CHRONICLE MEMORY ─────────────────────────────────────────────── */}
        <section data-testid="chronicle-memory-section">
          <div className="mb-4">
            <h2 className="text-lg font-bold" style={{ color: "#e5e7eb" }}>Chronicle Memory</h2>
            <p className="text-xs mt-0.5" style={{ color: "#6b7280" }}>
              {pastMatches.length} concluded match{pastMatches.length !== 1 ? "es" : ""} — the record never forgets
            </p>
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
                const analysis = analyses[match.id] ?? { text: null, loading: false, open: false, error: null };
                const winnerLabel = match.teamA.includes(match.winner) ? match.teamA : match.teamB;

                return (
                  <div
                    key={match.id}
                    className="rounded-2xl overflow-hidden"
                    style={{ background: "#111827", border: "1px solid #1f2937" }}
                    data-testid={`past-match-${match.id}`}
                  >
                    <div className="p-5">
                      <div className="flex items-start justify-between gap-4 mb-4">
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: "#1f2937", color: "#9ca3af" }}>{match.stage}</span>
                            <span className="text-xs" style={{ color: "#4b5563" }}>{match.date}</span>
                          </div>
                          <div className="font-bold text-base" style={{ color: "#e5e7eb" }}>
                            {match.teamA} <span style={{ color: "#374151" }}>vs</span> {match.teamB}
                          </div>
                          <div className="text-sm mt-0.5" style={{ color: "#9ca3af" }}>{match.result}</div>
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
                        data-testid={`button-analysis-${match.id}`}
                      >
                        <Zap className="w-3.5 h-3.5" />
                        {analysis.open ? "Hide" : "View"} Chronicle Analysis
                        {analysis.open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                      </button>
                    </div>

                    {analysis.open && (
                      <div
                        className="analysis-card border-t px-6 py-5"
                        style={{ borderColor: "rgba(240,180,41,0.15)" }}
                        data-testid={`analysis-panel-${match.id}`}
                      >
                        <div className="flex items-center gap-2 mb-3">
                          <Zap className="w-3.5 h-3.5" style={{ color: "#f0b429" }} />
                          <span className="text-xs font-bold tracking-widest uppercase" style={{ color: "#f0b429" }}>Chronicle Analysis</span>
                        </div>
                        {analysis.loading && (
                          <div className="flex items-center gap-2 text-sm" style={{ color: "#6b7280" }}>
                            <Loader2 className="w-4 h-4 animate-spin" /> Generating analysis...
                          </div>
                        )}
                        {analysis.error && <div className="text-sm" style={{ color: "#ef4444" }}>{analysis.error}</div>}
                        {analysis.text && (
                          <p className="text-sm leading-relaxed" style={{ color: "#d1d5db" }} data-testid={`analysis-text-${match.id}`}>
                            {analysis.text}
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

      {/* ── FOOTER ─────────────────────────────────────────────────────────── */}
      <footer className="mt-16 border-t py-6 text-center" style={{ borderColor: "#1f2937" }}>
        <p className="text-xs" style={{ color: "#374151" }}>
          Predictions stored on Walrus • Powered by Chronicle
          {(dataStatus === "live" || dataStatus === "cached") ? " • Live data via Gemini Search" : ""}
        </p>
      </footer>
    </div>
  );
}
