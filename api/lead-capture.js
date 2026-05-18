// Vercel serverless function — captures audit submissions into Redis (Vercel Marketplace)
// File path in repo: /api/lead-capture.js
// Requires REDIS_URL env var (auto-injected by the Vercel Marketplace Redis integration)

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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const data = req.body || {};
  if (!data.email || !data.email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  const source = String(data.source || 'audit');
  const isPrefix = source === 'strategy-funnel' ? 'sf' : (source === 'workshop' ? 'ws' : 'audit');

  const lead = {
    id: isPrefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    email: String(data.email).trim().toLowerCase(),
    firm: String(data.firm || data.company || '').trim(),
    source: source,

    // Strategy-funnel custom fields (all optional, kept null if absent)
    name: data.name ? String(data.name).trim() : null,
    role: data.role || null,
    domain: data.domain ? String(data.domain).trim() : null,
    industry: data.industry || null,
    arr: data.arr || null,
    acv: data.acv || null,
    channels: data.channels || null,
    meetings: data.meetings || null,
    whyNow: data['why-now'] || data.whyNow || null,
    notes: data.notes ? String(data.notes).trim() : null,

    // Audit-tool legacy fields (kept for backwards compatibility)
    score: typeof data.score === 'number' ? data.score : null,
    leak: typeof data.leak === 'number' ? data.leak : null,
    grade: data.grade || '',
    answers: Array.isArray(data.answers) ? data.answers : [],
    fixes: Array.isArray(data.fixes) ? data.fixes : [],

    // Meta
    referrer: data.referrer || req.headers.referer || '',
    userAgent: req.headers['user-agent'] || '',
    ip: (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '').split(',')[0].trim(),
    createdAt: data.submitted_at || new Date().toISOString()
  };

  // Persist to Redis
  try {
    const r = getRedis();
    if (r) {
      await r.lpush('audit_leads', JSON.stringify(lead));
      await r.incr('audit_leads_count');
    } else {
      console.log('AUDIT_LEAD (no Redis):', JSON.stringify(lead));
    }
  } catch (e) {
    console.error('Redis write failed:', e.message);
    console.log('AUDIT_LEAD (fallback):', JSON.stringify(lead));
  }

  // Optional: send notification email via Resend if RESEND_API_KEY is set
  if (process.env.RESEND_API_KEY) {
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'leads@clientready.agency',
          to: process.env.NOTIFY_EMAIL || 'rich@clientready.agency',
          subject: `🔥 New ${lead.source === 'strategy-funnel' ? 'STRATEGY CALL' : 'audit'} lead — ${lead.firm || lead.email}`,
          html: lead.source === 'strategy-funnel'
            ? `<h2>🔥 New Strategy Call Funnel Submission</h2>
              <table style="border-collapse:collapse">
                <tr><td><b>Name:</b></td><td>${lead.name || '—'}</td></tr>
                <tr><td><b>Email:</b></td><td>${lead.email}</td></tr>
                <tr><td><b>Company:</b></td><td>${lead.firm || '—'}</td></tr>
                <tr><td><b>Domain:</b></td><td><a href="https://${lead.domain}">${lead.domain || '—'}</a></td></tr>
                <tr><td><b>Role:</b></td><td>${lead.role || '—'}</td></tr>
                <tr><td><b>Industry:</b></td><td>${lead.industry || '—'}</td></tr>
                <tr><td><b>Revenue:</b></td><td>${lead.arr || '—'}</td></tr>
                <tr><td><b>ACV:</b></td><td>${lead.acv || '—'}</td></tr>
                <tr><td><b>Current channels:</b></td><td>${lead.channels || '—'}</td></tr>
                <tr><td><b>Meetings/mo:</b></td><td>${lead.meetings || '—'}</td></tr>
                <tr><td><b>Why now:</b></td><td>${lead.whyNow || '—'}</td></tr>
                <tr><td><b>Notes:</b></td><td>${lead.notes || '—'}</td></tr>
              </table>
              <p style="margin-top:16px"><a href="https://clientready.agency/leads.html">Open the leads dashboard →</a></p>`
            : `<h2>New Intake Audit Submission</h2>
              <p><b>Email:</b> ${lead.email}<br>
              <b>Firm:</b> ${lead.firm || '—'}<br>
              <b>Score:</b> ${lead.score}/100 (${lead.grade})<br>
              <b>Estimated leak:</b> ${lead.leak ? '$' + lead.leak.toLocaleString() + '/yr' : '—'}<br>
              <b>Source:</b> ${lead.source}<br>
              <b>Time:</b> ${lead.createdAt}</p>
              <p><a href="https://clientready.agency/leads.html">Open the leads dashboard →</a></p>`
        })
      });
    } catch (_) {}
  }

  return res.status(200).json({ success: true, id: lead.id });
};
