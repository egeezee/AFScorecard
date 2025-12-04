// server.js
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import pkg from "pg";

const { Pool } = pkg;

const app = express();

// --- config ---
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me";
const DATABASE_URL = process.env.DATABASE_URL;
const CONGRESS_API_KEY =
  process.env.CONGRESS_API_KEY ||
  "NUtl5kWwSI4bWZKgjAbWxwALpFfL3gHWFPrwh0P0";

// update when 119th Congress truly “current”
const CURRENT_CONGRESS = 118;
// don't import bills older than this
const BILL_IMPORT_CUTOFF = new Date("2023-01-01T00:00:00Z");

if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set. Please add it in Render environment.");
}

if (!CONGRESS_API_KEY) {
  console.error("CONGRESS_API_KEY is not set. Congress.gov integration will fail.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// -----------------------------
//   STATE NORMALIZATION
// -----------------------------

// Full state name -> 2-letter postal code
const STATE_NAME_TO_ABBR = {
  ALABAMA: "AL",
  ALASKA: "AK",
  ARIZONA: "AZ",
  ARKANSAS: "AR",
  CALIFORNIA: "CA",
  COLORADO: "CO",
  CONNECTICUT: "CT",
  DELAWARE: "DE",
  "DISTRICT OF COLUMBIA": "DC",
  FLORIDA: "FL",
  GEORGIA: "GA",
  HAWAII: "HI",
  IDAHO: "ID",
  ILLINOIS: "IL",
  INDIANA: "IN",
  IOWA: "IA",
  KANSAS: "KS",
  KENTUCKY: "KY",
  LOUISIANA: "LA",
  MAINE: "ME",
  MARYLAND: "MD",
  MASSACHUSETTS: "MA",
  MICHIGAN: "MI",
  MINNESOTA: "MN",
  MISSISSIPPI: "MS",
  MISSOURI: "MO",
  MONTANA: "MT",
  NEBRASKA: "NE",
  NEVADA: "NV",
  "NEW HAMPSHIRE": "NH",
  "NEW JERSEY": "NJ",
  "NEW MEXICO": "NM",
  "NEW YORK": "NY",
  "NORTH CAROLINA": "NC",
  "NORTH DAKOTA": "ND",
  OHIO: "OH",
  OKLAHOMA: "OK",
  OREGON: "OR",
  PENNSYLVANIA: "PA",
  "RHODE ISLAND": "RI",
  "SOUTH CAROLINA": "SC",
  "SOUTH DAKOTA": "SD",
  TENNESSEE: "TN",
  TEXAS: "TX",
  UTAH: "UT",
  VERMONT: "VT",
  VIRGINIA: "VA",
  WASHINGTON: "WA",
  "WEST VIRGINIA": "WV",
  WISCONSIN: "WI",
  WYOMING: "WY",
};

function normalizeState(rawState) {
  if (!rawState) return null;

  if (typeof rawState === "string") {
    let val = rawState.trim();
    if (!val) return null;

    // Already two-letter code?
    if (val.length === 2) {
      return val.toUpperCase();
    }

    const upper = val.toUpperCase();
    const base = upper.split("(")[0].trim(); // strip "(At Large)" etc

    if (base.length === 2) {
      return base;
    }

    if (STATE_NAME_TO_ABBR[base]) {
      return STATE_NAME_TO_ABBR[base];
    }
  }

  return null;
}

// -----------------------------
//   SCORE RECOMPUTE
// -----------------------------

async function recomputeScoresForMember(memberId) {
  const { rows } = await pool.query(
    `
    SELECT
      b.af_position AS "afPosition",
      mv.vote,
      mv.is_current_congress AS "isCurrent"
    FROM member_votes mv
    JOIN bills b ON mv.bill_id = b.id
    WHERE mv.member_id = $1
  `,
    [memberId]
  );

  let lifetimeCorrect = 0;
  let lifetimeTotal = 0;
  let currentCorrect = 0;
  let currentTotal = 0;

  for (const row of rows) {
    const afPos = row.afPosition;
    const vote = row.vote;

    if (!afPos || afPos === "Neither") continue;
    if (vote !== "Approved" && vote !== "Opposed") continue;

    const aligned =
      (afPos === "America First" && vote === "Approved") ||
      (afPos === "Anti-America First" && vote === "Opposed");

    lifetimeTotal++;
    if (aligned) lifetimeCorrect++;

    if (row.isCurrent) {
      currentTotal++;
      if (aligned) currentCorrect++;
    }
  }

  const lifetimeScore =
    lifetimeTotal > 0 ? (lifetimeCorrect / lifetimeTotal) * 100 : null;
  const currentScore =
    currentTotal > 0 ? (currentCorrect / currentTotal) * 100 : null;

  await pool.query(
    `
    UPDATE politicians
    SET lifetime_score = $2, current_score = $3
    WHERE id = $1
  `,
    [memberId, lifetimeScore, currentScore]
  );
}

// -----------------------------
//   EXPRESS + STATIC
// -----------------------------

app.use(cors());
app.use(express.json({ limit: "5mb" })); // allow image data URLs

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public")));

// -----------------------------
//   ADMIN AUTH
// -----------------------------

const adminTokens = new Set();

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;

  if (token && adminTokens.has(token)) {
    return next();
  }

  console.warn("[requireAdmin] Unauthorized request", {
    path: req.path,
    hasAuthHeader: !!req.headers.authorization,
    tokenSnippet: token ? token.slice(0, 8) + "..." : null,
  });

  return res.status(401).json({ error: "Unauthorized" });
}

app.post("/api/login", (req, res) => {
  const { password } = req.body || {};
  if (!password) {
    return res.status(400).json({ error: "Password required" });
  }
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Invalid password" });
  }
  const token = crypto.randomUUID();
  adminTokens.add(token);
  res.json({ token });
});

// -----------------------------
//   DB BOOTSTRAP
// -----------------------------

async function initDb() {
  // politicians table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS politicians (
      id UUID PRIMARY KEY,
      bioguide_id TEXT UNIQUE,
      name TEXT,
      chamber TEXT,
      state CHAR(2),
      party TEXT,
      lifetime_score NUMERIC,
      current_score NUMERIC,
      image_data TEXT,
      trending BOOLEAN DEFAULT FALSE,
      position INTEGER
    );
  `);

  await pool.query(`
    ALTER TABLE politicians
    ADD COLUMN IF NOT EXISTS bioguide_id TEXT UNIQUE;
  `);

  // global bills table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bills (
      id UUID PRIMARY KEY,
      title TEXT NOT NULL,
      chamber TEXT,
      af_position TEXT,
      bill_date DATE,
      description TEXT,
      gov_link TEXT
    );
  `);

  await pool.query(`
    ALTER TABLE bills
    ADD COLUMN IF NOT EXISTS congress INTEGER,
    ADD COLUMN IF NOT EXISTS bill_type TEXT,
    ADD COLUMN IF NOT EXISTS bill_number INTEGER,
    ADD COLUMN IF NOT EXISTS votes_synced BOOLEAN DEFAULT FALSE;
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'bills_congress_type_number_key'
      ) THEN
        CREATE UNIQUE INDEX bills_congress_type_number_key
          ON bills (congress, bill_type, bill_number);
      END IF;
    END $$;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS member_votes (
      id UUID PRIMARY KEY,
      member_id UUID REFERENCES politicians(id) ON DELETE CASCADE,
      bill_id UUID REFERENCES bills(id) ON DELETE CASCADE,
      vote TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      is_current_congress BOOLEAN DEFAULT FALSE,
      CONSTRAINT member_votes_unique UNIQUE (member_id, bill_id)
    );
  `);

  await pool.query(`
    ALTER TABLE member_votes
    ADD COLUMN IF NOT EXISTS is_current_congress BOOLEAN DEFAULT FALSE;
  `);

  // Seed example politicians if empty
  const { rows } = await pool.query("SELECT COUNT(*) AS count FROM politicians");
  const count = parseInt(rows[0].count, 10);
  if (count === 0) {
    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();
    await pool.query(
      `
      INSERT INTO politicians
        (id, name, chamber, state, party, lifetime_score, current_score, image_data, trending, position)
      VALUES
        ($1, $2, 'Senate', 'TX', 'R', 92, 95, NULL, TRUE, 1),
        ($3, $4, 'House', 'FL', 'R', 88, 90, NULL, FALSE, 2)
    `,
      [id1, "Sample Senator", id2, "Sample Representative"]
    );
    console.log("Seeded initial politicians.");
  }
}

// -----------------------------
//   CONGRESS.GOV MEMBERS
// -----------------------------

async function fetchAllCurrentMembersFromCongressGov() {
  if (!CONGRESS_API_KEY) {
    throw new Error("CONGRESS_API_KEY is missing");
  }

  const baseUrl = "https://api.congress.gov/v3/member";
  const limit = 250;
  let offset = 0;
  let all = [];

  while (true) {
    const url = new URL(baseUrl);
    url.searchParams.set("api_key", CONGRESS_API_KEY);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("currentMember", "true");

    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Congress.gov member request failed: ${res.status} – ${text.slice(0, 200)}`
      );
    }

    const data = await res.json();
    const members = (data.members || []).map((item) => item.member || item);
    all = all.concat(members);

    const pagination = data.pagination || {};
    if (!pagination.next) break;

    offset += limit;
    if (pagination.count != null && offset >= pagination.count) break;
  }

  console.log("Congress sync: fetched", all.length, "raw members.");
  return all;
}

function normalizeCongressMembers(rawMembers) {
  const mapped = rawMembers.map((m) => {
    const bioguideId = m.bioguideId || null;

    const name =
      m.fullName ||
      [m.firstName, m.lastName].filter(Boolean).join(" ") ||
      null;

    const rawState =
      m.stateCode ||
      (typeof m.state === "string" ? m.state : null) ||
      (m.state && (m.state.code || m.state.postal)) ||
      (m.roles && m.roles[0] && (m.roles[0].state || m.roles[0].stateCode)) ||
      null;

    const state = normalizeState(rawState);

    let partyRaw =
      m.party ||
      (m.roles && m.roles[0] && m.roles[0].party) ||
      (m.terms && m.terms[0] && m.terms[0].party) ||
      null;

    let party = null;
    if (partyRaw) {
      const p = String(partyRaw).toLowerCase();
      if (p.startsWith("republican")) party = "R";
      else if (p.startsWith("democrat")) party = "D";
      else if (p.startsWith("independent")) party = "I";
      else party = String(partyRaw).toUpperCase().slice(0, 3);
    }

    let chamber =
      m.chamber ||
      (m.roles && m.roles[0] && m.roles[0].chamber) ||
      (m.terms && m.terms[0] && m.terms[0].chamber) ||
      null;

    if (chamber) {
      const lc = String(chamber).toLowerCase();
      if (lc.includes("house")) chamber = "House";
      else if (lc.includes("senate")) chamber = "Senate";
    }

    return {
      bioguideId,
      name,
      state,
      party,
      chamber,
    };
  });

  // Debug samples so you can see what we're getting
  mapped.slice(0, 25).forEach((m) =>
    console.log("[normalizeCongressMembers] sample", m)
  );

  const usable = mapped.filter(
    (m) => m.bioguideId && m.name && m.state && m.party
  );

  if (usable.length) {
    console.log(
      "Congress sync: usable normalized members:",
      usable.length,
      "sample:",
      usable[0]
    );
  } else {
    console.log("Congress sync: usable normalized members: 0 sample: undefined");
  }

  return usable;
}

// Admin-only endpoint to sync all current House/Senate members into politicians
app.post("/api/admin/sync-members", requireAdmin, async (req, res) => {
  try {
    const rawMembers = await fetchAllCurrentMembersFromCongressGov();
    const members = normalizeCongressMembers(rawMembers);

    const client = await pool.connect();
    let importedCount = 0;
    let updatedCount = 0;

    try {
      await client.query("BEGIN");

      const posRes = await client.query(
        "SELECT COALESCE(MAX(position), 0) AS maxpos FROM politicians"
      );
      let nextPosition = Number(posRes.rows[0].maxpos) || 0;

      for (const m of members) {
        const existing = await client.query(
          "SELECT id FROM politicians WHERE bioguide_id = $1",
          [m.bioguideId]
        );

        if (existing.rows.length > 0) {
          await client.query(
            `
            UPDATE politicians
            SET name = $2,
                chamber = $3,
                state = $4,
                party = $5
            WHERE bioguide_id = $1
          `,
            [m.bioguideId, m.name, m.chamber, m.state, m.party]
          );
          updatedCount++;
        } else {
          nextPosition += 1;
          const id = crypto.randomUUID();
          await client.query(
            `
            INSERT INTO politicians
              (id, bioguide_id, name, chamber, state, party,
               lifetime_score, current_score, image_data, trending, position)
            VALUES
              ($1, $2, $3, $4, $5, $6,
               NULL, NULL, NULL, FALSE, $7)
          `,
            [id, m.bioguideId, m.name, m.chamber, m.state, m.party, nextPosition]
          );
          importedCount++;
        }
      }

      await client.query("COMMIT");
      console.log(
        "Congress sync final: raw=",
        rawMembers.length,
        "usable=",
        members.length,
        "imported=",
        importedCount,
        "updated=",
        updatedCount
      );
      res.json({
        success: true,
        importedCount,
        updatedCount,
        rawCount: rawMembers.length,
        usableCount: members.length,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Error syncing members:", err);
      res.status(500).json({ error: "Error syncing members" });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Error in sync-members:", err);
    res.status(500).json({ error: "Sync failed" });
  }
});

// -----------------------------
//   CONGRESS.GOV BILLS
// -----------------------------

function normalizeCongressBill(apiBill) {
  const congress = apiBill.congress || null;
  const billTypeRaw = apiBill.type || apiBill.billType || null;
  const billNumberRaw = apiBill.number || apiBill.billNumber || null;
  const billNumber = billNumberRaw ? parseInt(billNumberRaw, 10) : null;
  let billType = billTypeRaw ? String(billTypeRaw).toLowerCase() : null;

  if (!congress || !billType || !billNumber) {
    return null;
  }

  let chamber = apiBill.originChamber || apiBill.chamber || null;
  if (!chamber && billType.startsWith("h")) chamber = "House";
  if (!chamber && billType.startsWith("s")) chamber = "Senate";

  const title =
    apiBill.title ||
    apiBill.titleWithoutNumber ||
    `Bill ${billType.toUpperCase()} ${billNumber}`;

  const latestDate =
    (apiBill.latestAction && apiBill.latestAction.actionDate) ||
    apiBill.updateDate ||
    null;

  const billDate = latestDate ? new Date(latestDate) : null;

  const govLink =
    apiBill.url ||
    (apiBill.latestAction && apiBill.latestAction.url) ||
    null;

  return {
    congress,
    billType,
    billNumber,
    chamber,
    title,
    billDate,
    govLink,
  };
}

async function fetchRecentBillsFromCongressGov() {
  if (!CONGRESS_API_KEY) throw new Error("CONGRESS_API_KEY missing");

  const baseUrl = "https://api.congress.gov/v3/bill";
  const limit = 50;
  let offset = 0;
  const maxPages = 30; // 1500 bills max
  const results = [];
  let stop = false;

  for (let page = 0; page < maxPages && !stop; page++) {
    const url = new URL(baseUrl);
    url.searchParams.set("api_key", CONGRESS_API_KEY);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("sort", "latestActionDate+desc");

    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Congress.gov bill request failed: ${res.status} – ${text.slice(0, 200)}`
      );
    }

    const data = await res.json();
    const apiBills = data.bills || [];
    if (!apiBills.length) break;

    for (const apiBill of apiBills) {
      const normalized = normalizeCongressBill(apiBill);
      if (!normalized) continue;

      // optional: skip future congress if you want only CURRENT_CONGRESS and below
      if (normalized.congress && normalized.congress > CURRENT_CONGRESS) {
        continue;
      }

      if (normalized.billDate && normalized.billDate < BILL_IMPORT_CUTOFF) {
        stop = true;
        break;
      }

      results.push(normalized);
    }

    const pagination = data.pagination || {};
    offset += limit;
    if (!pagination.next) break;
  }

  console.log("Congress bill sync: normalized bills:", results.length);
  return results;
}

async function syncRecentBillsIntoDb() {
  const bills = await fetchRecentBillsFromCongressGov();

  const client = await pool.connect();
  let inserted = 0;
  let updated = 0;

  try {
    await client.query("BEGIN");

    for (const b of bills) {
      const billDateSql = b.billDate ? b.billDate.toISOString().slice(0, 10) : null;

      const existing = await client.query(
        `
        SELECT id
        FROM bills
        WHERE congress = $1 AND bill_type = $2 AND bill_number = $3
      `,
        [b.congress, b.billType, b.billNumber]
      );

      if (existing.rows.length > 0) {
        await client.query(
          `
          UPDATE bills
          SET
            title = COALESCE($4, title),
            chamber = COALESCE($5, chamber),
            bill_date = COALESCE($6, bill_date),
            gov_link = COALESCE($7, gov_link)
          WHERE congress = $1 AND bill_type = $2 AND bill_number = $3
        `,
          [
            b.congress,
            b.billType,
            b.billNumber,
            b.title,
            b.chamber,
            billDateSql,
            b.govLink,
          ]
        );
        updated++;
      } else {
        const id = crypto.randomUUID();
        await client.query(
          `
          INSERT INTO bills
            (id, title, chamber, af_position,
             bill_date, description, gov_link,
             congress, bill_type, bill_number, votes_synced)
          VALUES
            ($1, $2, $3, NULL,
             $4, NULL, $5,
             $6, $7, $8, FALSE)
        `,
          [
            id,
            b.title,
            b.chamber,
            billDateSql,
            b.govLink,
            b.congress,
            b.billType,
            b.billNumber,
          ]
        );
        inserted++;
      }
    }

    await client.query("COMMIT");
    console.log(
      "Congress bill sync complete: total=",
      bills.length,
      "inserted=",
      inserted,
      "updated=",
      updated
    );
    return { inserted, updated, total: bills.length };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

app.post("/api/admin/sync-bills", requireAdmin, async (req, res) => {
  try {
    const result = await syncRecentBillsIntoDb();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("Error syncing bills:", err);
    res.status(500).json({ error: "Error syncing bills" });
  }
});

// -----------------------------
//   CONGRESS.GOV VOTES
// -----------------------------

function normalizeVotePositionToOurVote(positionRaw) {
  if (!positionRaw) return "Abstained";
  const p = String(positionRaw).toLowerCase();
  if (p.startsWith("yea") || p === "yes" || p === "aye") return "Approved";
  if (p.startsWith("nay") || p === "no") return "Opposed";
  return "Abstained";
}

async function fetchVotePositionsForBill(billRow) {
  if (!CONGRESS_API_KEY) {
    console.error("CONGRESS_API_KEY missing, cannot fetch votes");
    return [];
  }
  if (!billRow.congress || !billRow.bill_type || !billRow.bill_number) {
    console.warn("Bill missing congress.gov identity, cannot fetch votes:", billRow);
    return [];
  }

  const typeLower = String(billRow.bill_type).toLowerCase();
  const billVotesUrl = new URL(
    `https://api.congress.gov/v3/bill/${billRow.congress}/${typeLower}/${billRow.bill_number}/votes`
  );
  billVotesUrl.searchParams.set("api_key", CONGRESS_API_KEY);
  billVotesUrl.searchParams.set("format", "json");

  console.log("[votes] list URL", billVotesUrl.toString());

  const votesRes = await fetch(billVotesUrl);
  if (!votesRes.ok) {
    const txt = await votesRes.text();
    console.error(
      "Error fetching bill votes list:",
      votesRes.status,
      txt.slice(0, 200)
    );
    return [];
  }

  const votesData = await votesRes.json();
  const votes = votesData.votes || [];
  if (!votes.length) return [];

  const primary = votes[0];

  const voteChamber = primary.chamber || billRow.chamber || "House";
  const rollNumber = primary.rollNumber || primary.roll;
  const sessionNumber = primary.sessionNumber || primary.session;

  if (!rollNumber || !sessionNumber) {
    console.warn("Vote summary missing roll/session:", primary);
    return [];
  }

  let detailUrl;
  if (String(voteChamber).toLowerCase().startsWith("house")) {
    detailUrl = new URL(
      `https://api.congress.gov/v3/house-vote/${billRow.congress}/${sessionNumber}/${rollNumber}`
    );
  } else {
    detailUrl = new URL(
      `https://api.congress.gov/v3/senate-vote/${billRow.congress}/${sessionNumber}/${rollNumber}`
    );
  }
  detailUrl.searchParams.set("api_key", CONGRESS_API_KEY);
  detailUrl.searchParams.set("format", "json");

  const detailRes = await fetch(detailUrl);
  if (!detailRes.ok) {
    const txt = await detailRes.text();
    console.error(
      "Error fetching vote detail:",
      detailRes.status,
      txt.slice(0, 200)
    );
    return [];
  }

  const detail = await detailRes.json();
  const positions =
    (detail.votes && detail.votes.votePositions) ||
    detail.votePositions ||
    detail.members ||
    [];

  return positions.map((p) => ({
    bioguideId: p.bioguideId || (p.member && p.member.bioguideId) || null,
    votePosition: p.votePosition || p.position || null,
  }));
}

async function syncVotesForBill(billId) {
  const { rows } = await pool.query(
    `
    SELECT
      id,
      congress,
      bill_type,
      bill_number,
      chamber
    FROM bills
    WHERE id = $1
  `,
    [billId]
  );
  if (!rows.length) return;
  const billRow = rows[0];

  const positions = await fetchVotePositionsForBill(billRow);
  if (!positions.length) {
    console.log("No vote positions found for bill", billId);
    return;
  }

  console.log(
    `Syncing ${positions.length} vote positions for bill ${billRow.congress} ${billRow.bill_type} ${billRow.bill_number}`
  );

  for (const pos of positions) {
    if (!pos.bioguideId) continue;

    const polRes = await pool.query(
      "SELECT id FROM politicians WHERE bioguide_id = $1",
      [pos.bioguideId]
    );
    if (!polRes.rows.length) continue;

    const memberId = polRes.rows[0].id;
    const vote = normalizeVotePositionToOurVote(pos.votePosition);

    await pool.query(
      `
      INSERT INTO member_votes (id, member_id, bill_id, vote, is_current_congress)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (member_id, bill_id)
      DO UPDATE SET
        vote = EXCLUDED.vote,
        is_current_congress = EXCLUDED.is_current_congress,
        created_at = now()
    `,
      [
        crypto.randomUUID(),
        memberId,
        billRow.id,
        vote,
        billRow.congress === CURRENT_CONGRESS,
      ]
    );

    await recomputeScoresForMember(memberId);
  }

  await pool.query("UPDATE bills SET votes_synced = TRUE WHERE id = $1", [
    billRow.id,
  ]);
}

// -----------------------------
//   MEMBERS API
// -----------------------------

app.get("/api/members", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        id,
        bioguide_id AS "bioguideId",
        name,
        chamber,
        state,
        party,
        lifetime_score AS "lifetimeScore",
        current_score AS "currentScore",
        image_data AS "imageData",
        trending,
        position
      FROM politicians
      ORDER BY position NULLS LAST, name ASC;
    `
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching members:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/members", requireAdmin, async (req, res) => {
  try {
    const {
      name = "New Member",
      chamber = "House",
      state = "",
      party = "",
      imageData = null,
      trending = false,
      bioguideId = null,
    } = req.body || {};

    const { rows } = await pool.query(
      "SELECT COALESCE(MAX(position), 0) AS maxpos FROM politicians"
    );
    const nextPosition = (rows[0].maxpos || 0) + 1;

    const id = crypto.randomUUID();

    const insertResult = await pool.query(
      `
      INSERT INTO politicians
        (id, bioguide_id, name, chamber, state, party,
         lifetime_score, current_score, image_data, trending, position)
      VALUES
        ($1, $2, $3, $4, $5, $6,
         NULL, NULL, $7, $8, $9)
      RETURNING
        id,
        bioguide_id AS "bioguideId",
        name,
        chamber,
        state,
        party,
        lifetime_score AS "lifetimeScore",
        current_score AS "currentScore",
        image_data AS "imageData",
        trending,
        position;
    `,
      [
        id,
        bioguideId,
        name,
        chamber,
        state,
        party,
        imageData,
        trending,
        nextPosition,
      ]
    );

    res.status(201).json(insertResult.rows[0]);
  } catch (err) {
    console.error("Error adding member:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.put("/api/members/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;

  const allowedFields = [
    "name",
    "chamber",
    "state",
    "party",
    "imageData",
    "trending",
    "position",
    "bioguideId",
  ];

  const updates = {};
  for (const key of allowedFields) {
    if (key in req.body) updates[key] = req.body[key];
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No valid fields to update" });
  }

  const fieldToColumn = {
    name: "name",
    chamber: "chamber",
    state: "state",
    party: "party",
    imageData: "image_data",
    trending: "trending",
    position: "position",
    bioguideId: "bioguide_id",
  };

  const setClauses = [];
  const values = [];
  let idx = 1;

  for (const [key, value] of Object.entries(updates)) {
    setClauses.push(`${fieldToColumn[key]} = $${idx++}`);
    values.push(value);
  }
  values.push(id);

  const query = `
    UPDATE politicians
    SET ${setClauses.join(", ")}
    WHERE id = $${idx}
    RETURNING
      id,
      bioguide_id AS "bioguideId",
      name,
      chamber,
      state,
      party,
      lifetime_score AS "lifetimeScore",
      current_score AS "currentScore",
      image_data AS "imageData",
      trending,
      position;
  `;

  try {
    const result = await pool.query(query, values);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Not found" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error updating member:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.delete("/api/members/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `
      DELETE FROM politicians
      WHERE id = $1
      RETURNING
        id,
        bioguide_id AS "bioguideId",
        name,
        chamber,
        state,
        party,
        lifetime_score AS "lifetimeScore",
        current_score AS "currentScore",
        image_data AS "imageData",
        trending,
        position;
    `,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Not found" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error deleting member:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/members/reorder", requireAdmin, async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: "ids array required" });
  }

  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const pos = i + 1;
        await client.query(
          "UPDATE politicians SET position = $1 WHERE id = $2",
          [pos, id]
        );
      }

      await client.query("COMMIT");
      res.json({ success: true });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Error reordering members:", err);
      res.status(500).json({ error: "Server error" });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Error getting client for reorder:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/members/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `
      SELECT
        id,
        bioguide_id AS "bioguideId",
        name,
        chamber,
        state,
        party,
        lifetime_score AS "lifetimeScore",
        current_score AS "currentScore",
        image_data AS "imageData",
        trending,
        position
      FROM politicians
      WHERE id = $1
    `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error fetching member by id:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// -----------------------------
//   BILLS (PUBLIC)
// -----------------------------

app.get("/api/bills", async (req, res) => {
  const { chamber } = req.query;
  try {
    let result;
    if (chamber) {
      result = await pool.query(
        `
        SELECT
          id,
          title,
          chamber,
          af_position AS "afPosition",
          bill_date AS "billDate",
          description,
          gov_link AS "govLink",
          congress,
          bill_type AS "billType",
          bill_number AS "billNumber"
        FROM bills
        WHERE chamber = $1 OR chamber IS NULL
        ORDER BY bill_date DESC NULLS LAST, title ASC;
      `,
        [chamber]
      );
    } else {
      result = await pool.query(
        `
        SELECT
          id,
          title,
          chamber,
          af_position AS "afPosition",
          bill_date AS "billDate",
          description,
          gov_link AS "govLink",
          congress,
          bill_type AS "billType",
          bill_number AS "billNumber"
        FROM bills
        ORDER BY bill_date DESC NULLS LAST, title ASC;
      `
      );
    }
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching bills:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/bills", requireAdmin, async (req, res) => {
  try {
    const {
      title,
      chamber = null,
      afPosition = null,
      billDate = null,
      description = null,
      govLink = null,
      congress = null,
      billType = null,
      billNumber = null,
    } = req.body || {};

    if (!title) {
      return res.status(400).json({ error: "Title is required" });
    }

    const id = crypto.randomUUID();
    const insertResult = await pool.query(
      `
      INSERT INTO bills
        (id, title, chamber, af_position, bill_date, description, gov_link,
         congress, bill_type, bill_number, votes_synced)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, FALSE)
      RETURNING
        id,
        title,
        chamber,
        af_position AS "afPosition",
        bill_date AS "billDate",
        description,
        gov_link AS "govLink",
        congress,
        bill_type AS "billType",
        bill_number AS "billNumber";
    `,
      [
        id,
        title,
        chamber,
        afPosition,
        billDate,
        description,
        govLink,
        congress,
        billType,
        billNumber,
      ]
    );

    res.status(201).json(insertResult.rows[0]);
  } catch (err) {
    console.error("Error creating bill:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.put("/api/bills/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;

  const allowedFields = [
    "title",
    "chamber",
    "afPosition",
    "billDate",
    "description",
    "govLink",
    "congress",
    "billType",
    "billNumber",
  ];

  const updates = {};
  for (const key of allowedFields) {
    if (key in req.body) updates[key] = req.body[key];
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No valid fields to update" });
  }

  const fieldToColumn = {
    title: "title",
    chamber: "chamber",
    afPosition: "af_position",
    billDate: "bill_date",
    description: "description",
    govLink: "gov_link",
    congress: "congress",
    billType: "bill_type",
    billNumber: "bill_number",
  };

  const setClauses = [];
  const values = [];
  let idx = 1;

  for (const [key, value] of Object.entries(updates)) {
    setClauses.push(`${fieldToColumn[key]} = $${idx++}`);
    values.push(value);
  }
  values.push(id);

  const query = `
    UPDATE bills
    SET ${setClauses.join(", ")}
    WHERE id = $${idx}
    RETURNING
      id,
      title,
      chamber,
      af_position AS "afPosition",
      bill_date AS "billDate",
      description,
      gov_link AS "govLink",
      congress,
      bill_type AS "billType",
      bill_number AS "billNumber";
  `;

  try {
    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Bill not found" });
    }

    const mRes = await pool.query(
      `SELECT DISTINCT member_id FROM member_votes WHERE bill_id = $1`,
      [id]
    );
    for (const row of mRes.rows) {
      await recomputeScoresForMember(row.member_id);
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error updating bill:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.delete("/api/bills/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const mRes = await pool.query(
      `SELECT DISTINCT member_id FROM member_votes WHERE bill_id = $1`,
      [id]
    );

    const result = await pool.query(
      `
      DELETE FROM bills
      WHERE id = $1
      RETURNING
        id,
        title,
        chamber,
        af_position AS "afPosition",
        bill_date AS "billDate",
        description,
        gov_link AS "govLink";
    `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Bill not found" });
    }

    for (const row of mRes.rows) {
      await recomputeScoresForMember(row.member_id);
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error deleting bill:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// -----------------------------
//   ADMIN DOCKET (PAGINATED)
// -----------------------------

// GET /api/admin/docket?page=1&pageSize=50&congress=118&hasVotes=true
app.get("/api/admin/docket", requireAdmin, async (req, res) => {
  const page = Math.max(parseInt(req.query.page || "1", 10), 1);
  const pageSizeRaw = parseInt(req.query.pageSize || "50", 10);
  const pageSize = Math.min(Math.max(pageSizeRaw || 50, 1), 200);

  const congressFilter = req.query.congress
    ? parseInt(req.query.congress, 10)
    : null;

  let hasVotes = null;
  if (typeof req.query.hasVotes === "string" && req.query.hasVotes.length) {
    hasVotes = req.query.hasVotes === "true";
  }

  const whereParts = ["af_position IS NULL"];
  const params = [];
  let idx = 1;

  // Congress filter: if provided, use it. Otherwise, default to CURRENT_CONGRESS and below.
  if (!Number.isNaN(congressFilter) && congressFilter > 0) {
    whereParts.push(`congress = $${idx++}`);
    params.push(congressFilter);
  } else {
    whereParts.push(`(congress IS NULL OR congress <= $${idx++})`);
    params.push(CURRENT_CONGRESS);
  }

  // Optional filter based on presence of votes in our DB
  if (hasVotes === true) {
    whereParts.push(
      `EXISTS (SELECT 1 FROM member_votes mv WHERE mv.bill_id = bills.id)`
    );
  } else if (hasVotes === false) {
    whereParts.push(
      `NOT EXISTS (SELECT 1 FROM member_votes mv WHERE mv.bill_id = bills.id)`
    );
  }

  const whereSql = "WHERE " + whereParts.join(" AND ");
  const offset = (page - 1) * pageSize;

  try {
    const countResult = await pool.query(
      `SELECT COUNT(*) AS count FROM bills ${whereSql}`,
      params
    );
    const total = parseInt(countResult.rows[0].count, 10) || 0;
    const totalPages = total > 0 ? Math.ceil(total / pageSize) : 1;

    params.push(pageSize);
    params.push(offset);

    const rowsResult = await pool.query(
      `
      SELECT
        id,
        title,
        chamber,
        af_position AS "afPosition",
        bill_date AS "billDate",
        description,
        gov_link AS "govLink",
        congress,
        bill_type AS "billType",
        bill_number AS "billNumber"
      FROM bills
      ${whereSql}
      ORDER BY bill_date DESC NULLS LAST, title ASC
      LIMIT $${idx++} OFFSET $${idx++};
    `,
      params
    );

    res.json({
      items: rowsResult.rows,
      page,
      pageSize,
      total,
      totalPages,
    });
  } catch (err) {
    console.error("Error fetching docket bills:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// rate a bill in the docket and then sync votes
app.post("/api/admin/docket/:id/rate", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { afPosition } = req.body || {};

  const allowed = ["America First", "Neither", "Anti-America First"];
  if (!allowed.includes(afPosition)) {
    return res
      .status(400)
      .json({ error: "afPosition must be one of: " + allowed.join(", ") });
  }

  try {
    console.log("[docket/rate] rated bill", id, "as", afPosition);

    const result = await pool.query(
      `
      UPDATE bills
      SET af_position = $2
      WHERE id = $1
      RETURNING
        id,
        title,
        chamber,
        af_position AS "afPosition",
        bill_date AS "billDate",
        description,
        gov_link AS "govLink",
        congress,
        bill_type AS "billType",
        bill_number AS "billNumber",
        votes_synced;
    `,
      [id, afPosition]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Bill not found" });
    }

    const billRow = result.rows[0];

    try {
      await syncVotesForBill(billRow.id);
    } catch (err) {
      console.error("Error syncing votes after rating bill:", err);
    }

    const mRes = await pool.query(
      `SELECT DISTINCT member_id FROM member_votes WHERE bill_id = $1`,
      [billRow.id]
    );
    for (const row of mRes.rows) {
      await recomputeScoresForMember(row.member_id);
    }

    res.json(billRow);
  } catch (err) {
    console.error("Error rating bill:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// -----------------------------
//   MEMBER <-> BILLS
// -----------------------------

app.get("/api/members/:id/bills", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `
      SELECT
        b.id AS "billId",
        b.title,
        b.chamber,
        b.af_position AS "afPosition",
        b.bill_date AS "billDate",
        b.description,
        b.gov_link AS "govLink",
        b.congress,
        b.bill_type AS "billType",
        b.bill_number AS "billNumber",
        mv.id AS "voteId",
        mv.vote,
        mv.is_current_congress AS "isCurrent",
        mv.created_at AS "createdAt"
      FROM member_votes mv
      JOIN bills b ON mv.bill_id = b.id
      WHERE mv.member_id = $1
      ORDER BY b.bill_date DESC NULLS LAST, mv.created_at DESC;
    `,
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching member bills:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/members/:id/bills", requireAdmin, async (req, res) => {
  const { id: memberId } = req.params;
  const { billId, vote } = req.body || {};

  if (!billId || !vote) {
    return res.status(400).json({ error: "billId and vote are required" });
  }

  let isCurrent = null;
  if (Object.prototype.hasOwnProperty.call(req.body, "isCurrent")) {
    isCurrent = !!req.body.isCurrent;
  }

  try {
    const result = await pool.query(
      `
      INSERT INTO member_votes (id, member_id, bill_id, vote, is_current_congress)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (member_id, bill_id)
      DO UPDATE SET
        vote = EXCLUDED.vote,
        is_current_congress = COALESCE(
          EXCLUDED.is_current_congress,
          member_votes.is_current_congress
        ),
        created_at = now()
      RETURNING
        id AS "voteId",
        member_id AS "memberId",
        bill_id AS "billId",
        vote,
        is_current_congress AS "isCurrent",
        created_at AS "createdAt";
    `,
      [crypto.randomUUID(), memberId, billId, vote, isCurrent]
    );

    await recomputeScoresForMember(memberId);

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error setting member vote:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.delete("/api/members/:id/bills/:billId", requireAdmin, async (req, res) => {
  const { id: memberId, billId } = req.params;

  try {
    const result = await pool.query(
      `
      DELETE FROM member_votes
      WHERE member_id = $1 AND bill_id = $2
      RETURNING id;
    `,
      [memberId, billId]
    );

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "Vote not found for this member/bill" });
    }

    await recomputeScoresForMember(memberId);

    res.json({ success: true });
  } catch (err) {
    console.error("Error deleting member vote:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// -----------------------------
//   START SERVER
// -----------------------------

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log("AFScorecard server listening on port", PORT);
    });
  })
  .catch((err) => {
    console.error("Error initializing DB:", err);
    process.exit(1);
  });
