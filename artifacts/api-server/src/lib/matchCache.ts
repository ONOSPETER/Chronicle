import { GoogleGenAI } from "@google/genai";
import fs from "fs";
import path from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WorldCupMatch {
  status: string;
  match_state: "finished" | "live" | "upcoming";
  group: string;
  team1: string;
  score1: number | null;
  team2: string;
  score2: number | null;
}

export interface MatchData {
  timestamp: string;
  fetchedAt: number;
  fetchedDate: string;    // YYYY-MM-DD date the data was fetched
  total_matches: number;
  matches: WorldCupMatch[];
}

// ─── File cache ───────────────────────────────────────────────────────────────

// Stored alongside the built output so it survives server restarts
const CACHE_FILE = path.join(process.cwd(), "data", "matches.json");

function readCacheFile(): MatchData | null {
  try {
    const raw = fs.readFileSync(CACHE_FILE, "utf-8");
    return JSON.parse(raw) as MatchData;
  } catch {
    return null;
  }
}

function writeCacheFile(data: MatchData): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.error("[matchCache] Failed to write cache file:", err);
  }
}

// ─── In-memory store ──────────────────────────────────────────────────────────

let cachedData: MatchData | null = null;

function getTodayString(): string {
  return new Date().toISOString().split("T")[0];
}

function isCacheStale(data: MatchData): boolean {
  // Stale if the data is from a previous calendar day
  return data.fetchedDate !== getTodayString();
}

// ─── Gemini fetch ─────────────────────────────────────────────────────────────

const GEMINI_PRIMARY = process.env["GEMINI_API_KEY"] ?? "";
const GEMINI_BACKUP  = process.env["VITE_GEMINI_API_KEY_2"] ?? "";

function isRateLimit(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes("429") || msg.includes("quota") || msg.includes("rate limit") || msg.includes("resource_exhausted");
}

function isServiceUnavailable(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes("503") || msg.includes("unavailable") || msg.includes("high demand");
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchFromGemini(apiKey: string): Promise<MatchData> {
  const today = getTodayString();
  const ai = new GoogleGenAI({ apiKey });

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: `Today's date is ${today}.

Search Google for all FIFA World Cup 2026 matches: scheduled, live, and completed results.

Return ONLY a valid raw JSON object with NO markdown fences:
{
  "timestamp": "${today}T<current UTC time>",
  "total_matches": <integer>,
  "matches": [
    {
      "status": "<'FT' | 'LIVE' | kickoff time string e.g. '18:00 UTC'>",
      "match_state": "<EXACTLY one of: finished | live | upcoming>",
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
- Include ALL matches in the tournament: past, today, and next 7 days
- Sort: live first, then today upcoming, then other upcoming, then finished (newest first)
- Raw JSON only — no markdown, no code fences`,
    config: {
      tools: [{ googleSearch: {} }],
    },
  });

  const text = response.text ?? "";
  if (!text) throw new Error("Empty Gemini response");

  const jsonText = text
    .replace(/^```(?:json)?\s*/im, "")
    .replace(/\s*```\s*$/im, "")
    .trim();

  const parsed = JSON.parse(jsonText) as MatchData;

  // Normalise match_state
  parsed.matches = parsed.matches.map((m) => {
    let state = (m.match_state ?? "").toLowerCase() as WorldCupMatch["match_state"];
    if (!["finished", "live", "upcoming"].includes(state)) {
      const s = (m.status ?? "").toUpperCase();
      if (s === "FT" || s === "AET" || s === "PEN" || s === "PSO") state = "finished";
      else if (s.includes("LIVE") || s.includes("'") || s === "HT") state = "live";
      else state = "upcoming";
    }
    return { ...m, match_state: state };
  });

  parsed.total_matches = parsed.matches.length;
  parsed.fetchedAt = Date.now();
  parsed.fetchedDate = today;
  return parsed;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns cached match data, or null if nothing is cached yet.
 */
export function getCachedMatches(): MatchData | null {
  return cachedData;
}

/**
 * Fetch fresh World Cup data from Gemini (tries primary key, then backup).
 * Updates the in-memory cache and writes to disk.
 */
export async function refreshMatches(logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void }): Promise<MatchData | null> {
  const log = logger ?? {
    info:  (m: string) => console.log("[matchCache]", m),
    warn:  (m: string) => console.warn("[matchCache]", m),
    error: (m: string) => console.error("[matchCache]", m),
  };

  const keys = [GEMINI_PRIMARY, GEMINI_BACKUP].filter(Boolean);

  if (keys.length === 0) {
    log.warn("No Gemini API key configured — skipping match fetch");
    return null;
  }

  // Up to 3 attempts with exponential backoff (handles transient 503s)
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const delayMs = attempt * 8000; // 8s, 16s
      log.info(`Retry attempt ${attempt + 1}/3 — waiting ${delayMs / 1000}s…`);
      await sleep(delayMs);
    }

    for (let i = 0; i < keys.length; i++) {
      try {
        log.info(`Fetching World Cup data from Gemini (key ${i + 1}/${keys.length}, attempt ${attempt + 1}/3)…`);
        const data = await fetchFromGemini(keys[i]);
        cachedData = data;
        writeCacheFile(data);
        log.info(`Fetched ${data.total_matches} matches. Date: ${data.fetchedDate}`);
        return data;
      } catch (err) {
        const isLastKey = i === keys.length - 1;
        const errMsg = err instanceof Error ? err.message : String(err);
        if ((isRateLimit(err) || isServiceUnavailable(err)) && !isLastKey) {
          log.warn(`Key ${i + 1} unavailable — trying backup: ${errMsg.slice(0, 120)}`);
          continue;
        }
        if (!isLastKey) {
          log.warn(`Key ${i + 1} failed — trying backup: ${errMsg.slice(0, 120)}`);
          continue;
        }
        // Last key on this attempt
        if (isServiceUnavailable(err) && attempt < 2) {
          log.warn(`All keys unavailable (503) — will retry after backoff`);
          break; // break inner loop, outer loop will retry
        }
        log.error(`All keys failed: ${errMsg.slice(0, 200)}`);
      }
    }
  }
  return null;
}

/**
 * On server startup: load from disk, then refresh if stale or missing.
 */
export async function initMatchCache(logger?: Parameters<typeof refreshMatches>[0]): Promise<void> {
  const log = logger ?? {
    info:  (m: string) => console.log("[matchCache]", m),
    warn:  (m: string) => console.warn("[matchCache]", m),
    error: (m: string) => console.error("[matchCache]", m),
  };

  // Try to warm from disk first so the API can respond immediately
  const fromDisk = readCacheFile();
  if (fromDisk) {
    cachedData = fromDisk;
    log.info(`Loaded ${fromDisk.total_matches} matches from disk (fetched on ${fromDisk.fetchedDate})`);

    if (isCacheStale(fromDisk)) {
      log.info("Cache is from a previous day — refreshing in background");
      // Don't await — let the server start immediately
      void refreshMatches(log);
    } else {
      log.info("Cache is current — no fetch needed");
    }
  } else {
    log.info("No disk cache — fetching now");
    const result = await refreshMatches(log);
    if (!result) {
      // Gemini was unavailable — schedule a retry in 5 minutes
      log.warn("Initial fetch failed — will retry in 5 minutes");
      setTimeout(() => void refreshMatches(log), 5 * 60 * 1000);
    }
  }

  // Schedule daily refresh at midnight UTC
  scheduleDailyRefresh(log);
}

function scheduleDailyRefresh(log: Parameters<typeof refreshMatches>[0]): void {
  const now = new Date();
  // Next midnight UTC
  const nextMidnight = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 2, 0  // 00:02 UTC to let scores settle
  ));
  const msUntilMidnight = nextMidnight.getTime() - now.getTime();

  setTimeout(() => {
    void refreshMatches(log);
    // Then every 24 hours
    setInterval(() => void refreshMatches(log), 24 * 60 * 60 * 1000);
  }, msUntilMidnight);

  if (log) log.info(`Next auto-refresh scheduled in ${Math.round(msUntilMidnight / 3600000)}h`);
}
