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

// ─── DISCIPLINE + TOUR CLASSIFICATION ────────────────────────────────────────
// Derive tour AND discipline from competition/grouping metadata.
// NOT from which endpoint the match came from — the WTA endpoint can contain
// men's matches and vice versa.
//
// Priority order:
//   1. Exact slug match  (competition.type.slug, grouping.grouping.slug)
//   2. Exact text match  (competition.type.text, grouping.grouping.displayName)
//   3. Loose substring fallback  (only when explicit fields are absent/unrecognised)
//
// Returns: "atpSingles" | "atpDoubles" | "wtaSingles" | "wtaDoubles" | null
// null = cannot classify safely → caller skips the competition entirely.
function classifyCompetition(grouping, competition) {
  // ── Step 1: exact slug mapping ───────────────────────────────────────────────
  // ESPN slugs are machine-generated identifiers — most reliable signal.
  const slugs = [
    competition?.type?.slug,
    grouping?.grouping?.slug,
    competition?.type?.abbreviation,
  ].map((s) => String(s || "").toLowerCase().trim());

  for (const slug of slugs) {
    if (slug === "mens-singles"   || slug === "ms") return "atpSingles";
    if (slug === "mens-doubles"   || slug === "md") return "atpDoubles";
    if (slug === "womens-singles" || slug === "ws") return "wtaSingles";
    if (slug === "womens-doubles" || slug === "wd") return "wtaDoubles";
    if (slug === "mixed-doubles"  || slug === "mx") return null; // skip mixed
  }

  // ── Step 2: exact display-text mapping ───────────────────────────────────────
  // ESPN displayName / type.text values are human-readable but well-known strings.
  const texts = [
    competition?.type?.text,
    grouping?.grouping?.displayName,
  ].map((s) => String(s || "").toLowerCase().trim());

  for (const text of texts) {
    if (text === "men's singles"   || text === "mens singles")   return "atpSingles";
    if (text === "men's doubles"   || text === "mens doubles")   return "atpDoubles";
    if (text === "women's singles" || text === "womens singles") return "wtaSingles";
    if (text === "women's doubles" || text === "womens doubles") return "wtaDoubles";
    if (text === "mixed doubles")                                return null;
  }

  // ── Step 3: loose substring fallback ─────────────────────────────────────────
  // Only reached when ESPN provides non-standard slug/text values.
  // Gender check: "men" must be present WITHOUT "women" as a prefix/substring
  // (i.e. "womens-singles" contains "men" but also "women" → isWomens wins).
  const allSources = [...slugs, ...texts];
  const isMens   = allSources.some((s) => s.includes("men") && !s.includes("women"));
  const isWomens = allSources.some((s) => s.includes("women") || s.includes("wta"));
  const isDoubles = allSources.some((s) => s.includes("double"));

  if (isWomens && !isMens) return isDoubles ? "wtaDoubles"  : "wtaSingles";
  if (isMens  && !isWomens) return isDoubles ? "atpDoubles" : "atpSingles";

  // Ambiguous or no gender signal — skip rather than contaminate a bucket.
  return null;
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
function normalizeCompetition(event, grouping, competition) {
  const competitors = Array.isArray(competition?.competitors) ? competition.competitors : [];
  const a = competitors[0] || {};
  const b = competitors[1] || {};

  const compA = extractCompetitorDetail(a);
  const compB = extractCompetitorDetail(b);

  // Classify tour + discipline from competition metadata (not endpoint URL).
  // Returns "atpSingles" | "atpDoubles" | "wtaSingles" | "wtaDoubles" | null.
  const bucket = classifyCompetition(grouping, competition);
  if (!bucket) return null;  // unclassifiable — caller skips this competition

  const tour       = bucket.startsWith("atp") ? "ATP" : "WTA";
  const discipline = bucket.endsWith("Singles") ? "singles" : "doubles";

  let statusNorm = normalizeStatus(competition?.status || event?.status);

  // ── Stale-live detection ────────────────────────────────────────────────────
  // ESPN sometimes keeps state:"in" after a match finishes (stale scrape).
  // Two independent rules, applied in order. Either alone is sufficient to
  // override statusNorm "live" → "final".
  if (statusNorm === "live" || statusNorm === "suspended") {

    // Rule 1 — winner flag (most reliable)
    // ESPN sets competitor.winner=true on the winning player immediately when
    // the match ends, even when the state field hasn't been updated yet.
    // A genuinely live match never has winner:true on any competitor.
    const hasWinner = competitors.some((c) => c?.winner === true);
    if (hasWinner) {
      statusNorm = "final";
    } else {
      // Rule 2 — old start time + complete linescore context (conservative fallback)
      // Only fires when winner flag is absent on a stale ESPN record.
      //
      // Conditions (ALL must be true to avoid false-positives on real matches):
      //   A. Match started more than 4 hours ago  — a real singles match is
      //      never longer than ~4h; tiebreaks last minutes, not hours.
      //      4h is conservative: suspended matches can age too, but they
      //      would need all three conditions simultaneously.
      //   B. Both competitors have at least 2 linescore entries — means at
      //      least 2 sets have been scored, so this isn't a pre-match stale record.
      //   C. At least one competitor's total set wins ≥ 2 — confirms enough sets
      //      were actually played to constitute a completed singles match.
      //      (Doubles can finish in 2 sets, singles needs 2 to have a winner.)
      //
      // What this does NOT break:
      //   - A real live tiebreak: started < 4 hours ago, so condition A fails.
      //   - A real live 5th set: started < 4 hours ago in most cases; even if
      //     borderline, condition C (set wins ≥ 2) is the same for live and stale.
      //   - A suspended match from today: started < 4 hours ago → A fails.
      //   - A suspended match from yesterday: A passes, but these are legitimate
      //     stale-live records that SHOULD be overridden to final anyway since
      //     a match suspended >4h with no winner flag is almost certainly done.
      const startDate = competition?.date || event?.date;
      const ageMs = startDate ? (Date.now() - new Date(startDate).getTime()) : 0;
      const oldEnough = ageMs > 4 * 60 * 60 * 1000; // 4 hours in ms

      if (oldEnough) {
        const linesA = Array.isArray(a?.linescores) ? a.linescores : [];
        const linesB = Array.isArray(b?.linescores) ? b.linescores : [];
        const hasSufficientSets = linesA.length >= 2 && linesB.length >= 2;

        if (hasSufficientSets) {
          // Count set wins: a competitor wins a set when their linescore value
          // is strictly greater than the opponent's for that set index.
          const setWinsA = linesA.filter((s, i) => (s?.value ?? s ?? 0) > (linesB[i]?.value ?? linesB[i] ?? 0)).length;
          const setWinsB = linesB.filter((s, i) => (s?.value ?? s ?? 0) > (linesA[i]?.value ?? linesA[i] ?? 0)).length;
          const maxSetWins = Math.max(setWinsA, setWinsB);

          // At least one player has won 2+ sets → match is complete
          if (maxSetWins >= 2) {
            statusNorm = "final";
          }
        }
      }
    }
  }

  const scheduledAt = competition?.date || event?.date || null;

  return {
    id: competition?.id || `${event?.id || "ev"}-${compA.displayName}-${compB.displayName}`,
    tour,
    discipline,
    tournament: event?.name || event?.shortName || tour,
    playerA: compA.displayName,
    playerB: compB.displayName,
    competitorA: compA,
    competitorB: compB,
    scoreLine: buildScoreLine(a, b),
    statusNorm,
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
// Fetches one ESPN endpoint and normalizes all competitions.
// Tour/discipline are derived from competition metadata, not the URL.
// Competitions that cannot be classified are silently skipped (null filter).
async function fetchTour(url) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(25000) });
  if (!resp.ok) throw new Error(`ESPN fetch failed: ${resp.status} for ${url}`);
  const raw = await resp.json();
  const events = Array.isArray(raw?.events) ? raw.events : [];
  return events.flatMap((event) => {
    const groupings = Array.isArray(event?.groupings) ? event.groupings : [];
    return groupings.flatMap((grouping) => {
      const competitions = Array.isArray(grouping?.competitions) ? grouping.competitions : [];
      return competitions
        .map((comp) => normalizeCompetition(event, grouping, comp))
        .filter((m) => m !== null);  // drop unclassifiable competitions
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
    // Fetch both endpoints in parallel. Tour/discipline come from metadata, not URL.
    // We fetch both URLs to maximise coverage — some tournaments appear on both.
    // Deduplication by competition.id prevents double-counting.
    const [atpResult, wtaResult] = await Promise.allSettled([
      fetchTour(ESPN_ATP_URL),
      fetchTour(ESPN_WTA_URL),
    ]);

    const atpRaw = atpResult.status === "fulfilled" ? atpResult.value : [];
    const wtaRaw = wtaResult.status === "fulfilled" ? wtaResult.value : [];
    const atpErr = atpResult.status === "rejected" ? String(atpResult.reason) : null;
    const wtaErr = wtaResult.status === "rejected" ? String(wtaResult.reason) : null;

    // Merge and deduplicate by competition id
    const seen = new Set();
    const all = [];
    for (const m of [...atpRaw, ...wtaRaw]) {
      if (!seen.has(m.id)) { seen.add(m.id); all.push(m); }
    }

    // Split into 4 buckets using tour+discipline fields derived from metadata
    const atpSingles = sortMatches(all.filter((m) => m.tour === "ATP" && m.discipline === "singles"));
    const atpDoubles = sortMatches(all.filter((m) => m.tour === "ATP" && m.discipline === "doubles"));
    const wtaSingles = sortMatches(all.filter((m) => m.tour === "WTA" && m.discipline === "singles"));
    const wtaDoubles = sortMatches(all.filter((m) => m.tour === "WTA" && m.discipline === "doubles"));

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
app.get("/api/atp", async (_req, res) => {
  try {
    const all = await fetchTour(ESPN_ATP_URL);
    const singles = sortMatches(all.filter((m) => m.tour === "ATP" && m.discipline === "singles"));
    const doubles = sortMatches(all.filter((m) => m.tour === "ATP" && m.discipline === "doubles"));
    return res.json({
      updatedAt: new Date().toISOString(),
      count: singles.length + doubles.length,
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
