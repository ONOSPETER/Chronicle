import { Router, type IRouter, type Request, type Response } from "express";
import { getCachedMatches, refreshMatches } from "../lib/matchCache.js";

const router: IRouter = Router();

/**
 * GET /api/matches
 * Returns cached World Cup match data.
 * Query: ?refresh=true  — forces a live re-fetch from Gemini.
 */
router.get("/matches", async (req: Request, res: Response) => {
  try {
    if (req.query["refresh"] === "true") {
      const data = await refreshMatches({
        info:  (m) => req.log.info(m),
        warn:  (m) => req.log.warn(m),
        error: (m) => req.log.error(m),
      });
      if (!data) {
        res.status(503).json({ error: "Match data temporarily unavailable — API quota reached." });
        return;
      }
      res.json(data);
      return;
    }

    const cached = getCachedMatches();
    if (!cached) {
      res.status(503).json({ error: "Match data not yet available — server is warming up." });
      return;
    }
    res.json(cached);
  } catch (err) {
    req.log.error({ err }, "GET /api/matches failed");
    res.status(500).json({ error: "Internal server error." });
  }
});

export default router;
