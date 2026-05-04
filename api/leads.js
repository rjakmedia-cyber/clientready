// GET /api/leads — returns all audit leads. Protected by ?key= matching ADMIN_KEY env var.
// File path in repo: /api/leads.js

const Redis = require('ioredis');

let redis = null;
function getRedis() {
  if (!redis && process.env.REDIS_URL) {
    redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: false,
      lazyConnect: false
    });
  }
  return redis;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Admin key gate — fail closed: if ADMIN_KEY is unset, deny by default
  const provided = req.query.key || req.headers['x-admin-key'];
  if (!process.env.ADMIN_KEY) {
    return res.status(503).json({ error: 'Server not configured: ADMIN_KEY missing' });
  }
  if (provided !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Unauthorized — append ?key=YOUR_ADMIN_KEY' });
  }

  try {
    const r = getRedis();
    if (!r) {
      return res.status(200).json({
        leads: [],
        count: 0,
        note: 'Redis not configured. Set REDIS_URL via Vercel Storage → Connect.'
      });
    }
    const items = await r.lrange('audit_leads', 0, -1);
    const leads = items.map(s => {
      try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return s; }
    });
    const count = parseInt(await r.get('audit_leads_count'), 10) || leads.length;
    return res.status(200).json({ leads, count });
  } catch (e) {
    return res.status(500).json({
      error: 'Redis read failed',
      message: e.message
    });
  }
};
