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
  "NUtl5kWwSI4bWZKgjAbWxwALpFfL3gHWFPrwh0P0"; // you can remove the fallback later

if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set. Please add it in Render environment.");
}

if (!CONGRESS_API_KEY) {
  console.error("CONGRESS_API_KEY is not set. Congress auto-sync will fail.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// --- helper: recompute scores based on bills/votes ---
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

    // Ignore unclassified/"Neither"
    if (!afPos || afPos === "Neither") continue;

    // Only count clear yes/no
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

// --- middleware ---
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

// --- DB bootstrap ---
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

  // make sure bioguide_id exists on older deploys
  await pool.query(`
    ALTER TABLE politicians
    ADD COLUMN IF NOT EXISTS bioguide_id TEXT UNIQUE;
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
      gov_link TEXT
    );
  `);

  // member_votes: link politician -> bill with their vote
  await pool.query(`
    CREATE TABLE IF NOT EXISTS member_votes (
      id UUID PRIMARY KEY,
      member_id UUID REFERENCES politicians(id) ON DELETE CASCADE,
      bill_id UUID REFERENCES bills(id) ON DELETE CASCADE,
      vote TEXT,                  -- "Approved", "Opposed", "Abstained"
      created_at TIMESTAMPTZ DEFAULT now(),
      CONSTRAINT member_votes_unique UNIQUE (member_id, bill_id)
    );
  `);

  await pool.query(`
    ALTER TABLE member_votes
    ADD COLUMN IF NOT EXISTS is_current_congress BOOLEAN DEFAULT FALSE;
  `);

  // Seed politicians the first time
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
//  CONGRESS.GOV SYNC
// ===================

// Helper: fetch all current members from Congress.gov for a given Congress
async function fetchCurrentMembersForCongress(congressNumber = 118) {
  if (!CONGRESS_API_KEY) {
    throw new Error("CONGRESS_API_KEY is missing");
  }

  const baseUrl = `https://api.congress.gov/v3/member/congress/${congressNumber}`;
  const limit = 250;
  let offset = 0;
  let all = [];

  while (true) {
    const url = new URL(baseUrl);
    url.searchParams.set("api_key", CONGRESS_API_KEY);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));

    const resp = await fetch(url);
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(
        `Congress.gov member request failed: ${resp.status} – ${text.slice(
          0,
          200
        )}`
      );
    }

    const data = await resp.json();
    const members = Array.isArray(data.members) ? data.members : [];
    all = all.concat(members);

    const pagination = data.pagination || {};
    if (!pagination.next) break;

    offset += limit;
    if (pagination.count != null && offset >= pagination.count) break;
  }

  return all;
}

// Normalize raw Congress.gov member objects into our schema
function normalizeCongressMembers(rawMembers) {
  return rawMembers
    .map((wrapper) => {
      const m = wrapper.member || wrapper; // handles both shapes

      const bioguideId = m.bioguideId || null;

      const fullName =
        m.fullName ||
        [m.firstName, m.lastName].filter(Boolean).join(" ") ||
        null;

      // Chamber and status can live in different places depending on variant
      const chamber =
        m.chamber ||
        m.latestStatus?.chamber ||
        m.terms?.[m.terms.length - 1]?.chamber ||
        null;

      const state =
        m.state ||
        m.latestStatus?.state ||
        m.terms?.[m.terms.length - 1]?.state ||
        null;

      const partyRaw =
        m.party ||
        m.partyName ||
        m.latestStatus?.party ||
        m.terms?.[m.terms.length - 1]?.party ||
        null;

      let party = partyRaw;
      if (party) {
        const p = party.toLowerCase();
        if (p.startsWith("republican")) party = "R";
        else if (p.startsWith("democrat")) party = "D";
        else if (p.startsWith("independent")) party = "I";
        else party = partyRaw.substring(0, 3).toUpperCase();
      }

      let chamberNorm = chamber;
      if (chamberNorm === "House of Representatives") chamberNorm = "House";
      if (chamberNorm) {
        chamberNorm =
          chamberNorm.charAt(0).toUpperCase() +
          chamberNorm.slice(1).toLowerCase();
      }

      const stateNorm = state ? state.toUpperCase() : null;

      return {
        bioguideId,
        name: fullName,
        chamber: chamberNorm,
        state: stateNorm,
        party,
      };
    })
    .filter(
      (m) =>
        m.bioguideId &&
        m.name &&
        m.chamber &&
        m.state &&
        m.party
    );
}

// Admin-only endpoint to sync all current House/Senate members into politicians
app.post("/api/admin/sync-members", requireAdmin, async (req, res) => {
  try {
    const congressNumber = Number(req.body?.congress) || 118;

    const rawMembers = await fetchCurrentMembersForCongress(congressNumber);
    const normalized = normalizeCongressMembers(rawMembers);

    console.log(
      `Congress sync: fetched ${rawMembers.length} raw, ${normalized.length} usable members.`
    );

    const client = await pool.connect();
    let importedCount = 0;
    let updatedCount = 0;

    try {
      await client.query("BEGIN");

      // Get current max position so new members go to the bottom
      const posRes = await client.query(
        "SELECT COALESCE(MAX(position), 0) AS maxpos FROM politicians"
      );
      let nextPosition = Number(posRes.rows[0].maxpos) || 0;

      for (const m of normalized) {
        // does this bioguide already exist?
        const existing = await client.query(
          "SELECT id FROM politicians WHERE bioguide_id = $1",
          [m.bioguideId]
        );

        if (existing.rows.length > 0) {
          const id = existing.rows[0].id;
          await client.query(
            `
            UPDATE politicians
            SET name = $2,
                chamber = $3,
                state = $4,
                party = $5
            WHERE id = $1
          `,
            [id, m.name, m.chamber, m.state, m.party]
          );
          updatedCount++;
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
          importedCount++;
        }
      }

      await client.query("COMMIT");
      res.json({
        success: true,
        imported: importedCount,
        updated: updatedCount,
        totalFromCongressApi: rawMembers.length,
        usableMembers: normalized.length,
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

// login -> returns token if password matches ADMIN_PASSWORD
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
          gov_link AS "govLink"
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
          gov_link AS "govLink"
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
    } = req.body || {};

    if (!title) {
      return res.status(400).json({ error: "Title is required" });
    }

    const id = crypto.randomUUID();
    const insertResult = await pool.query(
      `
      INSERT INTO bills
        (id, title, chamber, af_position, bill_date, description, gov_link)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7)
      RETURNING
        id,
        title,
        chamber,
        af_position AS "afPosition",
        bill_date AS "billDate",
        description,
        gov_link AS "govLink";
    `,
      [id, title, chamber, afPosition, billDate, description, govLink]
    );

    res.status(201).json(insertResult.rows[0]);
  } catch (err) {
    console.error("Error creating bill:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// update a bill globally (admin)
app.put("/api/bills/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;

  const allowedFields = [
    "title",
    "chamber",
    "afPosition",
    "billDate",
    "description",
    "govLink",
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
      gov_link AS "govLink";
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
    // get affected members BEFORE delete (ON DELETE CASCADE will wipe votes)
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
      return res.status(404).json({ error: "Vote not found for this member/bill" });
    }

    await recomputeScoresForMember(memberId);

    res.json({ success: true });
  } catch (err) {
    console.error("Error deleting member vote:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// --- start ---
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
