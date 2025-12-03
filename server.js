// server.js
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import pkg from "pg";

const { Pool } = pkg;

const app = express();

// ===================
//  CONFIG
// ===================
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me";
const DATABASE_URL = process.env.DATABASE_URL;
const CONGRESS_API_KEY =
  process.env.CONGRESS_API_KEY || "NUtl5kWwSI4bWZKgjAbWxwALpFfL3gHWFPrwh0P0";
const VOTESMART_API_KEY = process.env.VOTESMART_API_KEY || process.env.VOTESMART_KEY; // rename as needed

if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set. Please add it in Render environment.");
}
if (!CONGRESS_API_KEY) {
  console.error("CONGRESS_API_KEY is not set. Congress auto-sync will be disabled.");
}
if (!VOTESMART_API_KEY) {
  console.warn(
    "VOTESMART_API_KEY is not set. VoteSmart bill sync will only work once configured."
  );
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ===================
//  HELPERS
// ===================

// recompute America First scores for a single member
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

    // Ignore unclassified or "Neither"
    if (!afPos || afPos === "Neither") continue;

    // Only count clear yes/no votes
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

// ===================
//  MIDDLEWARE
// ===================
app.use(cors());
app.use(express.json({ limit: "5mb" })); // allow image data URLs

// static files
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public")));

// simple in-memory token store (admin sessions)
const adminTokens = new Set();

function getTokenFromReq(req) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return null;
  return auth.slice("Bearer ".length);
}

function requireAdmin(req, res, next) {
  const token = getTokenFromReq(req);
  if (token && adminTokens.has(token)) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

// ===================
//  DB BOOTSTRAP
// ===================
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
      position INTEGER,
      votesmart_candidate_id TEXT
    );
  `);

  // keep schema forwards-compatible
  await pool.query(`
    ALTER TABLE politicians
    ADD COLUMN IF NOT EXISTS bioguide_id TEXT;
  `);
  await pool.query(`
    ALTER TABLE politicians
    ADD COLUMN IF NOT EXISTS votesmart_candidate_id TEXT;
  `);

  // global bills table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bills (
      id UUID PRIMARY KEY,
      title TEXT NOT NULL,
      chamber TEXT,               -- "House", "Senate", or NULL/"Both"
      af_position TEXT,           -- "America First", "Neither", "Anti-America First"
      bill_date DATE,
      description TEXT,
      gov_link TEXT,
      source TEXT,
      votesmart_bill_id TEXT,
      votesmart_bill_number TEXT,
      votesmart_congress INTEGER,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  await pool.query(`
    ALTER TABLE bills
    ADD COLUMN IF NOT EXISTS source TEXT;
  `);
  await pool.query(`
    ALTER TABLE bills
    ADD COLUMN IF NOT EXISTS votesmart_bill_id TEXT;
  `);
  await pool.query(`
    ALTER TABLE bills
    ADD COLUMN IF NOT EXISTS votesmart_bill_number TEXT;
  `);
  await pool.query(`
    ALTER TABLE bills
    ADD COLUMN IF NOT EXISTS votesmart_congress INTEGER;
  `);
  await pool.query(`
    ALTER TABLE bills
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
  `);

  // member_votes: link politician -> bill with their vote
  await pool.query(`
    CREATE TABLE IF NOT EXISTS member_votes (
      id UUID PRIMARY KEY,
      member_id UUID REFERENCES politicians(id) ON DELETE CASCADE,
      bill_id UUID REFERENCES bills(id) ON DELETE CASCADE,
      vote TEXT,                  -- "Approved", "Opposed", "Abstained"
      is_current_congress BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT now(),
      CONSTRAINT member_votes_unique UNIQUE (member_id, bill_id)
    );
  `);

  await pool.query(`
    ALTER TABLE member_votes
    ADD COLUMN IF NOT EXISTS is_current_congress BOOLEAN DEFAULT FALSE;
  `);

  // optional tiny seed, just so UI isn't empty
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

// ===================
//  CONGRESS.GOV MEMBER SYNC
// ===================

// Pull ALL current members from Congress.gov, paginated
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
    // depending on the API version this may be either `data.members`
    // or `data.results[0].members`; we handle both.
    let members = [];
    if (Array.isArray(data.members)) {
      members = data.members;
    } else if (Array.isArray(data.results) && data.results[0]?.members) {
      members = data.results[0].members;
    }

    all = all.concat(members);

    const pagination = data.pagination || {};
    if (!pagination.next) break;

    offset += limit;
    if (pagination.count != null && offset >= pagination.count) break;
  }

  return all;
}

// Normalize Congress.gov member shapes.
// We only REQUIRE bioguideId + name so we don't throw away real members
// when fields like party/state/chamber are missing or shaped differently.
function normalizeCongressMembers(rawMembers) {
  return rawMembers
    .map((raw) => {
      const m = raw.member || raw;

      const bioguideId = m.bioguideId || m.bioGuideId || null;

      const fullName =
        m.fullName ||
        m.name ||
        [m.firstName, m.middleName, m.lastName].filter(Boolean).join(" ") ||
        null;

      // chamber might be "House", "Senate", or "House of Representatives"
      let chamber =
        m.chamber ||
        m.office ||
        (Array.isArray(m.terms) && m.terms[0]?.chamber) ||
        null;
      if (typeof chamber === "string") {
        if (chamber.toLowerCase().includes("house")) chamber = "House";
        else if (chamber.toLowerCase().includes("senate")) chamber = "Senate";
      }

      // attempt state from a few likely fields
      let state =
        m.state ||
        m.stateCode ||
        (Array.isArray(m.terms) && m.terms[0]?.state) ||
        null;
      if (state) {
        state = String(state).toUpperCase();
        if (state.length > 2) state = state.slice(0, 2);
      }

      // party from several likely fields
      let party =
        m.party ||
        m.partyName ||
        (Array.isArray(m.parties) && m.parties[0]?.party) ||
        null;
      if (party) {
        const p = party.toLowerCase();
        if (p.startsWith("republican")) party = "R";
        else if (p.startsWith("democrat")) party = "D";
        else if (p.startsWith("independent")) party = "I";
      }

      return { bioguideId, name: fullName, chamber, state, party };
    })
    .filter((m) => m.bioguideId && m.name);
}

// Admin-only endpoint to sync all current House/Senate members into politicians
app.post("/api/admin/sync-members", requireAdmin, async (req, res) => {
  try {
    const rawMembers = await fetchAllCurrentMembersFromCongressGov();
    const members = normalizeCongressMembers(rawMembers);

    console.log(
      `Congress sync: fetched ${rawMembers.length} raw, ${members.length} usable members.`
    );

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Get current max position so new members go to the bottom
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
          // update basic fields only; preserve scores, image, trending, position
          await client.query(
            `
            UPDATE politicians
            SET name = $2,
                chamber = COALESCE($3, chamber),
                state = COALESCE($4, state),
                party = COALESCE($5, party)
            WHERE bioguide_id = $1
          `,
            [m.bioguideId, m.name, m.chamber, m.state, m.party]
          );
        } else {
          // insert new
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
        }
      }

      await client.query("COMMIT");
      res.json({
        success: true,
        importedCount: members.length,
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

// ===================
//  AUTH
// ===================
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

// ===================
//  MEMBERS
// ===================

// get all members (public), ordered by position then name
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

// add member (admin only)
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
      votesmartCandidateId = null,
    } = req.body || {};

    // get max position
    const { rows } = await pool.query(
      "SELECT COALESCE(MAX(position), 0) AS maxpos FROM politicians"
    );
    const nextPosition = (rows[0].maxpos || 0) + 1;

    const id = crypto.randomUUID();

    const insertResult = await pool.query(
      `
      INSERT INTO politicians
        (id, bioguide_id, name, chamber, state, party,
         lifetime_score, current_score, image_data, trending, position,
         votesmart_candidate_id)
      VALUES
        ($1, $2, $3, $4, $5, $6,
         NULL, NULL, $7, $8, $9, $10)
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
        position,
        votesmart_candidate_id AS "votesmartCandidateId";
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
        votesmartCandidateId,
      ]
    );

    res.status(201).json(insertResult.rows[0]);
  } catch (err) {
    console.error("Error adding member:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// update member (admin only, partial update)
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
    "votesmartCandidateId",
  ];

  const updates = {};
  for (const key of allowedFields) {
    if (key in req.body) {
      updates[key] = req.body[key];
    }
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
    votesmartCandidateId: "votesmart_candidate_id",
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
      position,
      votesmart_candidate_id AS "votesmartCandidateId";
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

// delete member (admin only)
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
        position,
        votesmart_candidate_id AS "votesmartCandidateId";
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

// bulk reorder (admin only) – for drag & drop
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

// get a single member by id (public)
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
        position,
        votesmart_candidate_id AS "votesmartCandidateId"
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

// ===================
//  BILLS (GLOBAL)
// ===================

// list bills (public, optional ?chamber=House/Senate)
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
          source,
          votesmart_bill_id AS "votesmartBillId",
          votesmart_bill_number AS "votesmartBillNumber",
          votesmart_congress AS "votesmartCongress",
          created_at AS "createdAt"
        FROM bills
        WHERE chamber = $1 OR chamber IS NULL
        ORDER BY bill_date DESC NULLS LAST, created_at DESC, title ASC;
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
          source,
          votesmart_bill_id AS "votesmartBillId",
          votesmart_bill_number AS "votesmartBillNumber",
          votesmart_congress AS "votesmartCongress",
          created_at AS "createdAt"
        FROM bills
        ORDER BY bill_date DESC NULLS LAST, created_at DESC, title ASC;
      `
      );
    }
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching bills:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// create a new bill (admin)
app.post("/api/bills", requireAdmin, async (req, res) => {
  try {
    const {
      title,
      chamber = null,
      afPosition = null,
      billDate = null,
      description = null,
      govLink = null,
      source = null,
      votesmartBillId = null,
      votesmartBillNumber = null,
      votesmartCongress = null,
    } = req.body || {};

    if (!title) {
      return res.status(400).json({ error: "Title is required" });
    }

    const id = crypto.randomUUID();
    const insertResult = await pool.query(
      `
      INSERT INTO bills
        (id, title, chamber, af_position, bill_date, description, gov_link,
         source, votesmart_bill_id, votesmart_bill_number, votesmart_congress)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11)
      RETURNING
        id,
        title,
        chamber,
        af_position AS "afPosition",
        bill_date AS "billDate",
        description,
        gov_link AS "govLink",
        source,
        votesmart_bill_id AS "votesmartBillId",
        votesmart_bill_number AS "votesmartBillNumber",
        votesmart_congress AS "votesmartCongress",
        created_at AS "createdAt";
    `,
      [
        id,
        title,
        chamber,
        afPosition,
        billDate,
        description,
        govLink,
        source,
        votesmartBillId,
        votesmartBillNumber,
        votesmartCongress,
      ]
    );

    res.status(201).json(insertResult.rows[0]);
  } catch (err) {
    console.error("Error creating bill:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// update a bill globally (admin)
// Also re-runs scores for all members who voted on it if afPosition changed.
app.put("/api/bills/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;

  const allowedFields = [
    "title",
    "chamber",
    "afPosition",
    "billDate",
    "description",
    "govLink",
    "source",
    "votesmartBillId",
    "votesmartBillNumber",
    "votesmartCongress",
  ];

  const updates = {};
  for (const key of allowedFields) {
    if (key in req.body) {
      updates[key] = req.body[key];
    }
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
    source: "source",
    votesmartBillId: "votesmart_bill_id",
    votesmartBillNumber: "votesmart_bill_number",
    votesmartCongress: "votesmart_congress",
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
      source,
      votesmart_bill_id AS "votesmartBillId",
      votesmart_bill_number AS "votesmartBillNumber",
      votesmart_congress AS "votesmartCongress",
      created_at AS "createdAt";
  `;

  try {
    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Bill not found" });
    }

    // Recompute scores for all members who voted on this bill
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

// delete a bill globally (admin)
app.delete("/api/bills/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    // Get affected members BEFORE delete (ON DELETE CASCADE will wipe votes)
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
        gov_link AS "govLink",
        source,
        votesmart_bill_id AS "votesmartBillId",
        votesmart_bill_number AS "votesmartBillNumber",
        votesmart_congress AS "votesmartCongress",
        created_at AS "createdAt";
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

// ===================
//  MEMBER <-> BILLS
// ===================

// get a member's bills + votes (public)
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
        b.source,
        b.votesmart_bill_id AS "votesmartBillId",
        b.votesmart_bill_number AS "votesmartBillNumber",
        b.votesmart_congress AS "votesmartCongress",
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

// add/update a member's vote on a bill (admin)
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

// remove a bill from a single member's record (admin)
app.delete(
  "/api/members/:id/bills/:billId",
  requireAdmin,
  async (req, res) => {
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
  }
);

// ===================
//  ADMIN BILL DOCKET
// ===================

// bills that have NOT yet been graded America First / Neither / Anti
// (af_position is NULL). Limit to bills from 2023 onward.
app.get("/api/admin/docket", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        id,
        title,
        chamber,
        af_position AS "afPosition",
        bill_date AS "billDate",
        description,
        gov_link AS "govLink",
        source,
        votesmart_bill_id AS "votesmartBillId",
        votesmart_bill_number AS "votesmartBillNumber",
        votesmart_congress AS "votesmartCongress",
        created_at AS "createdAt"
      FROM bills
      WHERE af_position IS NULL
        AND (bill_date IS NULL OR bill_date >= DATE '2023-01-01')
      ORDER BY bill_date DESC NULLS LAST, created_at DESC, title ASC
      LIMIT 500;
    `
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching docket bills:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// grade a bill as America First / Neither / Anti-America First
app.post("/api/admin/bills/:id/grade", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { afPosition } = req.body || {};

  const allowed = [
    "America First",
    "Neither",
    "Anti-America First",
    null,
    "",
  ];
  if (!allowed.includes(afPosition)) {
    return res.status(400).json({
      error:
        "afPosition must be one of 'America First', 'Neither', 'Anti-America First', or null",
    });
  }

  try {
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
        source,
        votesmart_bill_id AS "votesmartBillId",
        votesmart_bill_number AS "votesmartBillNumber",
        votesmart_congress AS "votesmartCongress",
        created_at AS "createdAt";
    `,
      [id, afPosition || null]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Bill not found" });
    }

    // recompute scores for every member who has a vote for this bill
    const mRes = await pool.query(
      `SELECT DISTINCT member_id FROM member_votes WHERE bill_id = $1`,
      [id]
    );
    for (const row of mRes.rows) {
      await recomputeScoresForMember(row.member_id);
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error grading bill:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ===================
//  VOTESMART BILL SYNC (SCAFFOLD)
// ===================

// NOTE: VoteSmart's exact parameter names/JSON shape can vary.
// This function is written to be easy to tweak once you confirm their docs.
async function fetchRecentBillsFromVoteSmartSince2023() {
  if (!VOTESMART_API_KEY) {
    throw new Error("VOTESMART_API_KEY is missing");
  }

  const baseUrl = "https://api.paas.votesmart.io/api/v1/votes/bills/by-state-recent";

  // We'll ask for recent federal bills (stateId 'US') and then
  // filter for bill dates >= 2023-01-01. Adjust state parameter
  // if VoteSmart uses something like 'stateAbbr' instead.
  const url = new URL(baseUrl);
  url.searchParams.set("key", VOTESMART_API_KEY);
  url.searchParams.set("stateId", "US"); // <-- verify in VoteSmart docs
  url.searchParams.set("amount", "200"); // "Max returned is 100" per docs – adjust as needed

  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `VoteSmart bills request failed: ${res.status} – ${text.slice(0, 200)}`
    );
  }

  const data = await res.json();

  // The exact shape depends on VoteSmart;
  // adapt these lines once you see the real JSON in logs.
  const bills =
    data.bills ||
    data.results ||
    data.data ||
    [];

  return bills;
}

// Admin: pull recent VoteSmart bills into our bills table as an unrated docket
app.post("/api/admin/sync-bills-votesmart", requireAdmin, async (req, res) => {
  try {
    if (!VOTESMART_API_KEY) {
      return res.status(500).json({
        error: "VoteSmart API key not configured on server (VOTESMART_API_KEY).",
      });
    }

    const rawBills = await fetchRecentBillsFromVoteSmartSince2023();

    console.log("VoteSmart sync: raw bills length =", rawBills.length);

    const client = await pool.connect();
    let inserted = 0;
    let updated = 0;

    try {
      await client.query("BEGIN");

      for (const b of rawBills) {
        // You *must* adjust these mappings once you inspect
        // a real VoteSmart JSON bill object in your logs.
        const vsId = String(b.billId || b.id || "").trim();
        if (!vsId) continue;

        const title =
          b.title || b.billTitle || b.shortTitle || "Untitled Bill";
        const chamberRaw =
          b.chamber || b.office || b.level || "";
        let chamber = null;
        if (chamberRaw.toLowerCase().includes("house")) chamber = "House";
        else if (chamberRaw.toLowerCase().includes("senate")) chamber = "Senate";

        const billNumber =
          b.billNumber || b.number || null;

        const congress =
          b.congress || b.session || null;

        let billDate = null;
        const dateStr = b.voteDate || b.introduced || b.date || null;
        if (dateStr) {
          billDate = dateStr.slice(0, 10); // yyyy-mm-dd
        }

        // stop once we hit 2022 and older
        if (billDate && billDate < "2023-01-01") {
          continue;
        }

        const govLink =
          b.billLink || b.url || null;

        const existing = await client.query(
          "SELECT id FROM bills WHERE votesmart_bill_id = $1",
          [vsId]
        );

        if (existing.rows.length > 0) {
          const existingId = existing.rows[0].id;
          await client.query(
            `
            UPDATE bills
            SET title = COALESCE($2, title),
                chamber = COALESCE($3, chamber),
                bill_date = COALESCE($4, bill_date),
                gov_link = COALESCE($5, gov_link),
                source = 'VoteSmart',
                votesmart_bill_number = COALESCE($6, votesmart_bill_number),
                votesmart_congress = COALESCE($7, votesmart_congress)
            WHERE id = $1
          `,
            [
              existingId,
              title,
              chamber,
              billDate,
              govLink,
              billNumber,
              congress,
            ]
          );
          updated++;
        } else {
          const id = crypto.randomUUID();
          await client.query(
            `
            INSERT INTO bills
              (id, title, chamber, af_position, bill_date, description,
               gov_link, source, votesmart_bill_id, votesmart_bill_number,
               votesmart_congress)
            VALUES
              ($1, $2, $3, NULL, $4, NULL,
               $5, 'VoteSmart', $6, $7, $8)
          `,
            [
              id,
              title,
              chamber,
              billDate,
              govLink,
              vsId,
              billNumber,
              congress,
            ]
          );
          inserted++;
        }
      }

      await client.query("COMMIT");

      res.json({
        success: true,
        inserted,
        updated,
        rawCount: rawBills.length,
        note:
          "Check server logs to confirm VoteSmart JSON shape; adjust field mappings in fetchRecentBillsFromVoteSmartSince2023 if needed.",
      });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Error syncing VoteSmart bills:", err);
      res.status(500).json({ error: "Error syncing VoteSmart bills" });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Error in /api/admin/sync-bills-votesmart:", err);
    res.status(500).json({ error: "Server error during VoteSmart sync" });
  }
});

// (Future expansion spot)
// To fully automate “after grading, attach votes to each politician”
// you’ll want to:
//   1) Ensure every politician has votesmart_candidate_id set.
//   2) For a given votesmart_bill_id, hit VoteSmart endpoints that return
//      per-candidate votes, map candidate_id -> politician, then insert
//      into member_votes. The DB and endpoints above are ready for that
//      next step.

// ===================
//  START SERVER
// ===================
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
