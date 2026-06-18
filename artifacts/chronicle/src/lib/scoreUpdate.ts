import { GoogleGenAI } from "@google/genai";

const CACHE_KEY = "chronicle_worldcup_data";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

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
    // localStorage quota exceeded or unavailable — ignore
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
}

/**
 * Fetch live World Cup data from Gemini with Google Search grounding.
 * Results are cached for 12 hours in localStorage.
 * Returns null if the API call fails.
 */
export async function fetchWorldCupData(forceRefresh = false): Promise<WorldCupData | null> {
  if (!forceRefresh) {
    const cached = loadCached();
    if (cached) return cached;
  }

  const apiKey = import.meta.env.VITE_GEMINI_API_KEY as string;
  if (!apiKey) {
    console.warn("[Chronicle] VITE_GEMINI_API_KEY not set — skipping live fetch");
    return null;
  }

  try {
    const ai = new GoogleGenAI({ apiKey });

    // NOTE: googleSearch grounding and responseMimeType:"application/json" are mutually
    // exclusive in the Gemini API. We use grounding for real-time data and ask Gemini
    // to return a JSON block in its text, which we extract and parse ourselves.
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: `Search Google for the latest FIFA World Cup 2026 match scores, live matches, and upcoming fixtures.

Return ONLY a valid JSON object (no markdown fences, no extra text) with this exact shape:
{
  "timestamp": "<ISO date string of when this data was retrieved>",
  "total_matches": <integer>,
  "matches": [
    {
      "status": "<e.g. 'FT', '74\\' (Live)', or kickoff date like 'Jun 26'>",
      "match_state": "<EXACTLY one of: finished | live | upcoming>",
      "group": "<e.g. 'Group A' or 'Round of 16'>",
      "team1": "<country name only, no emoji>",
      "score1": <integer or null if upcoming>,
      "team2": "<country name only, no emoji>",
      "score2": <integer or null if upcoming>
    }
  ]
}

Rules:
- match_state must be exactly "finished", "live", or "upcoming"
- score1/score2 must be null for upcoming matches
- team names should be plain country names (e.g. "Argentina", "France")
- Include ALL matches you can find: finished, live, and upcoming`,
      config: {
        tools: [{ googleSearch: {} }],
      },
    });

    const text = response.text;
    if (!text) throw new Error("Empty response from Gemini");

    // Strip markdown fences if Gemini wraps the JSON despite instructions
    const jsonText = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();

    const parsed: WorldCupData = JSON.parse(jsonText);
    parsed.fetchedAt = Date.now();
    saveCache(parsed);

    console.log(
      `[Chronicle] Fetched ${parsed.total_matches} World Cup matches from Gemini at ${parsed.timestamp}`
    );
    return parsed;
  } catch (err) {
    console.error("[Chronicle] scoreUpdate fetch failed:", err);
    return null;
  }
}

// Country flag emoji map — Gemini returns plain country names, we map them to flag + name
const FLAG_MAP: Record<string, string> = {
  "Argentina": "🇦🇷",
  "Brazil": "🇧🇷",
  "France": "🇫🇷",
  "Germany": "🇩🇪",
  "Spain": "🇪🇸",
  "Portugal": "🇵🇹",
  "England": "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
  "Netherlands": "🇳🇱",
  "Belgium": "🇧🇪",
  "Italy": "🇮🇹",
  "Croatia": "🇭🇷",
  "Morocco": "🇲🇦",
  "USA": "🇺🇸",
  "United States": "🇺🇸",
  "Mexico": "🇲🇽",
  "Canada": "🇨🇦",
  "Japan": "🇯🇵",
  "South Korea": "🇰🇷",
  "Australia": "🇦🇺",
  "Senegal": "🇸🇳",
  "Ghana": "🇬🇭",
  "Nigeria": "🇳🇬",
  "Cameroon": "🇨🇲",
  "Ecuador": "🇪🇨",
  "Uruguay": "🇺🇾",
  "Colombia": "🇨🇴",
  "Chile": "🇨🇱",
  "Switzerland": "🇨🇭",
  "Denmark": "🇩🇰",
  "Poland": "🇵🇱",
  "Serbia": "🇷🇸",
  "Iran": "🇮🇷",
  "Saudi Arabia": "🇸🇦",
  "Qatar": "🇶🇦",
  "Tunisia": "🇹🇳",
  "Wales": "🏴󠁧󠁢󠁷󠁬󠁳󠁿",
  "New Zealand": "🇳🇿",
  "Costa Rica": "🇨🇷",
  "Panama": "🇵🇦",
  "Honduras": "🇭🇳",
  "Jamaica": "🇯🇲",
  "Trinidad and Tobago": "🇹🇹",
  "Algeria": "🇩🇿",
  "Egypt": "🇪🇬",
  "Ivory Coast": "🇨🇮",
  "Mali": "🇲🇱",
  "South Africa": "🇿🇦",
  "Turkey": "🇹🇷",
  "Ukraine": "🇺🇦",
  "Scotland": "🏴󠁧󠁢󠁳󠁣󠁴󠁿",
  "Austria": "🇦🇹",
  "Slovakia": "🇸🇰",
  "Slovenia": "🇸🇮",
  "Greece": "🇬🇷",
  "Romania": "🇷🇴",
  "Hungary": "🇭🇺",
  "Czech Republic": "🇨🇿",
  "Bolivia": "🇧🇴",
  "Paraguay": "🇵🇾",
  "Venezuela": "🇻🇪",
  "Peru": "🇵🇪",
  "Cuba": "🇨🇺",
  "Iraq": "🇮🇶",
  "Indonesia": "🇮🇩",
  "Thailand": "🇹🇭",
  "Vietnam": "🇻🇳",
  "China": "🇨🇳",
  "India": "🇮🇳",
  "Pakistan": "🇵🇰",
  "Uzbekistan": "🇺🇿",
  "Kazakhstan": "🇰🇿",
  "Palestine": "🇵🇸",
  "Jordan": "🇯🇴",
  "UAE": "🇦🇪",
  "Bahrain": "🇧🇭",
  "Kuwait": "🇰🇼",
  "Oman": "🇴🇲",
  "Libya": "🇱🇾",
  "Sudan": "🇸🇩",
  "Ethiopia": "🇪🇹",
  "Tanzania": "🇹🇿",
  "Kenya": "🇰🇪",
  "Uganda": "🇺🇬",
  "Zimbabwe": "🇿🇼",
  "Zambia": "🇿🇲",
  "Angola": "🇦🇴",
  "Congo": "🇨🇬",
  "Rwanda": "🇷🇼",
  "Mozambique": "🇲🇿",
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
