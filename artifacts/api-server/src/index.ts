import app from "./app.js";
import { logger } from "./lib/logger.js";
import { initMatchCache } from "./lib/matchCache.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Bootstrap match data before accepting traffic
await initMatchCache({
  info:  (m) => logger.info(m),
  warn:  (m) => logger.warn(m),
  error: (m) => logger.error(m),
});

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
