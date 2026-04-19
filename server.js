import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;
const ATP_SCOREBOARD_URL =
  "https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard";

app.use(cors());

app.get("/", (req, res) => {
  res.send("Tennis Mode backend running");
});

function pickPlayerName(competitor, fallback) {
  return (
    competitor?.athlete?.displayName ||
    competitor?.displayName ||
    competitor?.athlete?.shortName ||
    competitor?.shortName ||
    competitor?.athlete?.name ||
    competitor?.name ||
    competitor?.athlete?.fullName ||
    competitor?.fullName ||
    fallback
  );
}

function parsePlayersFromEventName(eventName) {
  if (typeof eventName !== "string") {
    return { playerA: null, playerB: null };
  }

  if (eventName.includes(" vs ")) {
    const parts = eventName.split(" vs ").map((s) => s.trim());
    return {
      playerA: parts[0] || null,
      playerB: parts[1] || null
    };
  }

  return { playerA: null, playerB: null };
}

function buildScoreLine(a, b) {
  const setsA = Array.isArray(a?.linescores)
    ? a.linescores.map((s) => String(s?.value ?? "0"))
    : [];
  const setsB = Array.isArray(b?.linescores)
    ? b.linescores.map((s) => String(s?.value ?? "0"))
    : [];

  const currentA = a?.score != null ? String(a.score) : "0";
  const currentB = b?.score != null ? String(b.score) : "0";

  const setSummary =
    setsA.length && setsB.length
      ? setsA.map((value, index) => `${value}-${setsB[index] ?? "0"}`).join(" ")
      : "";

  return setSummary
    ? `${setSummary} ${currentA}-${currentB}`.trim()
    : `${currentA}-${currentB}`;
}

function pickStatus(event, competition) {
  return (
    competition?.status?.type?.shortDetail ||
    competition?.status?.type?.description ||
    event?.status?.type?.shortDetail ||
    event?.status?.type?.description ||
    "Scheduled"
  );
}

function pickTournament(event, competition) {
  return (
    event?.name ||
    competition?.name ||
    event?.shortName ||
    "ATP"
  );
}

function isLikelyDoubles(playerA, playerB, competition) {
  const a = String(playerA || "");
  const b = String(playerB || "");

  if (a.includes("/") || b.includes("/")) {
    return true;
  }

  const compType = String(
    competition?.type?.abbreviation ||
    competition?.type?.description ||
    ""
  ).toLowerCase();

  if (compType.includes("double")) {
    return true;
  }

  return false;
}

function normalizeAtpEvent(event) {
  const competition = event?.competitions?.[0];
  const competitors = competition?.competitors || [];
  const a = competitors[0] || {};
  const b = competitors[1] || {};

  let playerA = pickPlayerName(a, "Player A");
  let playerB = pickPlayerName(b, "Player B");

  const parsed = parsePlayersFromEventName(event?.shortName || event?.name);

  if (playerA === "Player A" && parsed.playerA) {
    playerA = parsed.playerA;
  }

  if (playerB === "Player B" && parsed.playerB) {
    playerB = parsed.playerB;
  }

  const normalized = {
    id: event?.id || `${playerA}-${playerB}`,
    tournament: pickTournament(event, competition),
    playerA,
    playerB,
    scoreLine: buildScoreLine(a, b),
    status: pickStatus(event, competition)
  };

  return {
    ...normalized,
    category: isLikelyDoubles(playerA, playerB, competition) ? "doubles" : "singles"
  };
}

app.get("/api/atp", async (req, res) => {
  try {
    const upstream = await fetch(ATP_SCOREBOARD_URL);

    if (!upstream.ok) {
      return res.status(502).json({
        error: `ESPN fetch failed with status ${upstream.status}`
      });
    }

    const raw = await upstream.json();
    const events = Array.isArray(raw?.events) ? raw.events : [];
    const normalized = events.map(normalizeAtpEvent);

    const singles = normalized
      .filter((m) => m.category === "singles")
      .map(({ category, ...rest }) => rest);

    const doubles = normalized
      .filter((m) => m.category === "doubles")
      .map(({ category, ...rest }) => rest);

    return res.json({
      updatedAt: new Date().toISOString(),
      count: normalized.length,
      singles,
      doubles
    });
  } catch (error) {
    return res.status(500).json({
      error: String(error)
    });
  }
});

app.get("/api/atp-debug", async (req, res) => {
  try {
    const upstream = await fetch(ATP_SCOREBOARD_URL);

    if (!upstream.ok) {
      return res.status(502).json({
        error: `ESPN fetch failed with status ${upstream.status}`
      });
    }

    const raw = await upstream.json();
    const firstEvent = Array.isArray(raw?.events) ? raw.events[0] : null;

    return res.json({
      firstEvent
    });
  } catch (error) {
    return res.status(500).json({
      error: String(error)
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
