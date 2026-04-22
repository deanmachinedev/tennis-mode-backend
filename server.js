import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

const ESPN_ATP_URL = "https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard";
const ESPN_WTA_URL = "https://site.api.espn.com/apis/site/v2/sports/tennis/wta/scoreboard";

app.use(cors());

app.get("/", (_req, res) => {
  res.send("Tennis Mode backend running — /api/tennis for ATP+WTA, /api/atp for legacy");
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function pickPlayerName(competitor, fallback) {
  // Singles: competitor.athlete.displayName is the player
  // Doubles: ESPN may use competitor.displayName (team name "Granollers/Zeballos"),
  //          or competitor.athletes[] with one entry per team member.
  //          Try every possible location before falling back.
  const teamDisplay =
    // Doubles team name in displayName (most common: "Granollers/Zeballos")
    competitor?.displayName ||
    // Individual athlete object
    competitor?.athlete?.displayName ||
    competitor?.athlete?.shortName ||
    competitor?.athlete?.fullName ||
    competitor?.athlete?.name ||
    // Doubles team: athletes[] array — join both names with "/"
    (Array.isArray(competitor?.athletes) && competitor.athletes.length > 0
      ? competitor.athletes.map((a) => a?.shortName || a?.displayName || a?.name || "").filter(Boolean).join("/")
      : null) ||
    competitor?.shortName ||
    competitor?.name ||
    competitor?.fullName;
  return teamDisplay || fallback;
}

function buildScoreLine(a, b) {
  const setsA = Array.isArray(a?.linescores) ? a.linescores.map((s) => String(s?.value ?? "0")) : [];
  const setsB = Array.isArray(b?.linescores) ? b.linescores.map((s) => String(s?.value ?? "0")) : [];
  if (setsA.length && setsB.length) {
    return setsA.map((v, i) => `${v}-${setsB[i] ?? "0"}`).join(" ");
  }
  return "0-0";
}

// ─── STATUS NORMALIZATION ─────────────────────────────────────────────────────
// Priority order (most authoritative first):
//   1. completed:true  — ESPN boolean, always means the match is over
//   2. state:"post"    — authoritative completion signal
//   3. state:"in"      — in progress, but check for suspension/delay FIRST
//   4. state:"pre"     — scheduled/upcoming
//   5. fallback string matching — for when state field is missing/empty
//
// Returns one of: "live" | "suspended" | "scheduled" | "final" | "retired"
//                 "walkover" | "postponed" | "cancelled" | "unknown"
function normalizeStatus(statusObj) {
  const type = statusObj?.type || {};
  const state = (type.state || "").toLowerCase();
  const desc  = (type.description || "").toLowerCase();
  const detail = (type.detail || type.shortDetail || "").toLowerCase();
  const name   = (type.name || "").toLowerCase();
  // completed is a JSON boolean — use loose check to catch "true" string edge cases
  // eslint-disable-next-line eqeqeq
  const completed = type.completed === true || type.completed == "true";

  // ── 1. completed:true always wins — even if state:"in" is stale ──────────────
  // This is the tiebreak-match fix: ESPN sometimes serves state:"in" for a match
  // that completed during a tiebreak because the scoreboard data is stale.
  // completed:true is set server-side and is more reliable than state.
  if (completed) {
    if (desc.includes("retired")  || detail.includes("retired"))  return "retired";
    if (desc.includes("walkover") || detail.includes("walkover") || desc.includes("w/o")) return "walkover";
    if (desc.includes("postponed") || detail.includes("postponed")) return "postponed";
    if (desc.includes("cancelled") || detail.includes("cancelled")) return "cancelled";
    // Any completed match not matching the above is "final" — including tiebreaks
    return "final";
  }

  // ── 2. state:"post" — match is over ──────────────────────────────────────────
  if (state === "post") {
    if (desc.includes("retired")  || detail.includes("retired"))  return "retired";
    if (desc.includes("walkover") || detail.includes("walkover") || desc.includes("w/o")) return "walkover";
    if (desc.includes("postponed") || detail.includes("postponed")) return "postponed";
    if (desc.includes("cancelled") || detail.includes("cancelled")) return "cancelled";
    if (desc.includes("suspended") || detail.includes("suspended")) return "suspended";
    return "final";
  }

  // ── 3. state:"in" — match is active, but may be suspended ───────────────────
  // Suspended matches have state:"in" (still counted as in-progress by ESPN)
  // but description/name/shortDetail contains suspension indicators.
  if (state === "in") {
    if (
      desc.includes("suspend") || detail.includes("suspend") || name.includes("suspend") ||
      desc.includes("rain delay") || detail.includes("rain delay") || name.includes("rain") ||
      desc.includes("delay") || name.includes("delay")
    ) return "suspended";
    return "live";
  }

  // ── 4. state:"pre" — upcoming ────────────────────────────────────────────────
  if (state === "pre") return "scheduled";

  // ── 5. Fallback: state field is missing or empty — infer from strings ─────────
  // This covers ESPN edge cases where state is not populated.
  // Check completion signals first to avoid the tiebreak false-positive:
  if (desc.includes("final") && !desc.includes("semifinal") && !desc.includes("quarterfinal")) return "final";
  if (desc.includes("retired")) return "retired";
  if (desc.includes("postponed") || detail.includes("postponed")) return "postponed";
  if (desc.includes("suspended") || detail.includes("suspended") || name.includes("suspend")) return "suspended";
  if (desc.includes("in progress") || desc.includes("playing")) return "live";
  // Ordinal set indicators (e.g. shortDetail:"2nd") — only when not completed
  if (/^\d+(st|nd|rd|th)$/.test(detail.trim())) return "live";
  if (detail.includes("set") || detail.includes("tiebreak")) return "live";
  if (desc.includes("scheduled") || desc.includes("tbd")) return "scheduled";
  return "unknown";
}

// ─── DISCIPLINE CLASSIFICATION ────────────────────────────────────────────────
// Uses grouping slug and competition type slug — more reliable than text matching
function classifyDiscipline(grouping, competition) {
  const sources = [
    competition?.type?.slug,
    grouping?.grouping?.slug,
    competition?.type?.text,
    grouping?.grouping?.displayName,
    competition?.type?.abbreviation,
  ].map((s) => String(s || "").toLowerCase());

  return sources.some((s) => s.includes("double")) ? "doubles" : "singles";
}

// ─── MATCH NOTES ─────────────────────────────────────────────────────────────
// ESPN provides notes arrays and situation.lastPlay for live commentary
function extractNotes(competition) {
  const notes = [];
  const state = (competition?.status?.type?.state || "").toLowerCase();
  const isLive = state === "in";

  // competition.notes array — always include
  const noteArr = Array.isArray(competition?.notes) ? competition.notes : [];
  for (const n of noteArr) {
    const text = n?.text || n?.headline || "";
    if (text) notes.push(text);
  }

  // situation.lastPlay.text — live commentary, live matches only
  if (isLive) {
    const lastPlay = competition?.situation?.lastPlay?.text || "";
    if (lastPlay && !notes.includes(lastPlay)) notes.push(lastPlay);
  }

  // status type detail as a note ONLY for live matches.
  // For scheduled matches, detail is the start date/time, which is already
  // present as scheduledAt and would produce a duplicate line if added here.
  // For final/retired matches, detail just repeats "Final"/"Retired".
  if (isLive) {
    const detail = competition?.status?.type?.detail || "";
    if (detail && detail.toLowerCase() !== "scheduled" && detail.toLowerCase() !== "final") {
      if (!notes.some((n) => n.includes(detail))) notes.push(detail);
    }
  }

  return notes.slice(0, 2); // cap at 2 notes for display
}

// ─── COMPETITOR DETAIL ────────────────────────────────────────────────────────
function extractCompetitorDetail(competitor) {
  const ath = competitor?.athlete || {};
  return {
    id: ath.id || competitor?.id || "",
    displayName: pickPlayerName(competitor, "Unknown"),
    shortName: ath.shortName || "",
    country: ath.country?.name || ath.flag?.alt || "",
    countryCode: ath.country?.id || "",
    headshot: ath.headshot?.href || "",
    ranking: competitor?.records?.[0]?.summary || "",
    winner: competitor?.winner === true,
    score: competitor?.score || "",
    linescores: Array.isArray(competitor?.linescores)
      ? competitor.linescores.map((s) => s?.value ?? 0)
      : [],
  };
}

// ─── CORE TRANSFORM ──────────────────────────────────────────────────────────
function normalizeCompetition(event, grouping, competition, tour) {
  const competitors = Array.isArray(competition?.competitors) ? competition.competitors : [];
  const a = competitors[0] || {};
  const b = competitors[1] || {};

  const compA = extractCompetitorDetail(a);
  const compB = extractCompetitorDetail(b);
  const discipline = classifyDiscipline(grouping, competition);
  const statusNorm = normalizeStatus(competition?.status || event?.status);

  // Scheduled date — use competition date first, then event date
  const scheduledAt = competition?.date || event?.date || null;

  return {
    id: competition?.id || `${event?.id || "ev"}-${compA.displayName}-${compB.displayName}`,
    tour,           // "ATP" or "WTA"
    discipline,     // "singles" or "doubles"
    tournament: event?.name || event?.shortName || tour,
    playerA: compA.displayName,
    playerB: compB.displayName,
    competitorA: compA,
    competitorB: compB,
    scoreLine: buildScoreLine(a, b),
    // Authoritative normalized status — use this in frontend, not string guessing
    statusNorm,     // "live" | "scheduled" | "final" | "retired" | "walkover" | "postponed" | "suspended" | "cancelled" | "unknown"
    // Raw ESPN fields — kept for detail display
    status: competition?.status?.type?.shortDetail || competition?.status?.type?.description || "Scheduled",
    statusDetail: competition?.status?.type?.detail || competition?.status?.type?.description || "",
    round: competition?.round?.displayName || "",
    court: competition?.venue?.court || competition?.venue?.fullName || "",
    scheduledAt,
    notes: extractNotes(competition),
    groupName: grouping?.grouping?.displayName || "",
  };
}

// ─── FETCH ONE TOUR ───────────────────────────────────────────────────────────
async function fetchTour(url, tour) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(25000) });
  if (!resp.ok) throw new Error(`ESPN ${tour} fetch failed: ${resp.status}`);
  const raw = await resp.json();
  const events = Array.isArray(raw?.events) ? raw.events : [];
  return events.flatMap((event) => {
    const groupings = Array.isArray(event?.groupings) ? event.groupings : [];
    return groupings.flatMap((grouping) => {
      const competitions = Array.isArray(grouping?.competitions) ? grouping.competitions : [];
      return competitions.map((comp) => normalizeCompetition(event, grouping, comp, tour));
    });
  });
}

// ─── SORT HELPERS ─────────────────────────────────────────────────────────────
// Canonical priority order: live first, then scheduled (chronological), then final/other
const STATUS_PRIORITY = { live: 0, scheduled: 1, final: 2, retired: 3, walkover: 3, postponed: 4, suspended: 4, cancelled: 5, unknown: 6 };

function sortMatches(matches) {
  return matches.slice().sort((a, b) => {
    const pa = STATUS_PRIORITY[a.statusNorm] ?? 6;
    const pb = STATUS_PRIORITY[b.statusNorm] ?? 6;
    if (pa !== pb) return pa - pb;
    // For scheduled: sort by scheduledAt ascending
    if (a.statusNorm === "scheduled" && b.statusNorm === "scheduled") {
      const ta = a.scheduledAt ? new Date(a.scheduledAt).getTime() : Infinity;
      const tb = b.scheduledAt ? new Date(b.scheduledAt).getTime() : Infinity;
      return ta - tb;
    }
    return 0;
  });
}

// ─── /api/tennis — primary endpoint ──────────────────────────────────────────
app.get("/api/tennis", async (_req, res) => {
  try {
    const [atpAll, wtaAll] = await Promise.allSettled([
      fetchTour(ESPN_ATP_URL, "ATP"),
      fetchTour(ESPN_WTA_URL, "WTA"),
    ]);

    const atp = atpAll.status === "fulfilled" ? atpAll.value : [];
    const wta = wtaAll.status === "fulfilled" ? wtaAll.value : [];
    const atpErr = atpAll.status === "rejected" ? String(atpAll.reason) : null;
    const wtaErr = wtaAll.status === "rejected" ? String(wtaAll.reason) : null;

    const atpSingles = sortMatches(atp.filter((m) => m.discipline === "singles"));
    const atpDoubles = sortMatches(atp.filter((m) => m.discipline === "doubles"));
    const wtaSingles = sortMatches(wta.filter((m) => m.discipline === "singles"));
    const wtaDoubles = sortMatches(wta.filter((m) => m.discipline === "doubles"));

    return res.json({
      updatedAt: new Date().toISOString(),
      errors: { atp: atpErr, wta: wtaErr },
      counts: {
        atpSingles: atpSingles.length,
        atpDoubles: atpDoubles.length,
        wtaSingles: wtaSingles.length,
        wtaDoubles: wtaDoubles.length,
      },
      atpSingles,
      atpDoubles,
      wtaSingles,
      wtaDoubles,
    });
  } catch (error) {
    return res.status(500).json({ error: String(error) });
  }
});

// ─── /api/atp — legacy compatibility ─────────────────────────────────────────
// Keeps working for any client still hitting the old endpoint.
// Returns { singles, doubles } shaped from ATP data only.
app.get("/api/atp", async (_req, res) => {
  try {
    const atp = await fetchTour(ESPN_ATP_URL, "ATP");
    const singles = sortMatches(atp.filter((m) => m.discipline === "singles"));
    const doubles = sortMatches(atp.filter((m) => m.discipline === "doubles"));
    return res.json({
      updatedAt: new Date().toISOString(),
      count: atp.length,
      singles,
      doubles,
    });
  } catch (error) {
    return res.status(500).json({ error: String(error) });
  }
});

// ─── /api/debug — raw ESPN first competition for schema inspection ─────────────
app.get("/api/debug", async (_req, res) => {
  try {
    const tour = (String(res.req?.query?.tour || "atp")).toLowerCase() === "wta" ? "WTA" : "ATP";
    const url = tour === "WTA" ? ESPN_WTA_URL : ESPN_ATP_URL;
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) return res.status(502).json({ error: `ESPN ${resp.status}` });
    const raw = await resp.json();
    const firstEvent = Array.isArray(raw?.events) ? raw.events[0] : null;
    const firstGrouping = firstEvent?.groupings?.[0] || null;
    const firstComp = firstGrouping?.competitions?.[0] || null;
    return res.json({
      tour,
      firstEventName: firstEvent?.name,
      firstEventStatus: firstEvent?.status?.type,
      firstGroupingName: firstGrouping?.grouping,
      firstCompStatus: firstComp?.status?.type,
      firstCompType: firstComp?.type,
      firstComp,
    });
  } catch (error) {
    return res.status(500).json({ error: String(error) });
  }
});

app.listen(PORT, () => {
  console.log(`Tennis Mode backend running on port ${PORT}`);
  console.log(`  GET /api/tennis  — ATP + WTA combined`);
  console.log(`  GET /api/atp     — ATP only (legacy)`);
  console.log(`  GET /api/debug?tour=atp|wta — raw ESPN schema`);
});
