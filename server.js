import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

app.get("/", (req, res) => {
  res.send("Tennis Mode backend running");
});

function normalizeAtpEvent(event) {
  const competition = event?.competitions?.[0];
  const competitors = competition?.competitors || [];
  const a = competitors[0] || {};
  const b = competitors[1] || {};

  const setsA = Array.isArray(a?.linescores)
    ? a.linescores.map((s) => String(s?.value ?? "0"))
    : [];
  const setsB = Array.isArray(b?.linescores)
    ? b.linescores.map((s) => String(s?.value ?? "0"))
    : [];

  const currentA = a?.score != null ? String(a.score) : "0";
  const currentB = b?.score != null ? String(b.score) : "0";

  const status =
    competition?.status?.type?.shortDetail ||
    competition?.status?.type?.description ||
    event?.status?.type?.shortDetail ||
    event?.status?.type?.description ||
    "Scheduled";

  const tournament =
    event?.name ||
    competition?.name ||
    event?.shortName ||
    "ATP";

  const playerA =
    a?.athlete?.displayName ||
    a?.displayName ||
    "Player A";

  const playerB =
    b?.athlete?.displayName ||
    b?.displayName ||
    "Player B";

  const setSummary =
    setsA.length && setsB.length
      ? setsA.map((value, index) => `${value}-${setsB[index] ?? "0"}`).join(" ")
      : "";

  const scoreLine = setSummary
    ? `${setSummary} ${currentA}-${currentB}`.trim()
    : `${currentA}-${currentB}`;

  return {
    id: event?.id || `${playerA}-${playerB}`,
    tournament,
    playerA,
    playerB,
    scoreLine,
    status
  };
}

app.get("/api/atp", async (req, res) => {
  try {
    const upstream = await fetch(
      "https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard"
    );

    if (!upstream.ok) {
      return res.status(502).json({
        error: `ESPN fetch failed with status ${upstream.status}`
      });
    }

    const raw = await upstream.json();
    const events = Array.isArray(raw?.events) ? raw.events : [];

    const matches = events.map(normalizeAtpEvent);

    return res.json({
      updatedAt: new Date().toISOString(),
      count: matches.length,
      matches
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
