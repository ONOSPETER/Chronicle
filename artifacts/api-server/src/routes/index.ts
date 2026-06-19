import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import matchesRouter from "./matches.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(matchesRouter);

export default router;
