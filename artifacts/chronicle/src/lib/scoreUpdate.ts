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

// ─── Daily check helpers ──────────────────────────────────────────────────────

function getTodayString(): string {
  return new Date().toISOString().split("T")[0]; // "2026-06-18"
}

export function hasDailyCheck(): boolean {
  return localStorage.getItem(DAILY_CHECK_KEY) === getTodayString();
}

export function getDailyCheckDate(): string | null {
  return localStorage.getItem(DAILY_CHECK_KEY);
}

function setDailyCheck(): void {
  localStorage.setItem(DAILY_CHECK_KEY, getTodayString());
}

// ─── Cache helpers ────────────────────────────────────────────────────────────

function loadCached(): WorldCupData | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const cached: CachedData = JSON.parse(raw);
    const age = Date.now() - cached.fetchedAt;
    if (age > CACHE_TTL_MS) return null;
    return cached.data;
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
  localStorage.removeItem(CACHE_KEY);
  localStorage.removeItem(DAILY_CHECK_KEY);
}

// ─── Main fetch ───────────────────────────────────────────────────────────────

/**
 * Fetch World Cup data from Gemini with Google Search grounding.
 * - Runs once per calendar day; subsequent calls use the 24-hour cache.
 * - Pass forceRefresh=true to bypass both the daily check and the cache.
 */
export async function fetchWorldCupData(forceRefresh = false): Promise<WorldCupData | null> {
  // Use cache if: not forced AND (daily check already done OR cache still fresh)
  if (!forceRefresh) {
    if (hasDailyCheck()) {
      const cached = loadCached();
      if (cached) return cached;
    }
    const cached = loadCached();
    if (cached) return cached;
  }

  const apiKey = import.meta.env.VITE_GEMINI_API_KEY as string;
  if (!apiKey) {
    console.warn("[Chronicle] VITE_GEMINI_API_KEY not set — skipping live fetch");
    return null;
  }

  const today = getTodayString(); // e.g. "2026-06-18"

  try {
    const ai = new GoogleGenAI({ apiKey });

    // NOTE: googleSearch + responseMimeType:"application/json" are mutually exclusive.
    // We ask Gemini to output raw JSON and parse it ourselves.
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: `Today's date is ${today}.

Search Google for the FIFA World Cup 2026 match schedule and results.

I need ALL of the following:
1. Every match that has ALREADY been played (with final scores)
2. Every match that is currently LIVE (with current scores)
3. Every match scheduled for TODAY (${today}) that has not started yet
4. Every UPCOMING match scheduled for the next 7 days

Return ONLY a valid raw JSON object with NO markdown fences and NO extra text:
{
  "timestamp": "${today}T<current UTC time>",
  "total_matches": <integer — total count in the array>,
  "matches": [
    {
      "status": "<one of: 'FT' for finished | 'LIVE' | a kickoff time/date string for upcoming>",
      "match_state": "<EXACTLY one of: finished | live | upcoming>",
      "group": "<stage name, e.g. 'Group A', 'Round of 16'>",
      "team1": "<plain country name, no emoji, e.g. Argentina>",
      "score1": <integer goals or null if upcoming>,
      "team2": "<plain country name, no emoji>",
      "score2": <integer goals or null if upcoming>
    }
  ]
}

Critical rules:
- match_state must be EXACTLY "finished", "live", or "upcoming" (lowercase, no other values)
- score1 and score2 MUST be null for upcoming matches
- team names must be plain country names (no emoji, no abbreviations)
- Do NOT omit any matches — include every game you find
- Sort: live first, then today's upcoming, then other upcoming, then finished (newest first)`,
      config: {
        tools: [{ googleSearch: {} }],
      },
    });

    const text = response.text;
    if (!text) throw new Error("Empty response from Gemini");

    // Strip markdown fences if Gemini adds them despite instructions
    const jsonText = text
      .replace(/^```(?:json)?\s*/im, "")
      .replace(/\s*```\s*$/im, "")
      .trim();

    const parsed: WorldCupData = JSON.parse(jsonText);
    parsed.fetchedAt = Date.now();

    // Normalise match_state values (sometimes Gemini returns "FT" etc.)
    parsed.matches = parsed.matches.map((m) => {
      let state = m.match_state?.toLowerCase?.() as WorldCupMatch["match_state"];
      if (!["finished", "live", "upcoming"].includes(state)) {
        // Infer from status string
        const s = (m.status ?? "").toUpperCase();
        if (s === "FT" || s === "AET" || s === "PEN") state = "finished";
        else if (s.includes("LIVE") || s.includes("'")) state = "live";
        else state = "upcoming";
      }
      return { ...m, match_state: state };
    });

    parsed.total_matches = parsed.matches.length;

    saveCache(parsed);
    setDailyCheck();

    console.log(
      `[Chronicle] Fetched ${parsed.total_matches} matches for ${today} (timestamp: ${parsed.timestamp})`
    );
    return parsed;
  } catch (err) {
    console.error("[Chronicle] scoreUpdate fetch failed:", err);
    return null;
  }
}

// ─── Country flag map ─────────────────────────────────────────────────────────

const FLAG_MAP: Record<string, string> = {
  Argentina: "🇦🇷",
  Brazil: "🇧🇷",
  France: "🇫🇷",
  Germany: "🇩🇪",
  Spain: "🇪🇸",
  Portugal: "🇵🇹",
  England: "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
  Netherlands: "🇳🇱",
  Belgium: "🇧🇪",
  Italy: "🇮🇹",
  Croatia: "🇭🇷",
  Morocco: "🇲🇦",
  USA: "🇺🇸",
  "United States": "🇺🇸",
  Mexico: "🇲🇽",
  Canada: "🇨🇦",
  Japan: "🇯🇵",
  "South Korea": "🇰🇷",
  Australia: "🇦🇺",
  Senegal: "🇸🇳",
  Ghana: "🇬🇭",
  Nigeria: "🇳🇬",
  Cameroon: "🇨🇲",
  Ecuador: "🇪🇨",
  Uruguay: "🇺🇾",
  Colombia: "🇨🇴",
  Chile: "🇨🇱",
  Switzerland: "🇨🇭",
  Denmark: "🇩🇰",
  Poland: "🇵🇱",
  Serbia: "🇷🇸",
  Iran: "🇮🇷",
  "Saudi Arabia": "🇸🇦",
  Qatar: "🇶🇦",
  Tunisia: "🇹🇳",
  Wales: "🏴󠁧󠁢󠁷󠁬󠁳󠁿",
  "New Zealand": "🇳🇿",
  "Costa Rica": "🇨🇷",
  Panama: "🇵🇦",
  Honduras: "🇭🇳",
  Jamaica: "🇯🇲",
  "Trinidad and Tobago": "🇹🇹",
  Algeria: "🇩🇿",
  Egypt: "🇪🇬",
  "Ivory Coast": "🇨🇮",
  "Côte d'Ivoire": "🇨🇮",
  Mali: "🇲🇱",
  "South Africa": "🇿🇦",
  Turkey: "🇹🇷",
  Ukraine: "🇺🇦",
  Scotland: "🏴󠁧󠁢󠁳󠁣󠁴󠁿",
  Austria: "🇦🇹",
  Slovakia: "🇸🇰",
  Slovenia: "🇸🇮",
  Greece: "🇬🇷",
  Romania: "🇷🇴",
  Hungary: "🇭🇺",
  "Czech Republic": "🇨🇿",
  Czechia: "🇨🇿",
  Bolivia: "🇧🇴",
  Paraguay: "🇵🇾",
  Venezuela: "🇻🇪",
  Peru: "🇵🇪",
  Cuba: "🇨🇺",
  Iraq: "🇮🇶",
  Indonesia: "🇮🇩",
  Thailand: "🇹🇭",
  Vietnam: "🇻🇳",
  China: "🇨🇳",
  India: "🇮🇳",
  Uzbekistan: "🇺🇿",
  Kazakhstan: "🇰🇿",
  Palestine: "🇵🇸",
  Jordan: "🇯🇴",
  UAE: "🇦🇪",
  "United Arab Emirates": "🇦🇪",
  Bahrain: "🇧🇭",
  Kuwait: "🇰🇼",
  Oman: "🇴🇲",
  Libya: "🇱🇾",
  Sudan: "🇸🇩",
  Ethiopia: "🇪🇹",
  Tanzania: "🇹🇿",
  Kenya: "🇰🇪",
  Uganda: "🇺🇬",
  Zimbabwe: "🇿🇼",
  Zambia: "🇿🇲",
  Angola: "🇦🇴",
  Congo: "🇨🇬",
  Rwanda: "🇷🇼",
  Mozambique: "🇲🇿",
  "Cape Verde": "🇨🇻",
  Benin: "🇧🇯",
  Guinea: "🇬🇳",
  Gabon: "🇬🇦",
  Togo: "🇹🇬",
  Burkina: "🇧🇫",
  "Burkina Faso": "🇧🇫",
  Venezuela: "🇻🇪",
  Guatemala: "🇬🇹",
  "El Salvador": "🇸🇻",
  Nicaragua: "🇳🇮",
  Haiti: "🇭🇹",
  "Dominican Republic": "🇩🇴",
  Curacao: "🇨🇼",
  Suriname: "🇸🇷",
  Guyana: "🇬🇾",
  "New Caledonia": "🇳🇨",
  Fiji: "🇫🇯",
  "Papua New Guinea": "🇵🇬",
  Tahiti: "🇵🇫",
  "Solomon Islands": "🇸🇧",
  Vanuatu: "🇻🇺",
  Philippines: "🇵🇭",
  Malaysia: "🇲🇾",
  Singapore: "🇸🇬",
  Myanmar: "🇲🇲",
  Kyrgyzstan: "🇰🇬",
  Tajikistan: "🇹🇯",
  Azerbaijan: "🇦🇿",
  Georgia: "🇬🇪",
  Armenia: "🇦🇲",
  Albania: "🇦🇱",
  Kosovo: "🇽🇰",
  "North Macedonia": "🇲🇰",
  Moldova: "🇲🇩",
  Belarus: "🇧🇾",
  Lithuania: "🇱🇹",
  Latvia: "🇱🇻",
  Estonia: "🇪🇪",
  Finland: "🇫🇮",
  Norway: "🇳🇴",
  Sweden: "🇸🇪",
  Iceland: "🇮🇸",
  Ireland: "🇮🇪",
  "Northern Ireland": "🏴󠁧󠁢󠁮󠁩󠁲󠁿",
  Luxembourg: "🇱🇺",
  Malta: "🇲🇹",
  Gibraltar: "🇬🇮",
  Andorra: "🇦🇩",
  Liechtenstein: "🇱🇮",
  "San Marino": "🇸🇲",
  "Faroe Islands": "🇫🇴",
  Cyprus: "🇨🇾",
  Israel: "🇮🇱",
  Libya: "🇱🇾",
  Lebanon: "🇱🇧",
  Syria: "🇸🇾",
  Yemen: "🇾🇪",
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
