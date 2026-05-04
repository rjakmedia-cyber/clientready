// GET /api/leads — returns all audit leads. Protected by ?key= matching ADMIN_KEY env var.
// File path in repo: /api/leads.js

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Simple admin key gate
  const provided = req.query.key || req.headers['x-admin-key'];
  if (process.env.ADMIN_KEY && provided !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Unauthorized — append ?key=YOUR_ADMIN_KEY' });
  }

  try {
    const { kv } = await import('@vercel/kv');
    const items = await kv.lrange('audit_leads', 0, -1);
    const leads = items.map(s => {
      try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return s; }
    });
    const count = (await kv.get('audit_leads_count')) || leads.length;
    return res.status(200).json({ leads, count });
  } catch (e) {
    return res.status(200).json({
      leads: [],
      count: 0,
      note: 'Vercel KV not configured. Enable it at vercel.com/storage and connect to this project.'
    });
  }
}
