// Vercel serverless function — captures audit submissions into Vercel KV
// File path in repo: /api/lead-capture.js
// Setup: Vercel Dashboard → Storage → Create KV → Connect to clientready project

export default async function handler(req, res) {
  // CORS for safety
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const data = req.body || {};
  if (!data.email || !data.email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  const lead = {
    id: 'audit_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    email: String(data.email).trim().toLowerCase(),
    firm: String(data.firm || '').trim(),
    source: String(data.source || 'audit'),
    score: typeof data.score === 'number' ? data.score : null,
    leak: typeof data.leak === 'number' ? data.leak : null,
    grade: data.grade || '',
    answers: Array.isArray(data.answers) ? data.answers : [],
    fixes: Array.isArray(data.fixes) ? data.fixes : [],
    referrer: data.referrer || req.headers.referer || '',
    userAgent: req.headers['user-agent'] || '',
    ip: (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '').split(',')[0].trim(),
    createdAt: new Date().toISOString()
  };

  // Try Vercel KV
  try {
    const { kv } = await import('@vercel/kv');
    await kv.lpush('audit_leads', JSON.stringify(lead));
    await kv.incr('audit_leads_count');
  } catch (e) {
    // Fallback: log to Vercel Function logs so the lead is at least captured
    console.log('AUDIT_LEAD:', JSON.stringify(lead));
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
          subject: `New audit lead — ${lead.firm || lead.email} — Score ${lead.score}/100, ${lead.leak ? '$' + lead.leak.toLocaleString() : '—'} leak`,
          html: `<h2>New Intake Audit Submission</h2>
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
}
