// /api/crm.js
// clientReady CRM. One record per client (keyed by email), stored in the existing Redis (REDIS_URL).
//
// Public:  POST ?action=intake            website forms (audit, checkout, onboarding) save here
//          GET  ?action=portal&t=TOKEN    a client's own portal view
//          POST ?action=request&t=TOKEN   a client asks for a change or approves something
// Admin:   header x-admin-key = ADMIN_KEY (same key as the leads dashboard)
//          GET  ?action=list | ?action=get&id=
//          POST ?action=update | ?action=create

const Redis = require('ioredis');
const crypto = require('crypto');

let redis = null;
function db() {
  if (!redis && process.env.REDIS_URL) {
    redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3, enableReadyCheck: false });
  }
  return redis;
}

const STAGES = ['lead', 'reserved', 'checkout', 'paid', 'onboarding', 'building', 'warmup', 'live', 'fullspeed', 'paused', 'cancelled'];
const PLANS = {
  launch:   { name: 'Launch',   emails: 5000,  price: 1097, lo: 5,  hi: 12 },
  growth:   { name: 'Growth',   emails: 10000, price: 1977, lo: 10, hi: 25 },
  scale:    { name: 'Scale',    emails: 20000, price: 3297, lo: 20, hi: 50 },
  dominate: { name: 'Dominate', emails: 40000, price: 5497, lo: 40, hi: 100 }
};
const REQUEST_TYPES = ['Approve', 'Change who we target', 'Change the emails', 'Change my calendar or meeting taker', 'Upgrade or change plan', 'Pause', 'Question', 'Other'];

const now = () => new Date().toISOString();
const newId = () => 'c_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
const newToken = () => crypto.randomBytes(18).toString('base64url');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clean(v, max) {
  if (v === null || v === undefined) return '';
  return String(v).trim().slice(0, max || 2000);
}
function cleanObj(o) {
  const out = {};
  if (!o || typeof o !== 'object') return out;
  Object.keys(o).slice(0, 60).forEach(k => {
    const key = clean(k, 80);
    if (!key || key.charAt(0) === '_') return;
    const v = o[k];
    out[key] = Array.isArray(v) ? v.map(x => clean(x, 500)).join(', ') : clean(v, 4000);
  });
  return out;
}
function int(v) { const n = parseInt(v, 10); return isFinite(n) && n >= 0 ? Math.min(n, 10000000) : 0; }

function isAdmin(req) {
  const k = process.env.ADMIN_KEY || '';
  const p = String(req.headers['x-admin-key'] || '');
  if (!k || !p) return false;
  const a = Buffer.from(k), b = Buffer.from(p);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function limited(r, req, max) {
  const ip = String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'x').split(',')[0].trim();
  const key = 'crm:rl:' + ip;
  const n = await r.incr(key);
  if (n === 1) await r.expire(key, 3600);
  return n > max;
}

async function load(r, id) {
  if (!id) return null;
  const s = await r.get('crm:c:' + id);
  return s ? JSON.parse(s) : null;
}
async function save(r, c) {
  c.updatedAt = now();
  await r.set('crm:c:' + c.id, JSON.stringify(c));
  await r.zadd('crm:idx', Date.now(), c.id);
  await r.set('crm:e:' + c.email, c.id);
  await r.set('crm:t:' + c.token, c.id);
}
function blank(email) {
  const t = now();
  return { id: newId(), token: newToken(), email, name: '', company: '', website: '', phone: '', plan: '',
    stage: 'lead', stageAt: t, createdAt: t, updatedAt: t, audit: null, checkout: null, onboarding: null,
    payment: null, notes: '', weeks: [], requests: [], updates: [], log: [] };
}
function log(c, text) {
  c.log = c.log || [];
  c.log.unshift({ at: now(), text: clean(text, 500) });
  c.log = c.log.slice(0, 300);
}
// Automatic moves only go forward, and never pull a client out of paused or cancelled.
function advance(c, stage) {
  if (c.stage === 'paused' || c.stage === 'cancelled') return;
  if (STAGES.indexOf(stage) > STAGES.indexOf(c.stage)) { c.stage = stage; c.stageAt = now(); }
}
function fill(c, b, overwrite) {
  ['name', 'company', 'website', 'phone'].forEach(f => {
    const v = clean(b[f], 300);
    if (v && (overwrite || !c[f])) c[f] = v;
  });
  if (PLANS[b.plan] && (overwrite || !c.plan)) c.plan = b.plan;
}
function summary(c) {
  return { id: c.id, email: c.email, name: c.name, company: c.company, website: c.website, plan: c.plan,
    stage: c.stage, stageAt: c.stageAt, createdAt: c.createdAt, updatedAt: c.updatedAt,
    openRequests: (c.requests || []).filter(q => q.status === 'open').length };
}
function portalView(c) {
  const p = PLANS[c.plan];
  return {
    name: c.name, company: c.company, email: c.email,
    plan: p ? Object.assign({ key: c.plan }, p) : null,
    stage: c.stage, stageAt: c.stageAt,
    startedAt: (c.payment && c.payment.at) || (c.onboarding && c.onboarding.at) || c.createdAt,
    weeks: c.weeks || [],
    updates: c.updates || [],
    requests: (c.requests || []).map(q => ({ id: q.id, at: q.at, type: q.type, message: q.message, status: q.status, reply: q.reply || '' })),
    requestTypes: REQUEST_TYPES
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  const action = String((req.query && req.query.action) || '');
  const r = db();
  if (!r) return res.status(503).json({ error: 'Database not connected (REDIS_URL missing)' });

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};

  try {
    // ---------- public: website forms ----------
    if (action === 'intake') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
      if (await limited(r, req, 40)) return res.status(429).json({ error: 'Too many requests' });
      const email = clean(b.email, 200).toLowerCase();
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Valid email required' });
      const type = clean(b.type, 20);
      if (['audit', 'checkout', 'onboarding'].indexOf(type) < 0) return res.status(400).json({ error: 'Unknown form type' });

      let c = await load(r, await r.get('crm:e:' + email));
      const isNew = !c;
      if (!c) c = blank(email);
      const data = Object.assign({ at: now() }, cleanObj(b.data));

      if (type === 'audit') {
        fill(c, b, false);
        c.audit = data;
        log(c, 'Completed the audit' + (data.Verdict ? ': ' + data.Verdict : ''));
      } else if (type === 'checkout') {
        fill(c, b, false);
        const early = STAGES.indexOf(c.stage) < STAGES.indexOf('paid');
        if (PLANS[b.plan] && early) c.plan = b.plan;
        data.live = b.live ? 'yes' : 'no';
        c.checkout = data;
        advance(c, b.live ? 'checkout' : 'reserved');
        log(c, (b.live ? 'Went to Stripe checkout for ' : 'Reserved a spot on ') + ((PLANS[c.plan] || {}).name || 'a plan'));
      } else {
        fill(c, b, STAGES.indexOf(c.stage) < STAGES.indexOf('building'));
        c.onboarding = data;
        const session = clean(b.session, 200);
        if (session) c.payment = { at: now(), session: session, note: 'Came back from Stripe checkout. Confirm the payment in Stripe.' };
        advance(c, 'onboarding');
        log(c, 'Sent the onboarding form');
      }
      if (isNew) log(c, 'New contact from the website');
      await save(r, c);
      return res.status(200).json({ ok: true });
    }

    // ---------- public: client portal (private link) ----------
    if (action === 'portal' || action === 'request') {
      const t = clean(req.query.t, 60);
      if (!/^[A-Za-z0-9_-]{20,40}$/.test(t)) return res.status(404).json({ error: 'Portal not found' });
      const c = await load(r, await r.get('crm:t:' + t));
      if (!c) return res.status(404).json({ error: 'Portal not found' });
      if (action === 'portal') return res.status(200).json(portalView(c));

      if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
      if (await limited(r, req, 30)) return res.status(429).json({ error: 'Too many requests' });
      const type = REQUEST_TYPES.indexOf(b.type) >= 0 ? b.type : 'Other';
      const message = clean(b.message, 2000);
      if (!message) return res.status(400).json({ error: 'Please write a message' });
      c.requests = c.requests || [];
      c.requests.unshift({ id: 'r_' + Date.now().toString(36), at: now(), type, message, status: 'open', reply: '' });
      c.requests = c.requests.slice(0, 200);
      log(c, 'Client request: ' + type);
      await save(r, c);
      return res.status(200).json(portalView(c));
    }

    // ---------- admin ----------
    if (!isAdmin(req)) return res.status(403).json({ error: 'Wrong admin key' });

    if (action === 'list') {
      const ids = await r.zrevrange('crm:idx', 0, 999);
      if (!ids.length) return res.status(200).json({ clients: [], stages: STAGES, plans: PLANS });
      const rows = await r.mget(ids.map(i => 'crm:c:' + i));
      const clients = rows.filter(Boolean).map(s => summary(JSON.parse(s)));
      return res.status(200).json({ clients, stages: STAGES, plans: PLANS });
    }

    if (action === 'get') {
      const c = await load(r, clean(req.query.id, 60));
      if (!c) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json({ client: c, stages: STAGES, plans: PLANS, requestTypes: REQUEST_TYPES });
    }

    if (action === 'create') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
      const email = clean(b.email, 200).toLowerCase();
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Valid email required' });
      const existing = await r.get('crm:e:' + email);
      if (existing) return res.status(409).json({ error: 'Already in the CRM', id: existing });
      const c = blank(email);
      fill(c, b, true);
      if (STAGES.indexOf(b.stage) >= 0) c.stage = b.stage;
      log(c, 'Added by hand');
      await save(r, c);
      return res.status(200).json({ client: c });
    }

    if (action === 'update') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
      const c = await load(r, clean(b.id, 60));
      if (!c) return res.status(404).json({ error: 'Not found' });
      const set = b.set || {};
      if (set.stage !== undefined) {
        if (STAGES.indexOf(set.stage) < 0) return res.status(400).json({ error: 'Unknown stage' });
        if (set.stage !== c.stage) { c.stage = set.stage; c.stageAt = now(); log(c, 'Stage set to ' + set.stage); }
      }
      if (set.plan !== undefined && (set.plan === '' || PLANS[set.plan])) c.plan = set.plan;
      ['name', 'company', 'website', 'phone'].forEach(f => { if (set[f] !== undefined) c[f] = clean(set[f], 300); });
      if (set.notes !== undefined) c.notes = clean(set.notes, 20000);
      if (b.addWeek) {
        const w = b.addWeek;
        const week = /^\d{4}-\d{2}-\d{2}$/.test(w.week) ? w.week : now().slice(0, 10);
        c.weeks = (c.weeks || []).filter(x => x.week !== week);
        c.weeks.push({ week, sent: int(w.sent), replies: int(w.replies), interested: int(w.interested), booked: int(w.booked), showed: int(w.showed) });
        c.weeks.sort((x, y) => (x.week < y.week ? 1 : -1));
        c.weeks = c.weeks.slice(0, 200);
        log(c, 'Weekly numbers added for ' + week);
      }
      if (b.removeWeek) c.weeks = (c.weeks || []).filter(x => x.week !== b.removeWeek);
      if (b.addUpdate) {
        const text = clean(b.addUpdate, 3000);
        if (text) { c.updates = c.updates || []; c.updates.unshift({ at: now(), text }); c.updates = c.updates.slice(0, 200); log(c, 'Posted an update to the portal'); }
      }
      if (b.removeUpdate) c.updates = (c.updates || []).filter(u => u.at !== b.removeUpdate);
      if (b.request && b.request.id) {
        const q = (c.requests || []).find(x => x.id === b.request.id);
        if (q) {
          if (b.request.reply !== undefined) q.reply = clean(b.request.reply, 2000);
          if (b.request.status === 'open' || b.request.status === 'done') q.status = b.request.status;
          log(c, 'Request ' + (q.status === 'done' ? 'closed' : 'updated') + ': ' + q.type);
        }
      }
      await save(r, c);
      return res.status(200).json({ client: c });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error('CRM error:', e && e.message);
    return res.status(500).json({ error: 'Server error' });
  }
};
