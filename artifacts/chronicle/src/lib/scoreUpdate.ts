// Match data is now fetched server-side.
// The client simply reads from /api/matches (cached on the server, refreshed daily).
// Local-storage is kept as a fast-path so repeat page-loads feel instant.

const LS_CACHE_KEY  = "chronicle_worldcup_data_v2";
const LS_CACHE_TTL  = 60 * 60 * 1000; // 1 hour — server is authoritative; we just cache locally for speed

export interface WorldCupMatch {
  status: string;
  match_state: "finished" | "live" | "upcoming";
  group: string;
  team1: string;
  score1: number | null;
  team2: string;
  score2: number | null;
}

export interface WorldCupData {
  timestamp: string;
  fetchedAt: number;
  fetchedDate: string;
  total_matches: number;
  matches: WorldCupMatch[];
}

interface LSCache {
  data: WorldCupData;
  savedAt: number;
}

// ─── Local-storage helpers ────────────────────────────────────────────────────

function lsLoad(): WorldCupData | null {
  try {
    const raw = localStorage.getItem(LS_CACHE_KEY);
    if (!raw) return null;
    const cached: LSCache = JSON.parse(raw);
    if (Date.now() - cached.savedAt < LS_CACHE_TTL) return cached.data;
    return null;
  } catch {
    return null;
  }
}

function lsSave(data: WorldCupData): void {
  try {
    const cached: LSCache = { data, savedAt: Date.now() };
    localStorage.setItem(LS_CACHE_KEY, JSON.stringify(cached));
  } catch {
    // quota exceeded — ignore
  }
}

function lsAge(): number | null {
  try {
    const raw = localStorage.getItem(LS_CACHE_KEY);
    if (!raw) return null;
    const cached: LSCache = JSON.parse(raw);
    return Date.now() - cached.savedAt;
  } catch {
    return null;
  }
}

export function clearCache(): void {
  try { localStorage.removeItem(LS_CACHE_KEY); } catch { /* ignore */ }
}

export function getCacheAge(): number | null { return lsAge(); }

// The server tracks the daily-check date — expose it from the cached payload
export function getDailyCheckDate(): string | null {
  const cached = lsLoad();
  return cached?.fetchedDate ?? null;
}

export function hasDailyCheck(): boolean {
  const d = getDailyCheckDate();
  if (!d) return false;
  return d === new Date().toISOString().split("T")[0];
}

// ─── Main fetch ───────────────────────────────────────────────────────────────

/**
 * Returns World Cup data from the API server.
 * Uses localStorage as a 1-hour speed cache so repeat loads feel instant.
 * Pass forceRefresh=true to bypass the local cache and hit the server.
 */
export async function fetchWorldCupData(forceRefresh = false): Promise<WorldCupData | null> {
  // Fast path: local cache within 1-hour TTL
  if (!forceRefresh) {
    const local = lsLoad();
    if (local) {
      console.log("[Chronicle] Serving from local cache.");
      return local;
    }
  }

  try {
    const url = forceRefresh ? "/api/matches?refresh=true" : "/api/matches";
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });

    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `Server returned ${res.status}`);
    }

    const data: WorldCupData = await res.json();
    lsSave(data);
    return data;
  } catch (err) {
    console.error("[Chronicle] /api/matches fetch failed:", err instanceof Error ? err.message : err);
    // Return stale local cache as last resort
    const stale = lsLoad();
    if (stale) return stale;
    return null;
  }
}

// ─── Country flag map ─────────────────────────────────────────────────────────

const FLAG_MAP: Record<string, string> = {
  Argentina: "🇦🇷", Brazil: "🇧🇷", France: "🇫🇷", Germany: "🇩🇪",
  Spain: "🇪🇸", Portugal: "🇵🇹", England: "🏴󠁧󠁢󠁥󠁮󠁧󠁿", Netherlands: "🇳🇱",
  Belgium: "🇧🇪", Italy: "🇮🇹", Croatia: "🇭🇷", Morocco: "🇲🇦",
  USA: "🇺🇸", "United States": "🇺🇸", Mexico: "🇲🇽", Canada: "🇨🇦",
  Japan: "🇯🇵", "South Korea": "🇰🇷", Australia: "🇦🇺", Senegal: "🇸🇳",
  Ghana: "🇬🇭", Nigeria: "🇳🇬", Cameroon: "🇨🇲", Ecuador: "🇪🇨",
  Uruguay: "🇺🇾", Colombia: "🇨🇴", Chile: "🇨🇱", Switzerland: "🇨🇭",
  Denmark: "🇩🇰", Poland: "🇵🇱", Serbia: "🇷🇸", Iran: "🇮🇷",
  "Saudi Arabia": "🇸🇦", Qatar: "🇶🇦", Tunisia: "🇹🇳", Wales: "🏴󠁧󠁢󠁷󠁬󠁳󠁿",
  "New Zealand": "🇳🇿", "Costa Rica": "🇨🇷", Panama: "🇵🇦", Honduras: "🇭🇳",
  Jamaica: "🇯🇲", "Trinidad and Tobago": "🇹🇹", Algeria: "🇩🇿", Egypt: "🇪🇬",
  "Ivory Coast": "🇨🇮", "Côte d'Ivoire": "🇨🇮", Mali: "🇲🇱", "South Africa": "🇿🇦",
  Turkey: "🇹🇷", Ukraine: "🇺🇦", Scotland: "🏴󠁧󠁢󠁳󠁣󠁴󠁿", Austria: "🇦🇹",
  Slovakia: "🇸🇰", Slovenia: "🇸🇮", Greece: "🇬🇷", Romania: "🇷🇴",
  Hungary: "🇭🇺", "Czech Republic": "🇨🇿", Czechia: "🇨🇿", Bolivia: "🇧🇴",
  Paraguay: "🇵🇾", Venezuela: "🇻🇪", Peru: "🇵🇪", Cuba: "🇨🇺",
  Iraq: "🇮🇶", Indonesia: "🇮🇩", Thailand: "🇹🇭", Vietnam: "🇻🇳",
  China: "🇨🇳", India: "🇮🇳", Uzbekistan: "🇺🇿", Kazakhstan: "🇰🇿",
  "United Arab Emirates": "🇦🇪", UAE: "🇦🇪", Bahrain: "🇧🇭",
  Kuwait: "🇰🇼", Oman: "🇴🇲", Jordan: "🇯🇴", Palestine: "🇵🇸",
  Libya: "🇱🇾", Sudan: "🇸🇩", Ethiopia: "🇪🇹", Kenya: "🇰🇪",
  Uganda: "🇺🇬", Zimbabwe: "🇿🇼", Zambia: "🇿🇲", Angola: "🇦🇴",
  Congo: "🇨🇬", Rwanda: "🇷🇼", Mozambique: "🇲🇿", "Cape Verde": "🇨🇻",
  Benin: "🇧🇯", Guinea: "🇬🇳", Gabon: "🇬🇦", Togo: "🇹🇬",
  "Burkina Faso": "🇧🇫", Guatemala: "🇬🇹", "El Salvador": "🇸🇻",
  Nicaragua: "🇳🇮", Haiti: "🇭🇹", "Dominican Republic": "🇩🇴",
  Curacao: "🇨🇼", Suriname: "🇸🇷", Guyana: "🇬🇾",
  Fiji: "🇫🇯", "Papua New Guinea": "🇵🇬",
  Philippines: "🇵🇭", Malaysia: "🇲🇾", Singapore: "🇸🇬",
  Myanmar: "🇲🇲", Kyrgyzstan: "🇰🇬", Tajikistan: "🇹🇯",
  Azerbaijan: "🇦🇿", Georgia: "🇬🇪", Armenia: "🇦🇲",
  Albania: "🇦🇱", Kosovo: "🇽🇰", "North Macedonia": "🇲🇰",
  Moldova: "🇲🇩", Belarus: "🇧🇾", Lithuania: "🇱🇹",
  Latvia: "🇱🇻", Estonia: "🇪🇪", Finland: "🇫🇮",
  Norway: "🇳🇴", Sweden: "🇸🇪", Iceland: "🇮🇸",
  Ireland: "🇮🇪", Luxembourg: "🇱🇺", Malta: "🇲🇹",
  Cyprus: "🇨🇾", Israel: "🇮🇱", Lebanon: "🇱🇧",
  Syria: "🇸🇾", Yemen: "🇾🇪",
};

export function formatTeamName(name: string): string {
  const clean = name.trim();
  const flag = FLAG_MAP[clean] ?? "🌍";
  return `${flag} ${clean}`;
}

export function formatResult(match: WorldCupMatch): string {
  if (match.score1 === null || match.score2 === null) return "";
  const s1 = match.score1;
  const s2 = match.score2;
  if (s1 > s2) return `${match.team1} won ${s1}-${s2}`;
  if (s2 > s1) return `${match.team2} won ${s2}-${s1}`;
  return `Draw ${s1}-${s2}`;
}

export function getWinner(match: WorldCupMatch): string {
  if (match.score1 === null || match.score2 === null) return "";
  if (match.score1 > match.score2) return match.team1;
  if (match.score2 > match.score1) return match.team2;
  return "Draw";
}
