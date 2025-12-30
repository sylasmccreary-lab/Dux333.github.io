import cluster from "cluster";
import crypto from "crypto";
import express, { Request, Response } from "express";
import rateLimit from "express-rate-limit";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { getServerConfigFromServer } from "../core/configuration/ConfigLoader";
import { GameInfo, ID } from "../core/Schemas";
import { generateID } from "../core/Util";
import { logger } from "./Logger";
import { MapPlaylist } from "./MapPlaylist";

const config = getServerConfigFromServer();
const playlist = new MapPlaylist();

const joinPreviewLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  skip: (req) => {
    const ua = req.get("user-agent")?.toLowerCase() ?? "";
    return [
      "discordbot",
      "twitterbot",
      "slackbot",
      "facebookexternalhit",
      "linkedinbot",
      "telegrambot",
      "applebot",
      "snapchat",
      "whatsapp",
    ].some((bot) => ua.includes(bot));
  },
});

const readyWorkers = new Set();

const app = express();
const server = http.createServer(app);

const log = logger.child({ comp: "m" });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.json());

const BOT_USER_AGENTS = [
  "discordbot",
  "twitterbot",
  "slackbot",
  "facebookexternalhit",
  "linkedinbot",
  "telegrambot",
  "applebot",
  "snapchat",
  "whatsapp",
  "pinterestbot",
];

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const isBotRequest = (req: Request): boolean => {
  const ua = req.get("user-agent")?.toLowerCase() ?? "";
  return BOT_USER_AGENTS.some((token) => ua.includes(token));
};

const requestOrigin = (req: Request): string => {
  const protoHeader = (req.headers["x-forwarded-proto"] as string) ?? "";
  const proto = protoHeader.split(",")[0] || req.protocol || "https";
  const host = req.get("host") ?? `${config.subdomain()}.${config.domain()}`;
  return `${proto}://${host}`;
};

const fetchLobbyInfo = async (gameID: string): Promise<GameInfo | null> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const workerPort = config.workerPort(gameID);
    const response = await fetch(
      `http://127.0.0.1:${workerPort}/api/game/${gameID}`,
      {
        signal: controller.signal,
      },
    );
    if (!response.ok) return null;
    const data = (await response.json()) as GameInfo;
    return data;
  } catch (error) {
    log.warn("failed to fetch lobby info", { gameID, error });
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

type ExternalGameInfo = {
  info?: {
    config?: {
      gameMap?: string;
      gameMode?: string;
      gameType?: string;
      difficulty?: string;
      bots?: number;
      maxPlayers?: number;
    };
    players?: unknown[];
    winner?: string[];
    duration?: number;
    num_turns?: number;
    start?: number;
    end?: number;
  };
};

const fetchPublicGameInfo = async (
  gameID: string,
): Promise<ExternalGameInfo | null> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`https://api.openfront.io/game/${gameID}`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return (await response.json()) as ExternalGameInfo;
  } catch (error) {
    log.warn("failed to fetch public game info", { gameID, error });
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

type PreviewMeta = {
  title: string;
  description: string;
  image: string;
  joinUrl: string;
  redirectUrl: string;
};

const buildPreview = (
  gameID: string,
  origin: string,
  lobby: GameInfo | null,
  publicInfo: ExternalGameInfo | null,
): PreviewMeta => {
  const joinUrl = `${origin}/join/${gameID}`;
  const redirectUrl = joinUrl;

  const isFinished = !!publicInfo?.info?.end;

  const players =
    lobby?.numClients ??
    lobby?.clients?.length ??
    publicInfo?.info?.players?.length;
  const maxPlayers =
    lobby?.gameConfig?.maxPlayers ?? publicInfo?.info?.config?.maxPlayers;
  const map = lobby?.gameConfig?.gameMap ?? publicInfo?.info?.config?.gameMap;
  const mode =
    lobby?.gameConfig?.gameMode ??
    publicInfo?.info?.config?.gameMode ??
    publicInfo?.info?.config?.gameType;
  const difficulty =
    lobby?.gameConfig?.difficulty ?? publicInfo?.info?.config?.difficulty;
  const bots = lobby?.gameConfig?.bots ?? publicInfo?.info?.config?.bots;
  const winnerArray = publicInfo?.info?.winner;
  const winner =
    winnerArray && winnerArray.length > 1 ? winnerArray[1] : undefined;
  const turns = publicInfo?.info?.num_turns;
  const duration = publicInfo?.info?.duration;

  const image = map
    ? `${origin}/maps/${encodeURIComponent(map)}.png`
    : `${origin}/images/GameplayScreenshot.png`;

  const details: string[] = [];

  if (mode) details.push(mode);
  if (map) details.push(map);
  if (difficulty) details.push(difficulty);
  if (maxPlayers !== undefined) {
    details.push(`${players ?? 0}/${maxPlayers} players`);
  } else if (players !== undefined) {
    details.push(`${players} players`);
  }
  if (bots !== undefined && bots > 0) {
    details.push(`${bots} bots`);
  }
  if (turns !== undefined) {
    details.push(`${turns} turns`);
  }

  const title = details.length > 0 ? details.join(" • ") : "OpenFront Game";

  let description = "";
  if (isFinished) {
    if (winner) {
      description = `Winner: ${winner}`;
    } else {
      description = "Game finished";
    }
    if (duration !== undefined) {
      const mins = Math.floor(duration / 60);
      const secs = duration % 60;
      description += ` • ${mins}m ${secs}s`;
    }
  } else if (lobby) {
    description = `Join this ${mode ?? "game"} and start playing!`;
  } else {
    description = `Game ${gameID}`;
  }

  return { title, description, image, joinUrl, redirectUrl };
};

const renderJoinPreview = (
  meta: PreviewMeta,
  joinId: string,
  botRequest: boolean,
): string => {
  const refreshTag = botRequest
    ? ""
    : `<meta http-equiv="refresh" content="0; url=${meta.redirectUrl}">`;

  const redirectScript = botRequest
    ? ""
    : `<script>window.location.replace("${meta.redirectUrl}");</script>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(meta.title)}</title>
    <link rel="canonical" href="${meta.joinUrl}" />
    <meta property="og:title" content="${escapeHtml(meta.title)}" />
    <meta property="og:description" content="${escapeHtml(meta.description)}" />
    <meta property="og:image" content="${meta.image}" />
    <meta property="og:url" content="${meta.joinUrl}" />
    <meta property="og:type" content="website" />
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content="${escapeHtml(meta.title)}" />
    <meta name="twitter:description" content="${escapeHtml(meta.description)}" />
    <meta name="twitter:image" content="${meta.image}" />
    ${refreshTag}
    <style>
      body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 2rem; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
      .card { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 1.5rem; max-width: 520px; box-shadow: 0 18px 40px rgba(0,0,0,0.35); }
      h1 { margin: 0 0 0.5rem; font-size: 1.4rem; }
      p { margin: 0 0 1rem; line-height: 1.4; }
      a { color: #93c5fd; text-decoration: none; font-weight: 600; }
      a:hover { text-decoration: underline; }
      .pill { display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.35rem 0.75rem; border-radius: 999px; background: rgba(255,255,255,0.08); color: #cbd5e1; font-size: 0.9rem; }
    </style>
  </head>
  <body>
    <main class="card" role="main">
      <h1>${escapeHtml(meta.title)}</h1>
      <p>${escapeHtml(meta.description)}</p>
      <div class="pill">Lobby code: ${escapeHtml(joinId)}</div>
      <p style="margin-top: 1rem;"><a href="${meta.redirectUrl}">Open lobby</a></p>
    </main>
    ${redirectScript}
  </body>
</html>`;
};

const serveJoinPreview = async (
  req: Request,
  res: Response,
  gameID: string,
): Promise<void> => {
  const parsed = ID.safeParse(gameID);
  if (!parsed.success) {
    res.redirect(302, "/");
    return;
  }

  const joinId = parsed.data;
  const origin = requestOrigin(req);
  const botRequest = isBotRequest(req);
  const [lobby, publicInfo] = await Promise.all([
    fetchLobbyInfo(joinId),
    fetchPublicGameInfo(joinId),
  ]);

  if (botRequest) {
    const meta = buildPreview(joinId, origin, lobby, publicInfo);
    const html = renderJoinPreview(meta, joinId, true);
    res
      .status(200)
      .setHeader("Cache-Control", "no-store")
      .type("html")
      .send(html);
    return;
  }

  res.sendFile(path.join(__dirname, "../../static/index.html"));
};

app.get("/join/:gameId", joinPreviewLimiter, (req, res) => {
  serveJoinPreview(req, res, req.params.gameId).catch((error) => {
    log.error("failed to render join preview", { error });
    res.status(500).send("Unable to render lobby preview");
  });
});

app.use(
  express.static(path.join(__dirname, "../../static"), {
    maxAge: "1y", // Set max-age to 1 year for all static assets
    setHeaders: (res, path) => {
      // You can conditionally set different cache times based on file types
      if (path.endsWith(".html")) {
        // Set HTML files to no-cache to ensure Express doesn't send 304s
        res.setHeader(
          "Cache-Control",
          "no-store, no-cache, must-revalidate, proxy-revalidate",
        );
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
        // Prevent conditional requests
        res.setHeader("ETag", "");
      } else if (path.match(/\.(js|css|svg)$/)) {
        // JS, CSS, SVG get long cache with immutable
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else if (path.match(/\.(bin|dat|exe|dll|so|dylib)$/)) {
        // Binary files also get long cache with immutable
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
      // Other file types use the default maxAge setting
    },
  }),
);
app.use(express.json());

app.set("trust proxy", 3);
app.use(
  rateLimit({
    windowMs: 1000, // 1 second
    max: 1000, // 1000 requests per IP per second
  }),
);

let publicLobbiesJsonStr = "";

const publicLobbyIDs: Set<string> = new Set();

// Start the master process
export async function startMaster() {
  if (!cluster.isPrimary) {
    throw new Error(
      "startMaster() should only be called in the primary process",
    );
  }

  log.info(`Primary ${process.pid} is running`);
  log.info(`Setting up ${config.numWorkers()} workers...`);

  // Generate admin token for worker authentication
  const ADMIN_TOKEN = crypto.randomBytes(16).toString("hex");
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;

  // Fork workers
  for (let i = 0; i < config.numWorkers(); i++) {
    const worker = cluster.fork({
      WORKER_ID: i,
      ADMIN_TOKEN,
    });

    log.info(`Started worker ${i} (PID: ${worker.process.pid})`);
  }

  cluster.on("message", (worker, message) => {
    if (message.type === "WORKER_READY") {
      const workerId = message.workerId;
      readyWorkers.add(workerId);
      log.info(
        `Worker ${workerId} is ready. (${readyWorkers.size}/${config.numWorkers()} ready)`,
      );
      // Start scheduling when all workers are ready
      if (readyWorkers.size === config.numWorkers()) {
        log.info("All workers ready, starting game scheduling");

        const scheduleLobbies = () => {
          schedulePublicGame(playlist).catch((error) => {
            log.error("Error scheduling public game:", error);
          });
        };

        setInterval(
          () =>
            fetchLobbies().then((lobbies) => {
              if (lobbies === 0) {
                scheduleLobbies();
              }
            }),
          100,
        );
      }
    }
  });

  // Handle worker crashes
  cluster.on("exit", (worker, code, signal) => {
    const workerId = (worker as any).process?.env?.WORKER_ID;
    if (!workerId) {
      log.error(`worker crashed could not find id`);
      return;
    }

    log.warn(
      `Worker ${workerId} (PID: ${worker.process.pid}) died with code: ${code} and signal: ${signal}`,
    );
    log.info(`Restarting worker ${workerId}...`);

    // Restart the worker with the same ID
    const newWorker = cluster.fork({
      WORKER_ID: workerId,
      ADMIN_TOKEN,
    });

    log.info(
      `Restarted worker ${workerId} (New PID: ${newWorker.process.pid})`,
    );
  });

  const PORT = 3000;
  server.listen(PORT, () => {
    log.info(`Master HTTP server listening on port ${PORT}`);
  });
}

app.get("/api/env", async (req, res) => {
  const envConfig = {
    game_env: process.env.GAME_ENV,
  };
  if (!envConfig.game_env) return res.sendStatus(500);
  res.json(envConfig);
});

// Add lobbies endpoint to list public games for this worker
app.get("/api/public_lobbies", async (req, res) => {
  res.send(publicLobbiesJsonStr);
});

async function fetchLobbies(): Promise<number> {
  const fetchPromises: Promise<GameInfo | null>[] = [];

  for (const gameID of new Set(publicLobbyIDs)) {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5000); // 5 second timeout
    const port = config.workerPort(gameID);
    const promise = fetch(`http://localhost:${port}/api/game/${gameID}`, {
      headers: { [config.adminHeader()]: config.adminToken() },
      signal: controller.signal,
    })
      .then((resp) => resp.json())
      .then((json) => {
        return json as GameInfo;
      })
      .catch((error) => {
        log.error(`Error fetching game ${gameID}:`, error);
        // Return null or a placeholder if fetch fails
        publicLobbyIDs.delete(gameID);
        return null;
      });

    fetchPromises.push(promise);
  }

  // Wait for all promises to resolve
  const results = await Promise.all(fetchPromises);

  // Filter out any null results from failed fetches
  const lobbyInfos: GameInfo[] = results
    .filter((result) => result !== null)
    .map((gi: GameInfo) => {
      return {
        gameID: gi.gameID,
        numClients: gi?.clients?.length ?? 0,
        gameConfig: gi.gameConfig,
        msUntilStart: (gi.msUntilStart ?? Date.now()) - Date.now(),
      } as GameInfo;
    });

  lobbyInfos.forEach((l) => {
    if (
      "msUntilStart" in l &&
      l.msUntilStart !== undefined &&
      l.msUntilStart <= 250
    ) {
      publicLobbyIDs.delete(l.gameID);
      return;
    }

    if (
      "gameConfig" in l &&
      l.gameConfig !== undefined &&
      "maxPlayers" in l.gameConfig &&
      l.gameConfig.maxPlayers !== undefined &&
      "numClients" in l &&
      l.numClients !== undefined &&
      l.gameConfig.maxPlayers <= l.numClients
    ) {
      publicLobbyIDs.delete(l.gameID);
      return;
    }
  });

  // Update the JSON string
  publicLobbiesJsonStr = JSON.stringify({
    lobbies: lobbyInfos,
  });

  return publicLobbyIDs.size;
}

// Function to schedule a new public game
async function schedulePublicGame(playlist: MapPlaylist) {
  const gameID = generateID();
  publicLobbyIDs.add(gameID);

  const workerPath = config.workerPath(gameID);

  // Send request to the worker to start the game
  try {
    const response = await fetch(
      `http://localhost:${config.workerPort(gameID)}/api/create_game/${gameID}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [config.adminHeader()]: config.adminToken(),
        },
        body: JSON.stringify(playlist.gameConfig()),
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to schedule public game: ${response.statusText}`);
    }
  } catch (error) {
    log.error(`Failed to schedule public game on worker ${workerPath}:`, error);
    throw error;
  }
}

// SPA fallback route
app.get("*", function (req, res) {
  res.sendFile(path.join(__dirname, "../../static/index.html"));
});
