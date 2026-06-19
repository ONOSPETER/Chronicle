import { GoogleGenAI } from "@google/genai";

const CACHE_KEY = "chronicle_worldcup_data";
const DAILY_CHECK_KEY = "chronicle_daily_check";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

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
  total_matches: number;
  matches: WorldCupMatch[];
  fetchedAt: number;
}

interface CachedData {
  data: WorldCupData;
  fetchedAt: number;
}

// ─── Key management ───────────────────────────────────────────────────────────

const PRIMARY_KEY = import.meta.env.VITE_GEMINI_API_KEY as string;
const BACKUP_KEY = import.meta.env.VITE_GEMINI_API_KEY_2 as string;

function isRateLimitError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes("429") || msg.includes("quota") || msg.includes("rate limit") || msg.includes("resource_exhausted");
}

// ─── Daily-check helpers ──────────────────────────────────────────────────────

function getTodayString(): string {
  return new Date().toISOString().split("T")[0];
}

export function hasDailyCheck(): boolean {
  try {
    return localStorage.getItem(DAILY_CHECK_KEY) === getTodayString();
  } catch {
    return false;
  }
}

export function getDailyCheckDate(): string | null {
  try {
    return localStorage.getItem(DAILY_CHECK_KEY);
  } catch {
    return null;
  }
}

function setDailyCheck(): void {
  try {
    localStorage.setItem(DAILY_CHECK_KEY, getTodayString());
  } catch {
    // ignore
  }
}

// ─── Cache helpers ────────────────────────────────────────────────────────────

function loadCached(): WorldCupData | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const cached: CachedData = JSON.parse(raw);
    // Use cache if less than 24 hours old
    if (Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data;
    return null;
  } catch {
    return null;
  }
}

function saveCache(data: WorldCupData): void {
  try {
    const cached: CachedData = { data, fetchedAt: Date.now() };
    localStorage.setItem(CACHE_KEY, JSON.stringify(cached));
  } catch {
    // localStorage quota exceeded — ignore
  }
}

export function getCacheAge(): number | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const cached: CachedData = JSON.parse(raw);
    return Date.now() - cached.fetchedAt;
  } catch {
    return null;
  }
}

export function clearCache(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
    localStorage.removeItem(DAILY_CHECK_KEY);
  } catch {
    // ignore
  }
}

// ─── Core Gemini fetch ────────────────────────────────────────────────────────

async function fetchWithKey(apiKey: string, today: string): Promise<WorldCupData> {
  const ai = new GoogleGenAI({ apiKey });

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: `Today's date is ${today}.

Search Google for the FIFA World Cup 2026 match schedule and results.

Return ONLY a valid raw JSON object with NO markdown fences:
{
  "timestamp": "${today}T<current UTC time>",
  "total_matches": <integer>,
  "matches": [
    {
      "status": "<'FT' | 'LIVE' | kickoff time string>",
      "match_state": "<EXACTLY: finished | live | upcoming>",
      "group": "<stage e.g. 'Group A' or 'Round of 16'>",
      "team1": "<plain country name, no emoji>",
      "score1": <integer or null if upcoming>,
      "team2": "<plain country name, no emoji>",
      "score2": <integer or null if upcoming>
    }
  ]
}

Rules:
- match_state MUST be exactly "finished", "live", or "upcoming" (lowercase)
- score1/score2 MUST be null for upcoming matches
- Include ALL matches: finished, live, and upcoming (next 7 days)
- Sort: live first, then today's upcoming, then other upcoming, then finished (newest first)
- No markdown, no code fences, raw JSON only`,
    config: {
      tools: [{ googleSearch: {} }],
    },
  });

  const text = response.text;
  if (!text) throw new Error("Empty response from Gemini");

  const jsonText = text
    .replace(/^```(?:json)?\s*/im, "")
    .replace(/\s*```\s*$/im, "")
    .trim();

  const parsed: WorldCupData = JSON.parse(jsonText);
  parsed.fetchedAt = Date.now();

  // Normalise match_state values
  parsed.matches = parsed.matches.map((m) => {
    let state = m.match_state?.toLowerCase?.() as WorldCupMatch["match_state"];
    if (!["finished", "live", "upcoming"].includes(state)) {
      const s = (m.status ?? "").toUpperCase();
      if (s === "FT" || s === "AET" || s === "PEN") state = "finished";
      else if (s.includes("LIVE") || s.includes("'")) state = "live";
      else state = "upcoming";
    }
    return { ...m, match_state: state };
  });

  parsed.total_matches = parsed.matches.length;
  return parsed;
}

// ─── Main fetch (24-hour cache + daily-check + backup key) ───────────────────

/**
 * Returns World Cup data. Uses localStorage cache for 24 hours.
 * Only hits the Gemini API once per calendar day (or when cache is stale).
 * Pass forceRefresh=true to bypass cache and re-fetch immediately.
 */
export async function fetchWorldCupData(forceRefresh = false): Promise<WorldCupData | null> {
  // ── Always serve from cache when possible ──
  if (!forceRefresh) {
    // Same calendar day AND fresh cache → serve immediately, no API call
    if (hasDailyCheck()) {
      const cached = loadCached();
      if (cached) {
        console.log("[Chronicle] Serving from daily cache.");
        return cached;
      }
    }
    // Cache still within 24-hour TTL (even if new day) → serve from cache
    const cached = loadCached();
    if (cached) {
      console.log("[Chronicle] Serving from 24hr cache.");
      return cached;
    }
  }

  const today = getTodayString();
  const keys = [PRIMARY_KEY, BACKUP_KEY].filter(Boolean);

  if (keys.length === 0) {
    console.warn("[Chronicle] No Gemini API key configured — using fallback data.");
    return null;
  }

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    try {
      const data = await fetchWithKey(key, today);
      saveCache(data);
      setDailyCheck();
      console.log(`[Chronicle] Fetched ${data.total_matches} matches (key ${i + 1}/${keys.length})`);
      return data;
    } catch (err) {
      const isLast = i === keys.length - 1;
      if (isRateLimitError(err) && !isLast) {
        console.warn(`[Chronicle] Key ${i + 1} rate-limited — trying backup key`);
        continue;
      }
      if (!isLast) {
        console.warn(`[Chronicle] Key ${i + 1} failed — trying backup:`, err instanceof Error ? err.message : err);
        continue;
      }
      console.error("[Chronicle] All API keys failed:", err instanceof Error ? err.message : err);
    }
  }

  return null;
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
  Palestine: "🇵🇸", Jordan: "🇯🇴", UAE: "🇦🇪", "United Arab Emirates": "🇦🇪",
  Bahrain: "🇧🇭", Kuwait: "🇰🇼", Oman: "🇴🇲", Libya: "🇱🇾",
  Sudan: "🇸🇩", Ethiopia: "🇪🇹", Tanzania: "🇹🇿", Kenya: "🇰🇪",
  Uganda: "🇺🇬", Zimbabwe: "🇿🇼", Zambia: "🇿🇲", Angola: "🇦🇴",
  Congo: "🇨🇬", Rwanda: "🇷🇼", Mozambique: "🇲🇿", "Cape Verde": "🇨🇻",
  Benin: "🇧🇯", Guinea: "🇬🇳", Gabon: "🇬🇦", Togo: "🇹🇬",
  "Burkina Faso": "🇧🇫", Guatemala: "🇬🇹", "El Salvador": "🇸🇻",
  Nicaragua: "🇳🇮", Haiti: "🇭🇹", "Dominican Republic": "🇩🇴",
  Curacao: "🇨🇼", Suriname: "🇸🇷", Guyana: "🇬🇾",
  "New Caledonia": "🇳🇨", Fiji: "🇫🇯", "Papua New Guinea": "🇵🇬",
  Tahiti: "🇵🇫", "Solomon Islands": "🇸🇧", Vanuatu: "🇻🇺",
  Philippines: "🇵🇭", Malaysia: "🇲🇾", Singapore: "🇸🇬",
  Myanmar: "🇲🇲", Kyrgyzstan: "🇰🇬", Tajikistan: "🇹🇯",
  Azerbaijan: "🇦🇿", Georgia: "🇬🇪", Armenia: "🇦🇲",
  Albania: "🇦🇱", Kosovo: "🇽🇰", "North Macedonia": "🇲🇰",
  Moldova: "🇲🇩", Belarus: "🇧🇾", Lithuania: "🇱🇹",
  Latvia: "🇱🇻", Estonia: "🇪🇪", Finland: "🇫🇮",
  Norway: "🇳🇴", Sweden: "🇸🇪", Iceland: "🇮🇸",
  Ireland: "🇮🇪", Luxembourg: "🇱🇺", Malta: "🇲🇹",
  Gibraltar: "🇬🇮", Andorra: "🇦🇩", Liechtenstein: "🇱🇮",
  "San Marino": "🇸🇲", "Faroe Islands": "🇫🇴", Cyprus: "🇨🇾",
  Israel: "🇮🇱", Lebanon: "🇱🇧", Syria: "🇸🇾", Yemen: "🇾🇪",
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
