const { pool, init, dbUnavailable } = require('../core');

const VALID_STATUSES = new Set(['new', 'contacted', 'qualified', 'won', 'lost']);

function normalizeLeadLimit(value, fallback = 50, max = 200) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function normalizeDays(value, fallback = 30, max = 365) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

async function createTeamLead(payload = {}) {
  await init();
  if (dbUnavailable()) throw new Error('DATASTORE_UNAVAILABLE');

  const {
    user_id = null,
    visitor_id = null,
    name,
    email,
    organization,
    role = null,
    team_size = null,
    use_case = null,
    source = 'pricing',
    intent = 'team',
    ip = null,
    user_agent = null,
  } = payload;

  const { rows } = await pool.query(
    `INSERT INTO team_leads (
       user_id, visitor_id, name, email, organization, role, team_size,
       use_case, source, intent, ip, user_agent, created_at, updated_at
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),NOW())
     RETURNING *`,
    [
      user_id,
      visitor_id,
      name,
      email,
      organization,
      role,
      team_size,
      use_case,
      source,
      intent,
      ip,
      user_agent,
    ],
  );
  return rows[0];
}

async function listTeamLeads({ status = null, limit = 50, offset = 0 } = {}) {
  await init();
  if (dbUnavailable()) throw new Error('DATASTORE_UNAVAILABLE');

  const values = [];
  const where = [];
  let idx = 1;
  if (status && VALID_STATUSES.has(String(status))) {
    where.push(`status = $${idx++}`);
    values.push(String(status));
  }
  values.push(normalizeLeadLimit(limit));
  values.push(Math.max(0, Number(offset) || 0));

  const { rows } = await pool.query(
    `SELECT *
       FROM team_leads
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC
      LIMIT $${idx++} OFFSET $${idx}`,
    values,
  );
  return rows;
}

async function updateTeamLead(id, updates = {}) {
  await init();
  if (dbUnavailable()) throw new Error('DATASTORE_UNAVAILABLE');

  const leadId = Number(id);
  if (!Number.isInteger(leadId) || leadId <= 0) throw new Error('INVALID_LEAD_ID');

  const sets = [];
  const values = [leadId];
  let idx = 2;
  if (updates.status != null) {
    const status = String(updates.status);
    if (!VALID_STATUSES.has(status)) throw new Error('INVALID_STATUS');
    sets.push(`status = $${idx++}`);
    values.push(status);
  }
  if (updates.notes != null) {
    sets.push(`notes = $${idx++}`);
    values.push(String(updates.notes).slice(0, 2000));
  }

  if (!sets.length) {
    const { rows } = await pool.query(`SELECT * FROM team_leads WHERE id = $1`, [leadId]);
    return rows[0] || null;
  }

  const { rows } = await pool.query(
    `UPDATE team_leads
        SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    values,
  );
  return rows[0] || null;
}

async function getTeamLeadStats({ days = 30 } = {}) {
  await init();
  const normalizedDays = normalizeDays(days);
  const empty = {
    days: normalizedDays,
    summary: {
      total_leads: 0,
      unique_contacts: 0,
      new_leads: 0,
      contacted_leads: 0,
      qualified_leads: 0,
      won_leads: 0,
      lost_leads: 0,
    },
    daily: [],
    sources: [],
    recent: [],
  };
  if (dbUnavailable()) return empty;

  const [summaryResult, dailyResult, sourcesResult, recentResult] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*)::int AS total_leads,
         COUNT(DISTINCT lower(email))::int AS unique_contacts,
         COUNT(*) FILTER (WHERE status = 'new')::int AS new_leads,
         COUNT(*) FILTER (WHERE status = 'contacted')::int AS contacted_leads,
         COUNT(*) FILTER (WHERE status = 'qualified')::int AS qualified_leads,
         COUNT(*) FILTER (WHERE status = 'won')::int AS won_leads,
         COUNT(*) FILTER (WHERE status = 'lost')::int AS lost_leads
       FROM team_leads
       WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')`,
      [normalizedDays],
    ),
    pool.query(
      `WITH days AS (
         SELECT generate_series(
           (CURRENT_DATE - (($1::int - 1) * INTERVAL '1 day'))::date,
           CURRENT_DATE,
           '1 day'::interval
         )::date AS date
       ),
       daily AS (
         SELECT
           created_at::date AS date,
           COUNT(*)::int AS leads,
           COUNT(*) FILTER (WHERE status IN ('qualified', 'won'))::int AS qualified_or_won
         FROM team_leads
         WHERE created_at >= CURRENT_DATE - (($1::int - 1) * INTERVAL '1 day')
         GROUP BY created_at::date
       )
       SELECT
         days.date::text AS date,
         COALESCE(daily.leads, 0)::int AS leads,
         COALESCE(daily.qualified_or_won, 0)::int AS qualified_or_won
       FROM days
       LEFT JOIN daily ON daily.date = days.date
       ORDER BY days.date ASC`,
      [normalizedDays],
    ),
    pool.query(
      `SELECT
         COALESCE(NULLIF(source, ''), 'direct') AS source,
         COALESCE(NULLIF(intent, ''), '-') AS intent,
         COUNT(*)::int AS leads,
         COUNT(DISTINCT lower(email))::int AS contacts
       FROM team_leads
       WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
       GROUP BY source, intent
       ORDER BY leads DESC, contacts DESC
       LIMIT 12`,
      [normalizedDays],
    ),
    pool.query(
      `SELECT id, name, email, organization, role, team_size, source, intent, status, created_at
       FROM team_leads
       WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
       ORDER BY created_at DESC
       LIMIT 12`,
      [normalizedDays],
    ),
  ]);

  return {
    days: normalizedDays,
    summary: summaryResult.rows[0] || empty.summary,
    daily: dailyResult.rows,
    sources: sourcesResult.rows,
    recent: recentResult.rows,
  };
}

module.exports = {
  createTeamLead,
  listTeamLeads,
  updateTeamLead,
  getTeamLeadStats,
};
