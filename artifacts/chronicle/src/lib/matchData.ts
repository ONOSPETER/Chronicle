import type { Prediction } from "./walrus";
import type { WorldCupData } from "./scoreUpdate";
import { formatTeamName, formatResult, getWinner } from "./scoreUpdate";

export interface ActiveMatch {
  id: string;
  teamA: string;
  teamB: string;
  stage: string;
  date: string;
  isLive?: boolean;
  scoreA?: number | null;
  scoreB?: number | null;
}

export interface PastMatch {
  id: string;
  teamA: string;
  teamB: string;
  stage: string;
  date: string;
  result: string;
  winner: string;
}

// ─── Hardcoded fallback data ──────────────────────────────────────────────────

export const FALLBACK_ACTIVE_MATCHES: ActiveMatch[] = [
  {
    id: "m1",
    teamA: "🇦🇷 Argentina",
    teamB: "🇧🇷 Brazil",
    stage: "Group C",
    date: "June 26, 2026",
  },
];

export const FALLBACK_PAST_MATCHES: PastMatch[] = [
  {
    id: "m0",
    teamA: "🇩🇪 Germany",
    teamB: "🇫🇷 France",
    stage: "Group A",
    result: "France won 2-1",
    winner: "France",
    date: "June 20, 2026",
  },
  {
    id: "p0",
    teamA: "🇪🇸 Spain",
    teamB: "🇵🇹 Portugal",
    stage: "Group B",
    result: "Spain won 1-0",
    winner: "Spain",
    date: "June 22, 2026",
  },
];

// ─── Live data mapper ─────────────────────────────────────────────────────────

export function mapWorldCupData(data: WorldCupData): {
  activeMatches: ActiveMatch[];
  pastMatches: PastMatch[];
} {
  const finished: PastMatch[] = data.matches
    .filter((m) => m.match_state === "finished")
    .map((m, i) => ({
      id: `live_past_${i}_${m.team1}_${m.team2}`,
      teamA: formatTeamName(m.team1),
      teamB: formatTeamName(m.team2),
      stage: m.group,
      date: m.status,
      result: formatResult(m),
      winner: getWinner(m),
    }));

  const activeLive: ActiveMatch[] = data.matches
    .filter((m) => m.match_state === "live")
    .map((m, i) => ({
      id: `live_active_${i}_${m.team1}_${m.team2}`,
      teamA: formatTeamName(m.team1),
      teamB: formatTeamName(m.team2),
      stage: m.group,
      date: m.status,
      isLive: true,
      scoreA: m.score1,
      scoreB: m.score2,
    }));

  const activeUpcoming: ActiveMatch[] = data.matches
    .filter((m) => m.match_state === "upcoming")
    .map((m, i) => ({
      id: `upcoming_${i}_${m.team1}_${m.team2}`,
      teamA: formatTeamName(m.team1),
      teamB: formatTeamName(m.team2),
      stage: m.group,
      date: m.status,
      isLive: false,
      scoreA: null,
      scoreB: null,
    }));

  // Live matches first, then upcoming
  const activeMatches = [...activeLive, ...activeUpcoming];

  return {
    activeMatches: activeMatches.length > 0 ? activeMatches : FALLBACK_ACTIVE_MATCHES,
    pastMatches: finished.length > 0 ? finished : FALLBACK_PAST_MATCHES,
  };
}

// ─── Seeded predictions for fallback past matches ─────────────────────────────

export const SEED_PREDICTIONS: Prediction[] = [
  // Germany vs France (m0) — France won
  {
    matchId: "m0",
    walletAddress: "0x3f9a82b1c4d72e56",
    teamPicked: "🇫🇷 France",
    reason: "France's midfield is on another level. Mbappé will be unstoppable.",
    timestamp: 1750368000000,
    storedOnWalrus: false,
  },
  {
    matchId: "m0",
    walletAddress: "0x7c2d15e8f3a940b6",
    teamPicked: "🇩🇪 Germany",
    reason: "German discipline always shows in big tournaments. Their defense is a wall.",
    timestamp: 1750371600000,
    storedOnWalrus: false,
  },
  {
    matchId: "m0",
    walletAddress: "0xa4b63c29d18e57f0",
    teamPicked: "🇫🇷 France",
    reason: "Pogba's return gives them depth no other team can match.",
    timestamp: 1750375200000,
    storedOnWalrus: false,
  },
  {
    matchId: "m0",
    walletAddress: "0x19d4c7e02b5f83a1",
    teamPicked: "🇩🇪 Germany",
    reason: "Müller's leadership and experience will guide Germany past France.",
    timestamp: 1750378800000,
    storedOnWalrus: false,
  },
  {
    matchId: "m0",
    walletAddress: "0x8e5a31f6c0d94b27",
    teamPicked: "🇫🇷 France",
    reason: "France's attacking trio is the deadliest combination in this World Cup.",
    timestamp: 1750382400000,
    storedOnWalrus: false,
  },
  {
    matchId: "m0",
    walletAddress: "0xd2c1b4a7e39f6058",
    teamPicked: "🇩🇪 Germany",
    reason: "Germany know how to win when it counts.",
    timestamp: 1750386000000,
    storedOnWalrus: false,
  },
  {
    matchId: "m0",
    walletAddress: "0xf7e8c3b5a2d16094",
    teamPicked: "🇫🇷 France",
    reason: "Les Bleus' tactical flexibility gives them the edge.",
    timestamp: 1750389600000,
    storedOnWalrus: false,
  },
  // Spain vs Portugal (p0) — Spain won
  {
    matchId: "p0",
    walletAddress: "0x2b7f4a9c1e63d805",
    teamPicked: "🇪🇸 Spain",
    reason: "Spain's tiki-taka has evolved. Their press is relentless.",
    timestamp: 1750540800000,
    storedOnWalrus: false,
  },
  {
    matchId: "p0",
    walletAddress: "0x5c8d2e1b7f043a96",
    teamPicked: "🇵🇹 Portugal",
    reason: "Ronaldo declared this his last World Cup. He'll carry Portugal.",
    timestamp: 1750544400000,
    storedOnWalrus: false,
  },
  {
    matchId: "p0",
    walletAddress: "0x9a1f6d4c28b7e305",
    teamPicked: "🇪🇸 Spain",
    reason: "Pedri and Gavi control tempo. Portugal can't keep up.",
    timestamp: 1750548000000,
    storedOnWalrus: false,
  },
  {
    matchId: "p0",
    walletAddress: "0xe3b2c7a041d9f568",
    teamPicked: "🇵🇹 Portugal",
    reason: "Bruno Fernandes in top form. Portugal's attack is direct and dangerous.",
    timestamp: 1750551600000,
    storedOnWalrus: false,
  },
  {
    matchId: "p0",
    walletAddress: "0x6d4e8f1c3a027b59",
    teamPicked: "🇪🇸 Spain",
    reason: "Spain always performs in Iberian derbies.",
    timestamp: 1750555200000,
    storedOnWalrus: false,
  },
  {
    matchId: "p0",
    walletAddress: "0xb0a5c6f9d2e31847",
    teamPicked: "🇵🇹 Portugal",
    reason: "Diogo Jota's movement will expose Spain's high defensive line.",
    timestamp: 1750558800000,
    storedOnWalrus: false,
  },
  {
    matchId: "p0",
    walletAddress: "0x4f2c0d8e6b9a1735",
    teamPicked: "🇪🇸 Spain",
    reason: "Yamal will be the difference maker. At 18, already world class.",
    timestamp: 1750562400000,
    storedOnWalrus: false,
  },
];

// ─── Utility helpers ──────────────────────────────────────────────────────────

export function getPredictionsForMatch(matchId: string, all: Prediction[]): Prediction[] {
  return all.filter((p) => p.matchId === matchId);
}

export function getVoteSplit(
  matchId: string,
  teamA: string,
  all: Prediction[]
): { aPercent: number; bPercent: number; total: number } {
  const preds = getPredictionsForMatch(matchId, all);
  const total = preds.length;
  if (total === 0) return { aPercent: 50, bPercent: 50, total: 0 };
  const aVotes = preds.filter((p) => p.teamPicked === teamA).length;
  const aPercent = Math.round((aVotes / total) * 100);
  return { aPercent, bPercent: 100 - aPercent, total };
}

export function getCommunityAccuracy(
  pastMatch: PastMatch,
  all: Prediction[]
): { wasRight: boolean; winnerPercent: number; loserPercent: number } {
  const { aPercent } = getVoteSplit(pastMatch.id, pastMatch.teamA, all);
  const bPercent = 100 - aPercent;
  const winnerIsA =
    pastMatch.teamA.includes(pastMatch.winner) || pastMatch.winner === pastMatch.teamA;
  const winnerPercent = winnerIsA ? aPercent : bPercent;
  return {
    wasRight: winnerPercent > 50,
    winnerPercent,
    loserPercent: 100 - winnerPercent,
  };
}
