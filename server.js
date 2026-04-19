import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;
const ATP_SCOREBOARD_URL =
  "https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard";

app.use(cors());

app.get("/", (_req, res) => {
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

function buildScoreLine(a, b) {
  const setsA = Array.isArray(a?.linescores)
    ? a.linescores.map((s) => String(s?.value ?? "0"))
    : [];
  const setsB = Array.isArray(b?.linescores)
    ? b.linescores.map((s) => String(s?.value ?? "0"))
    : [];

  const setSummary =
    setsA.length && setsB.length
      ? setsA.map((value, index) => `${value}-${setsB[index] ?? "0"}`).join(" ")
      : "";

  return setSummary || "0-0";
}

function normalizeCompetition(event, grouping, competition) {
  const competitors = Array.isArray(competition?.competitors)
    ? competition.competitors
    : [];

  const a = competitors[0] || {};
  const b = competitors[1] || {};

  const playerA = pickPlayerName(a, "Player A");
  const playerB = pickPlayerName(b, "Player B");

  const typeSlug = String(
    competition?.type?.slug ||
    grouping?.grouping?.slug ||
    ""
  ).toLowerCase();

  const typeText = String(
    competition?.type?.text ||
    grouping?.grouping?.displayName ||
    ""
  ).toLowerCase();

  const category =
    typeSlug.includes("double") || typeText.includes("double")
      ? "doubles"
      : "singles";

  return {
    id: competition?.id || `${event?.id || "event"}-${playerA}-${playerB}`,
    tournament:
      event?.name ||
      event?.shortName ||
      "ATP",
    playerA,
    playerB,
    scoreLine: buildScoreLine(a, b),
    status:
      competition?.status?.type?.shortDetail ||
      competition?.status?.type?.description ||
      event?.status?.type?.shortDetail ||
      event?.status?.type?.description ||
      "Scheduled",
    category,
    round: competition?.round?.displayName || "",
    court: competition?.venue?.court || ""
  };
}

app.get("/api/atp", async (_req, res) => {
  try {
    const upstream = await fetch(ATP_SCOREBOARD_URL);

    if (!upstream.ok) {
      return res.status(502).json({
        error: `ESPN fetch failed with status ${upstream.status}`
      });
    }

    const raw = await upstream.json();
    const events = Array.isArray(raw?.events) ? raw.events : [];

    const allMatches = events.flatMap((event) => {
      const groupings = Array.isArray(event?.groupings) ? event.groupings : [];

      return groupings.flatMap((grouping) => {
        const competitions = Array.isArray(grouping?.competitions)
          ? grouping.competitions
          : [];

        return competitions.map((competition) =>
          normalizeCompetition(event, grouping, competition)
        );
      });
    });

    const singles = allMatches
      .filter((m) => m.category === "singles")
      .map(({ category, ...rest }) => rest);

    const doubles = allMatches
      .filter((m) => m.category === "doubles")
      .map(({ category, ...rest }) => rest);

    return res.json({
      updatedAt: new Date().toISOString(),
      count: allMatches.length,
      singles,
      doubles
    });
  } catch (error) {
    return res.status(500).json({
      error: String(error)
    });
  }
});

app.get("/api/atp-debug", async (_req, res) => {
  try {
    const upstream = await fetch(ATP_SCOREBOARD_URL);

    if (!upstream.ok) {
      return res.status(502).json({
        error: `ESPN fetch failed with status ${upstream.status}`
      });
    }

    const raw = await upstream.json();
    const firstEvent = Array.isArray(raw?.events) ? raw.events[0] : null;
    const firstGrouping = firstEvent?.groupings?.[0] || null;
    const firstCompetition = firstGrouping?.competitions?.[0] || null;

    return res.json({
      firstEventName: firstEvent?.name || null,
      firstGroupingName: firstGrouping?.grouping?.displayName || null,
      firstCompetition
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
