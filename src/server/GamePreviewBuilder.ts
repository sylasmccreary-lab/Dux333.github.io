import { GameInfo } from "../core/Schemas";

type PlayerInfo = {
  clientID?: string;
  username?: string;
  stats?: unknown;
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
    players?: PlayerInfo[];
    winner?: string[];
    duration?: number;
    num_turns?: number;
    start?: number;
    end?: number;
    lobbyCreatedAt?: number;
  };
};

type PreviewMeta = {
  title: string;
  description: string;
  image: string;
  joinUrl: string;
  redirectUrl: string;
};

export class GamePreviewBuilder {
  private static formatDuration(seconds: number | undefined): string {
    if (seconds === undefined) return "N/A";
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    const hours = Math.floor(mins / 60);
    const minutes = mins % 60;
    if (hours) return `${hours}h ${minutes}m ${secs}s`;
    if (minutes) return `${minutes}m ${secs}s`;
    return `${secs}s`;
  }

  private static parseWinner(
    winnerArray: string[] | undefined,
    players: PlayerInfo[] | undefined,
  ): string | undefined {
    if (!winnerArray || winnerArray.length < 2) return undefined;

    const idToName = new Map(
      (players ?? []).map((p) => [p.clientID, p.username]),
    );

    if (winnerArray[0] === "team" && winnerArray.length >= 3) {
      const playerIds = winnerArray.slice(2);
      const names = playerIds
        .map((id) => idToName.get(id) ?? id)
        .filter(Boolean);
      return names.length > 0 ? names.join(", ") : undefined;
    }

    if (winnerArray[0] === "player" && winnerArray.length >= 2) {
      const clientId = winnerArray[1];
      return idToName.get(clientId) ?? clientId;
    }

    return winnerArray.join(" ");
  }

  private static countActivePlayers(players: PlayerInfo[] | undefined): number {
    return (players ?? []).filter((p) => p.stats !== undefined).length;
  }

  private static escapeHtml(value: string): string {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  private static escapeJsString(value: string): string {
    return value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
  }

  static buildPreview(
    gameID: string,
    origin: string,
    lobby: GameInfo | null,
    publicInfo: ExternalGameInfo | null,
  ): PreviewMeta {
    const joinUrl = `${origin}/game/${gameID}`;
    const redirectUrl = joinUrl;

    const isFinished = !!publicInfo?.info?.end;
    const config = publicInfo?.info?.config ?? {};
    const players = publicInfo?.info?.players ?? [];

    const activePlayers = isFinished
      ? this.countActivePlayers(players)
      : (lobby?.numClients ?? lobby?.clients?.length ?? players.length);
    const maxPlayers = lobby?.gameConfig?.maxPlayers ?? config.maxPlayers;
    const map = lobby?.gameConfig?.gameMap ?? config.gameMap;
    let mode =
      lobby?.gameConfig?.gameMode ?? config.gameMode ?? config.gameType;
    const playerTeams = lobby?.gameConfig?.playerTeams;

    // Format team mode display
    if (!isFinished && mode === "Team" && playerTeams) {
      if (typeof playerTeams === "string") {
        mode = playerTeams; // e.g., "Quads"
      } else if (typeof playerTeams === "number") {
        mode = `${playerTeams} Teams`;
      }
    }

    const difficulty = lobby?.gameConfig?.difficulty ?? config.difficulty;
    const bots = lobby?.gameConfig?.bots ?? config.bots;
    const winner = this.parseWinner(publicInfo?.info?.winner, players);
    const turns = publicInfo?.info?.num_turns;
    const duration = publicInfo?.info?.duration;

    const mapThumbnail = map
      ? `${origin}/maps/${encodeURIComponent(map.toLowerCase().replace(/\s+/g, ""))}/thumbnail.webp`
      : null;
    const image = mapThumbnail ?? `${origin}/images/GameplayScreenshot.png`;

    const title = isFinished
      ? `${mode ?? "Game"} on ${map ?? "Unknown Map"}`
      : mode && map
        ? `${mode} • ${map} • ${maxPlayers ? `${activePlayers}/${maxPlayers}` : `${activePlayers}`} players`
        : "OpenFront Game";

    let description = "";
    if (isFinished) {
      const parts: string[] = [];
      if (winner) parts.push(`Winner: ${winner}`);
      if (duration !== undefined)
        parts.push(`Duration: ${this.formatDuration(duration)}`);
      if (turns !== undefined) parts.push(`Turns: ${turns}`);
      if (difficulty) parts.push(`Difficulty: ${difficulty}`);
      if (bots !== undefined && bots > 0) parts.push(`Bots: ${bots}`);
      const playerCount =
        maxPlayers !== undefined
          ? `${activePlayers}/${maxPlayers}`
          : `${activePlayers}`;
      parts.push(`Players: ${playerCount}`);
      description = parts.join(" • ");
    } else if (lobby) {
      const gc = lobby.gameConfig;
      const isPrivate = gc?.gameType === "Private";

      if (isPrivate) {
        // Private lobby: show detailed game settings
        const gameOptions: string[] = [];

        if (gc?.gameMapSize && gc.gameMapSize !== "Normal") {
          gameOptions.push(`${gc.gameMapSize} Map`);
        }
        if (difficulty) gameOptions.push(difficulty);
        if (gc?.infiniteGold) gameOptions.push("Infinite Gold");
        if (gc?.infiniteTroops) gameOptions.push("Infinite Troops");
        if (gc?.instantBuild) gameOptions.push("Instant Build");
        if (gc?.randomSpawn) gameOptions.push("Random Spawn");
        if (gc?.disableNations) gameOptions.push("Nations Disabled");
        if (gc?.donateTroops) gameOptions.push("Troop Donations Enabled");

        const sections: string[] = [];
        if (gameOptions.length > 0) {
          sections.push(`Game Options: ${gameOptions.join(" | ")}`);
        }

        if (gc?.disabledUnits && gc.disabledUnits.length > 0) {
          sections.push(`Disabled Units: ${gc.disabledUnits.join(" | ")}`);
        }

        sections.push("Join now!");
        description = sections.join("\n");
      } else {
        // Public lobby: basic info
        const parts: string[] = [];
        if (difficulty) parts.push(difficulty);
        if (bots !== undefined && bots > 0) parts.push(`${bots} bots`);
        description = parts.join(" • ");
      }
    } else {
      description = `Game ${gameID}`;
    }

    return { title, description, image, joinUrl, redirectUrl };
  }

  static renderPreview(
    meta: PreviewMeta,
    joinId: string,
    botRequest: boolean,
  ): string {
    const refreshTag = botRequest
      ? ""
      : `<meta http-equiv="refresh" content="0; url=${this.escapeHtml(meta.redirectUrl)}">`;

    const redirectScript = botRequest
      ? ""
      : `<script>window.location.replace("${this.escapeJsString(meta.redirectUrl)}");</script>`;

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${this.escapeHtml(meta.title)}</title>
    <link rel="canonical" href="${this.escapeHtml(meta.joinUrl)}" />
    <meta property="og:title" content="${this.escapeHtml(meta.title)}" />
    <meta property="og:description" content="${this.escapeHtml(meta.description)}" />
    <meta property="og:image" content="${this.escapeHtml(meta.image)}" />
    <meta property="og:url" content="${this.escapeHtml(meta.joinUrl)}" />
    <meta property="og:type" content="website" />
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
      <h1>${this.escapeHtml(meta.title)}</h1>
      <p>${this.escapeHtml(meta.description)}</p>
      <div class="pill">Lobby code: ${this.escapeHtml(joinId)}</div>
      <p style="margin-top: 1rem;"><a href="${this.escapeHtml(meta.redirectUrl)}">Open lobby</a></p>
    </main>
    ${redirectScript}
  </body>
</html>`;
  }
}

export type { ExternalGameInfo, PreviewMeta };
