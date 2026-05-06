import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

const ESPN_ATP_URL = "https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard";
const ESPN_WTA_URL = "https://site.api.espn.com/apis/site/v2/sports/tennis/wta/scoreboard";

// Build date string YYYYMMDD for ESPN's ?dates= query param
function espnDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

// Format a date string into "Apr 22" style for display
function fmtDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

// Format a tournament date range from start/end ISO strings.
// Returns null if no usable dates. Labels with "(est)" when derived from match dates.
function fmtDateRange(start, end, derived) {
  const s = fmtDate(start);
  const e = fmtDate(end);
  if (!s && !e) return null;
  const suffix = derived ? " (est)" : "";
  if (!e || s === e) return `${s}${suffix}`;
  // Same month: "Apr 22 - 29"
  const sd = new Date(start); const ed = new Date(end);
  if (!isNaN(sd) && !isNaN(ed) && sd.getUTCMonth() === ed.getUTCMonth()) {
    return `${s} - ${ed.getUTCDate()}${suffix}`;
  }
  return `${s} - ${e}${suffix}`;
}

// ─── RANKINGS CACHE ───────────────────────────────────────────────────────────
// ESPN rankings endpoint returns singles and doubles categories in one response.
// Cache: 6 hours (rankings update weekly).
const RANKINGS_TTL_MS = 6 * 60 * 60 * 1000;
const rankingsCache = {
  atp: null, atpAt: 0,   // { singles: [...], doubles: [...] | null }
  wta: null, wtaAt: 0,
};

// Correct ESPN rankings URLs (confirmed working — not the /athletes endpoint which 404s)
const ESPN_ATP_RANKINGS = "https://site.web.api.espn.com/apis/site/v2/sports/tennis/atp/rankings?region=us&lang=en";
const ESPN_WTA_RANKINGS = "https://site.web.api.espn.com/apis/site/v2/sports/tennis/wta/rankings?region=us&lang=en";

// Parse one category from ESPN rankings response.
// ESPN response shape:
//   { rankings: [ { name: "ATP Singles", ranks: [ { current, athlete.displayName, points } ] } ] }
// Singles/doubles detected by name.toLowerCase() containing "singles" or "doubles".
// Returns null if the category entry is absent (doubles may not exist for all tours).
function parseRankingsCategory(raw, categoryType) {
  const list = Array.isArray(raw?.rankings) ? raw.rankings : [];
  const entry = list.find(r => {
    const n = (r?.name || r?.type || "").toLowerCase();
    return categoryType === "singles" ? n.includes("singles") : n.includes("doubles");
  });
  if (!entry) return null;   // category genuinely absent — not an error, just unavailable
  const ranks = Array.isArray(entry?.ranks) ? entry.ranks : [];
  if (ranks.length === 0) return null;
  return ranks.map((r, idx) => ({
    rank:   r?.current ?? r?.rank ?? (idx + 1),
    name:   r?.athlete?.displayName || r?.athlete?.fullName || r?.displayName || "Unknown",
    points: r?.points ?? r?.rankingPoints ?? null,
  })).filter(r => r.name !== "Unknown");
}

async function fetchRankings(tour) {
  const isWta  = tour === "WTA";
  const now    = Date.now();
  const key    = isWta ? "wta" : "atp";
  const atKey  = isWta ? "wtaAt" : "atpAt";
  const url    = isWta ? ESPN_WTA_RANKINGS : ESPN_ATP_RANKINGS;

  // Return cached if fresh
  if (rankingsCache[key] && (now - rankingsCache[atKey]) < RANKINGS_TTL_MS) {
    return { data: rankingsCache[key], cached: true, cachedAt: new Date(rankingsCache[atKey]).toISOString() };
  }

  console.log(`[rankings] Fetching ${tour}: ${url}`);
  const resp = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!resp.ok) {
    console.error(`[rankings] ${tour} fetch failed: HTTP ${resp.status} for ${url}`);
    throw new Error(`ESPN rankings HTTP ${resp.status} for ${url}`);
  }
  const raw = await resp.json();
  console.log(`[rankings] ${tour} raw categories: ${(raw?.rankings||[]).map(r=>r?.name).join(", ")}`);

  const singles = parseRankingsCategory(raw, "singles");
  const doubles = parseRankingsCategory(raw, "doubles");
  console.log(`[rankings] ${tour} singles=${singles?.length ?? "null"} doubles=${doubles?.length ?? "null"}`);

  const data = { singles, doubles };   // null means unavailable, [] would mean empty but present
  rankingsCache[key]  = data;
  rankingsCache[atKey] = now;
  return { data, cached: false, cachedAt: new Date(now).toISOString() };
}

// Fetch one ESPN endpoint with an optional date override
async function fetchTourUrl(url) {
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
        .filter((m) => m !== null);
    });
  });
}

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
  // ESPN sometimes keeps state:"in" / completed:false after a match ends.
  // Three independent rules, applied in order. First match wins.
  //
  // The specific failing payload (Kovacevic vs Echargui):
  //   state:"in", completed:false, recent:true, winner:false on both
  //   linescores: [4,6,6] vs [6,4,6] — 3rd set at 6-6 (tiebreak)
  //   note: "Kovacevic leads Echargui 6-4 4-6 6-6"
  //   No situation.server (tiebreak is over, not in progress)
  //
  if (statusNorm === "live" || statusNorm === "suspended") {

    // Rule 1 — winner flag (most reliable, catches most cases)
    // ESPN sets competitor.winner=true on the winning competitor when the match
    // ends. A genuinely live match never has winner:true on any competitor.
    const hasWinner = competitors.some((c) => c?.winner === true);
    if (hasWinner) {
      statusNorm = "final";
    } else {

      // Rule 2 — recent:false + sufficient linescore
      // ESPN's top-level competition.recent is false once the match is no longer
      // recent (i.e. settled). Combined with enough sets played and set wins, this
      // confirms the match is done.
      // Conditions (ALL required):
      //   A. competition.recent === false  (ESPN confirms not recent)
      //   B. Both competitors have ≥2 linescore entries  (≥2 sets played)
      //   C. One competitor has ≥2 set wins  (enough sets won to close the match)
      const isRecent  = competition?.recent === true || competition?.recent == null;
      const linesA = Array.isArray(a?.linescores) ? a.linescores : [];
      const linesB = Array.isArray(b?.linescores) ? b.linescores : [];
      const hasSets = linesA.length >= 2 && linesB.length >= 2;

      if (!isRecent && hasSets) {
        const setWinsA = linesA.filter((s, i) => (s?.value ?? s ?? 0) > (linesB[i]?.value ?? linesB[i] ?? 0)).length;
        const setWinsB = linesB.filter((s, i) => (s?.value ?? s ?? 0) > (linesA[i]?.value ?? linesA[i] ?? 0)).length;
        if (Math.max(setWinsA, setWinsB) >= 2) statusNorm = "final";
      }

      // Rule 3 — tied last set + no active tiebreak situation (catches Kovacevic case)
      // Applies when: recent:true, state:in, no winner flag, but the last set
      // score is tied at ≥6 (i.e. a tiebreak was in progress or just finished).
      // A LIVE tiebreak has competition.situation.server set (the server in the
      // tiebreak is tracked). A COMPLETED tiebreak has no situation.server.
      // Combined with recent:true and a tied-set score, this means the tiebreak
      // just ended but ESPN hasn't updated state yet.
      //
      // This rule is deliberately conservative — requires ALL of:
      //   A. Last set score is tied at ≥6 (tiebreak condition met for that set)
      //   B. No situation.server field (no in-progress tiebreak server)
      //   C. Both competitors have ≥2 linescore entries (not a pre-match record)
      //   D. The set count makes sense for a completed match (one player has ≥2 set wins
      //      counting a tiebreak set win for the tied set as belonging to whoever
      //      leads in total sets — but we don't need to award it; just having the
      //      other 2 sets be non-tied is sufficient)
      //
      // False-positive guard: a REAL live tiebreak in set 3 of a 2-1 match will
      // have situation.server set → Rule 3 does not fire.
      if (statusNorm === "live" && hasSets) {
        const lastIdxA = linesA.length - 1;
        const lastIdxB = linesB.length - 1;
        if (lastIdxA === lastIdxB && lastIdxA >= 1) {
          const lastA = linesA[lastIdxA]?.value ?? linesA[lastIdxA] ?? 0;
          const lastB = linesB[lastIdxB]?.value ?? linesB[lastIdxB] ?? 0;
          const lastSetTied = lastA === lastB && lastA >= 6;

          const hasActiveSituation = !!(
            competition?.situation?.server ||
            competition?.situation?.pointA != null ||
            competition?.situation?.pointB != null
          );

          if (lastSetTied && !hasActiveSituation) {
            // Count set wins from all sets EXCEPT the last (tied) one
            const setsExceptLast = linesA.slice(0, lastIdxA);
            const setWinsAExcl = setsExceptLast.filter(
              (s, i) => (s?.value ?? s ?? 0) > (linesB[i]?.value ?? linesB[i] ?? 0)
            ).length;
            const setWinsBExcl = setsExceptLast.filter(
              (s, i) => (linesB[i]?.value ?? linesB[i] ?? 0) > (s?.value ?? s ?? 0)
            ).length;
            // Either player leads the non-tied sets — one must be ahead ≥1
            // (in a 3-set match at 1-1 sets, the tied set IS the decider)
            // Just require that the non-tied sets are non-zero (real match played)
            const realMatchPlayed = setWinsAExcl + setWinsBExcl >= 1;

            if (realMatchPlayed) {
              statusNorm = "final";
            }
          }
        }
      }
    }
  }

  const scheduledAt   = competition?.date || event?.date || null;
  const eventStartAt  = event?.date || null;
  const eventEndAt    = event?.endDate || null;   // present when ESPN exposes full tournament dates

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
    eventStartAt,
    eventEndAt,
    notes: extractNotes(competition),
    groupName: grouping?.grouping?.displayName || "",
  };
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

// ─── FETCH WITH DATE RANGE ────────────────────────────────────────────────────
// ESPN scoreboard supports ?dates=YYYYMMDD for historical results.
// We fetch today + yesterday for both tours in parallel (4 requests total).
// All results are merged and deduplicated by competition id.
// This ensures yesterday's finals and recently completed matches are visible.
async function fetchAllDates(baseUrl) {
  const today     = espnDate(0);
  const yesterday = espnDate(-1);
  const [resT, resY] = await Promise.allSettled([
    fetchTourUrl(`${baseUrl}?dates=${today}`),
    fetchTourUrl(`${baseUrl}?dates=${yesterday}`),
  ]);
  const combined = [
    ...(resT.status === "fulfilled" ? resT.value : []),
    ...(resY.status === "fulfilled" ? resY.value : []),
  ];
  // Deduplicate by id within this tour's results
  const seen = new Set();
  return combined.filter((m) => { if (seen.has(m.id)) return false; seen.add(m.id); return true; });
}

// ─── /api/tennis — primary endpoint ──────────────────────────────────────────
app.get("/api/tennis", async (_req, res) => {
  try {
    // Fetch ATP and WTA for today + yesterday in parallel (4 total requests).
    // Yesterday's date ensures finals from completed tournaments are included.
    const [atpResult, wtaResult] = await Promise.allSettled([
      fetchAllDates(ESPN_ATP_URL),
      fetchAllDates(ESPN_WTA_URL),
    ]);

    const atpRaw = atpResult.status === "fulfilled" ? atpResult.value : [];
    const wtaRaw = wtaResult.status === "fulfilled" ? wtaResult.value : [];
    const atpErr = atpResult.status === "rejected" ? String(atpResult.reason) : null;
    const wtaErr = wtaResult.status === "rejected" ? String(wtaResult.reason) : null;

    // Global dedup across ATP + WTA payloads by competition id
    const seen = new Set();
    const all = [];
    for (const m of [...atpRaw, ...wtaRaw]) {
      if (!seen.has(m.id)) { seen.add(m.id); all.push(m); }
    }

    // Split into 4 buckets. Within each bucket sort by:
    //   1. Status priority (live → scheduled → final → other)
    //   2. Tournament name alphabetically (groups same tournament together)
    //   3. Scheduled time for scheduled matches
    const tournSort = (a, b) => {
      const ta = (a.tournament || "").toLowerCase();
      const tb = (b.tournament || "").toLowerCase();
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    };
    const fullSort = (matches) => sortMatches(matches).sort((a, b) => {
      // Only group by tournament within the same status bucket
      const pa = STATUS_PRIORITY[a.statusNorm] ?? 6;
      const pb = STATUS_PRIORITY[b.statusNorm] ?? 6;
      if (pa !== pb) return pa - pb;
      return tournSort(a, b);
    });

    const atpSingles = fullSort(all.filter((m) => m.tour === "ATP" && m.discipline === "singles"));
    const atpDoubles = fullSort(all.filter((m) => m.tour === "ATP" && m.discipline === "doubles"));
    const wtaSingles = fullSort(all.filter((m) => m.tour === "WTA" && m.discipline === "singles"));
    const wtaDoubles = fullSort(all.filter((m) => m.tour === "WTA" && m.discipline === "doubles"));

    return res.json({
      updatedAt: new Date().toISOString(),
      dates: { today: espnDate(0), yesterday: espnDate(-1) },
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

// ─── /api/tournaments — unique tournament names with status summary + dates ────
app.get("/api/tournaments", async (_req, res) => {
  try {
    const [atpResult, wtaResult] = await Promise.allSettled([
      fetchAllDates(ESPN_ATP_URL),
      fetchAllDates(ESPN_WTA_URL),
    ]);
    const all = [
      ...(atpResult.status === "fulfilled" ? atpResult.value : []),
      ...(wtaResult.status === "fulfilled" ? wtaResult.value : []),
    ];

    // Collect unique tournaments with counts per status and date tracking.
    // Date strategy:
    //   1. eventStartAt / eventEndAt — ESPN's own tournament-level date fields.
    //      If present these are the authoritative official tournament dates.
    //   2. If eventEndAt is absent, derive an estimated end from the latest
    //      individual match date (scheduledAt) in that tournament.
    //   3. If no dates at all, dateRange is null (omitted on front end).
    const map = new Map();
    for (const m of all) {
      const key = `${m.tour}::${m.tournament}`;
      if (!map.has(key)) {
        map.set(key, {
          tour: m.tour, name: m.tournament,
          live: 0, final: 0, scheduled: 0,
          // Official dates from ESPN event-level fields
          startAt: m.eventStartAt || null,
          endAt:   m.eventEndAt   || null,
          // Derived: min/max of individual match dates (fallback)
          minMatchDate: null, maxMatchDate: null,
          hasOfficialEnd: !!m.eventEndAt,
        });
      }
      const t = map.get(key);
      if (m.statusNorm === "live") t.live++;
      else if (["final","retired","walkover"].includes(m.statusNorm)) t.final++;
      else if (m.statusNorm === "scheduled") t.scheduled++;

      // Track per-tournament start (min) — use earlier of official start vs match date
      if (m.eventStartAt) {
        if (!t.startAt || m.eventStartAt < t.startAt) t.startAt = m.eventStartAt;
      }
      // Track latest official end
      if (m.eventEndAt && (!t.endAt || m.eventEndAt > t.endAt)) {
        t.endAt = m.eventEndAt;
        t.hasOfficialEnd = true;
      }
      // Track match-level date spread for fallback
      if (m.scheduledAt) {
        if (!t.minMatchDate || m.scheduledAt < t.minMatchDate) t.minMatchDate = m.scheduledAt;
        if (!t.maxMatchDate || m.scheduledAt > t.maxMatchDate) t.maxMatchDate = m.scheduledAt;
      }
    }

    const tournaments = [...map.values()].map(t => {
      // Resolve best available date range
      const start  = t.startAt || t.minMatchDate || null;
      const end    = t.endAt   || (t.hasOfficialEnd ? null : t.maxMatchDate) || null;
      const derived = !t.hasOfficialEnd;  // true = range estimated from match dates
      return {
        tour: t.tour, name: t.name,
        live: t.live, final: t.final, scheduled: t.scheduled,
        dateRange: fmtDateRange(start, end, derived),
        dateSource: t.hasOfficialEnd ? "espn" : (start ? "derived" : null),
      };
    }).sort((a, b) => {
      const score = t => (t.live > 0 ? 0 : t.scheduled > 0 ? 1 : 2);
      return score(a) - score(b) || a.name.localeCompare(b.name);
    });

    return res.json({ updatedAt: new Date().toISOString(), tournaments });
  } catch (error) {
    return res.status(500).json({ error: String(error) });
  }
});

// ─── /api/rankings — ATP or WTA rankings from ESPN rankings endpoint ──────────
// Returns { singles: [{rank, name, points}], doubles: [...] | null }
// doubles is null (not []) when ESPN doesn't expose it for that tour/category.
// Cache: 6 hours. Stale cache returned with warning on live fetch failure.
app.get("/api/rankings", async (req, res) => {
  const tour = String(req.query?.tour || "atp").toUpperCase() === "WTA" ? "WTA" : "ATP";
  try {
    const result = await fetchRankings(tour);
    return res.json({
      tour,
      updatedAt:  new Date().toISOString(),
      cachedAt:   result.cachedAt,
      fromCache:  result.cached,
      singles:    result.data.singles,    // [{rank, name, points}] or null
      doubles:    result.data.doubles,    // [{rank, name, points}] or null
      singlesCount: result.data.singles?.length ?? 0,
      doublesCount: result.data.doubles?.length ?? 0,
    });
  } catch (error) {
    // Return stale cache with warning if available
    const key = tour === "WTA" ? "wta" : "atp";
    if (rankingsCache[key]) {
      const atKey = tour === "WTA" ? "wtaAt" : "atpAt";
      return res.json({
        tour, updatedAt: new Date().toISOString(),
        cachedAt: new Date(rankingsCache[atKey]).toISOString(),
        fromCache: true, stale: true,
        singles:  rankingsCache[key].singles,
        doubles:  rankingsCache[key].doubles,
        warning:  `Live fetch failed: ${String(error)}. Showing stale data.`,
      });
    }
    // No cache — return explicit error so frontend can show "Rankings unavailable"
    console.error(`[rankings] ${tour} failed, no cache: ${String(error)}`);
    return res.status(502).json({
      tour, singles: null, doubles: null,
      error: String(error),
    });
  }
});

// ─── /api/atp — legacy compatibility ─────────────────────────────────────────
app.get("/api/atp", async (_req, res) => {
  try {
    const all = await fetchTourUrl(ESPN_ATP_URL);
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
    const resp = await fetch(`${url}?dates=${espnDate(0)}`, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) return res.status(502).json({ error: `ESPN ${resp.status}` });
    const raw = await resp.json();
    const firstEvent = Array.isArray(raw?.events) ? raw.events[0] : null;
    const firstGrouping = firstEvent?.groupings?.[0] || null;
    const firstComp = firstGrouping?.competitions?.[0] || null;
    return res.json({
      tour,
      date: espnDate(0),
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
  console.log(`  GET /api/tennis           — ATP + WTA combined (today + yesterday)`);
  console.log(`  GET /api/tournaments      — unique tournaments with dates + status`);
  console.log(`  GET /api/rankings?tour=   — ATP or WTA top 100 rankings (cached 6h)`);
  console.log(`  GET /api/atp              — ATP only (legacy)`);
  console.log(`  GET /api/debug?tour=      — raw ESPN schema`);
});
