// /api/crm.js
// clientReady CRM. One record per client (keyed by email), stored privately in Vercel Blob (store: clientready-crm).
//
// Public   POST ?action=intake                       website forms (audit, checkout, onboarding) save here
//          GET  ?action=health                       storage check
// Portal   GET  ?action=portal&t=TOKEN               a client's own view
//          POST ?action=request|decide|todo|meeting&t=TOKEN
//          GET  ?action=file&t=TOKEN&f=FILE          download a file shared with them
// Admin    header x-admin-key = ADMIN_KEY (same key as the leads dashboard)
//          GET  ?action=list | get&id= | file&id=&f=
//          POST ?action=create | update | upload

const { put, get, list, del } = require('@vercel/blob');
const crypto = require('crypto');

// ---------- storage ----------
const configured = () => !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
async function readBlob(path) {
  try {
    const r = await get(path, { access: 'private', useCache: false });
    if (!r || r.statusCode !== 200 || !r.stream) return null;
    return r;
  } catch (e) {
    if (e && /not\s*found/i.test(e.name + ' ' + e.message)) return null;
    throw e;
  }
}
async function readJSON(path) {
  const r = await readBlob(path);
  return r ? JSON.parse(await new Response(r.stream).text()) : null;
}
function writeJSON(path, obj) {
  return put(path, JSON.stringify(obj), { access: 'private', allowOverwrite: true, addRandomSuffix: false, contentType: 'application/json', cacheControlMaxAge: 60 });
}

// ---------- reference data ----------
const STAGES = ['lead', 'reserved', 'checkout', 'paid', 'onboarding', 'building', 'warmup', 'live', 'fullspeed', 'paused', 'cancelled'];
const ACTIVE = ['paid', 'onboarding', 'building', 'warmup', 'live', 'fullspeed'];
const PLANS = {
  launch:   { name: 'Launch',   emails: 5000,  price: 1097, lo: 5,  hi: 12,  reach: 1650,  inboxes: 10 },
  growth:   { name: 'Growth',   emails: 10000, price: 1977, lo: 10, hi: 25,  reach: 3300,  inboxes: 20 },
  scale:    { name: 'Scale',    emails: 20000, price: 3297, lo: 20, hi: 50,  reach: 6700,  inboxes: 40 },
  dominate: { name: 'Dominate', emails: 40000, price: 5497, lo: 40, hi: 100, reach: 13300, inboxes: 80 }
};
const INCL = {
  launch: ['Find ~1,650 verified decision makers a month who match your ideal client', 'Research every one and write each a personal email', 'Send 5,000 emails a month from your own network of 10 warmed inboxes, never your main domain', 'Answer interested replies and book meetings on your calendar', 'Weekly numbers in this portal'],
  growth: ['Find ~3,300 verified decision makers a month who match your ideal client', 'Research every one and write each a personal email', 'Send 10,000 emails a month from 20 warmed inboxes, with A/B testing', 'Book meetings and send show-up reminders before each call', 'Weekly numbers plus a monthly strategy review'],
  scale: ['Find ~6,700 verified decision makers a month who match your ideal client', 'Research every one and write each a personal email', 'Send 20,000 emails a month from 40 warmed inboxes, plus LinkedIn follow-up', 'Book meetings, send reminders and your intro video', 'Client intake when they say yes, and a strategy review every 2 weeks'],
  dominate: ['Find ~13,300 verified decision makers a month across two offers or markets', 'Research every one and write each a personal email', 'Send 40,000 emails a month from 80 warmed inboxes, plus LinkedIn follow-up', 'Book meetings, send reminders, your intro video and client intake', 'Weekly strategy review with the founder and priority support']
};
const REQUEST_TYPES = ['Question', 'Change who we target', 'Change the emails', 'Change my calendar or meeting taker', 'Upgrade or change plan', 'Pause', 'Cancel', 'Billing', 'Other'];
const KINDS = ['Target list', 'Sample emails', 'Sending setup', 'Weekly report', 'Monthly report', 'Strategy notes', 'Other'];

// ---------- helpers ----------
const now = () => new Date().toISOString();
const today = () => now().slice(0, 10);
const idFor = email => 'c_' + crypto.createHash('sha256').update(email).digest('hex').slice(0, 24);
const newToken = () => crypto.randomBytes(18).toString('base64url');
const sid = p => p + '_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
const int = v => { const n = parseInt(v, 10); return isFinite(n) && n >= 0 ? Math.min(n, 10000000) : 0; };
const bool = v => v === true || v === 'true' || v === 'on' || v === 1 || v === '1';
const url = v => { const s = clean(v, 1000); return /^https?:\/\/[^\s"'<>]+$/i.test(s) ? s : ''; };
const date = v => (DATE_RE.test(String(v || '')) ? String(v) : '');
const datetime = v => { const s = clean(v, 40); return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) ? s : ''; };
function addDays(d, n) { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function addMonths(d, n) { const x = new Date(d + 'T12:00:00Z'); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); }

// Field rules for each list on a client record.
const SCHEMA = {
  tasks:        { title: ['s', 200, true], due: ['date'], done: ['bool'], visible: ['bool'], group: ['s', 40] },
  todos:        { title: ['s', 200, true], detail: ['s', 1000], done: ['bool'] },
  deliverables: { title: ['s', 200, true], kind: ['enum', KINDS], text: ['s', 20000], link: ['url'], fileId: ['s', 40], needsApproval: ['bool'], status: ['enum', ['draft', 'shared', 'approved', 'changes']] },
  meetings:     { when: ['datetime', 0, true], prospect: ['s', 200, true], company: ['s', 200], title: ['s', 200], email: ['s', 200], phone: ['s', 60], link: ['url'], notes: ['s', 3000], status: ['enum', ['booked', 'showed', 'noshow', 'rescheduled', 'cancelled']] },
  updates:      { text: ['s', 3000, true] },
  requests:     { reply: ['s', 2000], status: ['enum', ['open', 'done']] }
};
const LIMITS = { tasks: 200, todos: 100, deliverables: 200, meetings: 2000, updates: 300, requests: 300 };
function sanitize(coll, item, partial) {
  const rules = SCHEMA[coll], out = {};
  if (!rules || !item || typeof item !== 'object') return null;
  for (const k of Object.keys(rules)) {
    if (!(k in item)) { if (!partial && rules[k][2]) return null; continue; }
    const [t, a] = rules[k], v = item[k];
    let val;
    if (t === 's') val = clean(v, a);
    else if (t === 'date') val = date(v);
    else if (t === 'datetime') val = datetime(v);
    else if (t === 'bool') val = bool(v);
    else if (t === 'url') val = url(v);
    else if (t === 'enum') val = a.indexOf(v) >= 0 ? v : a[0];
    if (rules[k][2] && !val) return null;
    out[k] = val;
  }
  return out;
}

const SETTABLE = {
  name: ['s', 300], company: ['s', 300], website: ['s', 300], phone: ['s', 60], notes: ['s', 20000],
  'billing.startDate': ['date'], 'billing.status': ['enum', ['', 'current', 'overdue', 'paused', 'ended']],
  'billing.stripeCustomer': ['url'], 'billing.paymentLink': ['url'],
  'delivery.domains': ['s', 2000], 'delivery.inboxes': ['s', 40], 'delivery.warmupStart': ['date'], 'delivery.sendStart': ['date'],
  'delivery.toolLink': ['url'], 'delivery.listLink': ['url'], 'delivery.calendarLink': ['url'], 'delivery.meetingTaker': ['s', 300]
};

function isAdmin(req) {
  const k = process.env.ADMIN_KEY || '';
  const p = String(req.headers['x-admin-key'] || '');
  if (!k || !p) return false;
  const a = Buffer.from(k), b = Buffer.from(p);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Light per-instance rate limit (Blob has no counters).
const hits = new Map();
function limited(req, max) {
  const ip = String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'x').split(',')[0].trim();
  const t = Date.now(), h = hits.get(ip) || { n: 0, t };
  if (t - h.t > 3600000) { h.n = 0; h.t = t; }
  h.n++; hits.set(ip, h);
  if (hits.size > 5000) hits.clear();
  return h.n > max;
}

// ---------- records ----------
function normalize(c) {
  ['tasks', 'todos', 'deliverables', 'meetings', 'files', 'weeks', 'updates', 'requests', 'log'].forEach(k => { if (!Array.isArray(c[k])) c[k] = []; });
  c.billing = c.billing || { startDate: '', status: '', stripeCustomer: '', paymentLink: '' };
  c.delivery = c.delivery || { domains: '', inboxes: '', warmupStart: '', sendStart: '', toolLink: '', listLink: '', calendarLink: '', meetingTaker: '' };
  return c;
}
async function load(id) {
  if (!id || !/^c_[a-f0-9]{24}$/.test(id)) return null;
  const c = await readJSON('crm/c/' + id + '.json');
  return c ? normalize(c) : null;
}
async function save(c) {
  c.updatedAt = now();
  const fresh = c._new; delete c._new;
  await writeJSON('crm/c/' + c.id + '.json', c);
  if (fresh) await writeJSON('crm/t/' + c.token + '.json', { id: c.id });
}
async function loadAll() {
  const paths = []; let cursor;
  do {
    const page = await list({ prefix: 'crm/c/', limit: 1000, cursor });
    page.blobs.forEach(b => paths.push(b.pathname));
    cursor = page.hasMore ? page.cursor : null;
  } while (cursor);
  const out = [];
  for (let i = 0; i < paths.length; i += 15) {
    const chunk = await Promise.all(paths.slice(i, i + 15).map(p => readJSON(p).catch(() => null)));
    chunk.forEach(c => { if (c) out.push(normalize(c)); });
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}
function blank(email) {
  const t = now();
  return normalize({ _new: true, id: idFor(email), token: newToken(), email, name: '', company: '', website: '', phone: '', plan: '',
    stage: 'lead', stageAt: t, createdAt: t, updatedAt: t, audit: null, checkout: null, onboarding: null, payment: null, notes: '' });
}
function log(c, text) {
  c.log.unshift({ at: now(), text: clean(text, 500) });
  c.log = c.log.slice(0, 400);
}
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

// The setup checklist each paying client gets, dated from their start date.
function applyTemplate(c) {
  const p = PLANS[c.plan];
  if (!p) return 0;
  if (!c.billing.startDate) c.billing.startDate = today();
  const s = c.billing.startDate, k = Object.keys(PLANS).indexOf(c.plan);
  const T = [
    [0, 'Review onboarding answers', false, 'Setup'],
    [1, 'Buy sending domains', true, 'Setup'],
    [2, 'Set up ' + p.inboxes + ' inboxes with SPF, DKIM and DMARC', true, 'Setup'],
    [2, 'Start inbox warm-up', true, 'Setup'],
    [3, 'Build the verified decision-maker list (~' + p.reach.toLocaleString('en-US') + ' a month)', true, 'Setup'],
    [3, 'Write sample emails in your voice', true, 'Setup'],
    [3, 'Share target list and sample emails for approval', true, 'Setup'],
    [5, 'Targets and emails approved', true, 'Setup']
  ];
  if (k >= 1) T.push([18, 'Set up show-up reminders', true, 'Launch']);
  if (k >= 2) T.push([18, 'Set up LinkedIn follow-up', true, 'Launch'], [18, 'Connect client intake for new deals', true, 'Launch']);
  if (k >= 3) T.push([18, 'Build the second offer or market campaign', true, 'Launch']);
  T.push([20, 'Load campaigns and send test emails', false, 'Launch'], [23, 'Check inbox health before launch', false, 'Launch'],
    [24, 'Sending starts', true, 'Launch'], [31, 'First weekly numbers posted', true, 'Launch'],
    [60, 'Month 2 review: list, emails and volume', true, 'Ongoing'], [89, '3-month results summary', true, 'Ongoing']);
  const have = new Set(c.tasks.map(t => t.title));
  let n = 0;
  T.forEach(([d, title, visible, group]) => {
    if (have.has(title)) return;
    c.tasks.push({ id: sid('t'), title, due: addDays(s, d), done: false, visible, group, at: now() }); n++;
  });
  c.tasks.sort((a, b) => (a.due || '9') < (b.due || '9') ? -1 : 1);
  const todo = [['Keep open slots on your calendar', 'Plan for about ' + p.lo + ' to ' + p.hi + ' meetings a month from month 3. Booking links work best with at least 10 open slots a week.'],
    ['Make sure someone takes every meeting', 'Tell us in Messages if the person taking meetings changes.']];
  if (k >= 2) todo.push(['Record a 60-second intro video', 'We send it to prospects before their call. A phone video is fine. Send us the link in Messages.']);
  const haveTodo = new Set(c.todos.map(t => t.title));
  todo.forEach(([title, detail]) => { if (!haveTodo.has(title)) c.todos.push({ id: sid('d'), title, detail, done: false, at: now() }); });
  if (!c.delivery.inboxes) c.delivery.inboxes = String(p.inboxes);
  if (!c.delivery.sendStart) c.delivery.sendStart = addDays(s, 24);
  const ob = c.onboarding || {};
  if (!c.delivery.calendarLink && url(ob['Calendar link'])) c.delivery.calendarLink = url(ob['Calendar link']);
  if (!c.delivery.meetingTaker && ob['Meeting taker']) c.delivery.meetingTaker = clean(ob['Meeting taker'], 300);
  if (n) log(c, 'Setup checklist created (' + n + ' steps)');
  return n;
}
function autoTemplate(c) {
  if (PLANS[c.plan] && ACTIVE.indexOf(c.stage) >= 0 && c.stage !== 'paid' && !c.tasks.length) applyTemplate(c);
}

function dates(c) {
  const s = c.billing.startDate;
  if (!s) return null;
  return { start: s, sendingStarts: c.delivery.sendStart || addDays(s, 24), fullSpeed: addMonths(s, 2), minimumEnds: addMonths(s, 3) };
}
function monthShown(c, m) {
  return c.weeks.filter(w => w.week.slice(0, 7) === m).reduce((a, w) => a + (w.showed || 0), 0);
}
function summary(c) {
  const t = today(), soon = addDays(t, 2), wk = addDays(t, 7), d = dates(c);
  return {
    id: c.id, email: c.email, name: c.name, company: c.company, website: c.website, plan: c.plan,
    stage: c.stage, stageAt: c.stageAt, createdAt: c.createdAt, updatedAt: c.updatedAt,
    startDate: c.billing.startDate, billingStatus: c.billing.status, minimumEnds: d ? d.minimumEnds : '',
    openRequests: c.requests.filter(q => q.status === 'open').length,
    tasksDue: c.tasks.filter(x => !x.done && x.due && x.due <= soon).map(x => ({ id: x.id, title: x.title, due: x.due })).slice(0, 8),
    tasksOpen: c.tasks.filter(x => !x.done).length, tasksTotal: c.tasks.length,
    changes: c.deliverables.filter(x => x.status === 'changes').map(x => x.title),
    awaiting: c.deliverables.filter(x => x.status === 'shared' && x.needsApproval).length,
    meetingsSoon: c.meetings.filter(m => m.status === 'booked' && m.when.slice(0, 10) >= t && m.when.slice(0, 10) <= wk).length,
    flagged: c.meetings.filter(m => m.outcome === 'notfit' && !m.reviewed).length,
    lastWeek: c.weeks.length ? c.weeks[0].week : '',
    monthShown: monthShown(c, t.slice(0, 7))
  };
}
function portalView(c) {
  const p = PLANS[c.plan];
  const files = {};
  c.files.forEach(f => { files[f.id] = { id: f.id, name: f.name, size: f.size }; });
  return {
    name: c.name, company: c.company, email: c.email, website: c.website,
    plan: p ? Object.assign({ key: c.plan, incl: INCL[c.plan] }, p) : null,
    stage: c.stage, stageAt: c.stageAt, dates: dates(c),
    calendarLink: c.delivery.calendarLink, meetingTaker: c.delivery.meetingTaker,
    tasks: c.tasks.filter(t => t.visible).map(t => ({ title: t.title, due: t.due, done: t.done, group: t.group })),
    todos: c.todos.map(t => ({ id: t.id, title: t.title, detail: t.detail, done: t.done })),
    deliverables: c.deliverables.filter(x => x.status !== 'draft').map(x => ({ id: x.id, title: x.title, kind: x.kind, text: x.text, link: x.link,
      file: x.fileId ? files[x.fileId] || null : null, needsApproval: x.needsApproval, status: x.status, clientNote: x.clientNote || '', at: x.sharedAt || x.at, decidedAt: x.decidedAt || '' })),
    meetings: c.meetings.map(m => ({ id: m.id, when: m.when, prospect: m.prospect, company: m.company, title: m.title, email: m.email, phone: m.phone,
      link: m.link, notes: m.notes, status: m.status, outcome: m.outcome || '', clientNote: m.clientNote || '' })),
    weeks: c.weeks, updates: c.updates,
    requests: c.requests.map(q => ({ id: q.id, at: q.at, type: q.type, message: q.message, status: q.status, reply: q.reply || '', repliedAt: q.repliedAt || '' })),
    onboarding: c.onboarding, requestTypes: REQUEST_TYPES
  };
}

async function sendFile(res, path, meta) {
  const r = await readBlob(path);
  if (!r) return res.status(404).json({ error: 'File not found' });
  const buf = Buffer.from(await new Response(r.stream).arrayBuffer());
  res.setHeader('Content-Type', meta.type || 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="' + String(meta.name).replace(/[^\w.\- ]+/g, '_') + '"');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(200);
  return res.end(buf);
}

// ---------- handler ----------
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  const action = String((req.query && req.query.action) || '');
  if (!configured()) return res.status(503).json({ error: 'CRM storage not connected' });

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};

  try {
    if (action === 'health') {
      if (limited(req, 10)) return res.status(429).json({ error: 'Too many requests' });
      const at = now();
      await writeJSON('crm/health.json', { at });
      const back = await readJSON('crm/health.json');
      return res.status(200).json({ ok: !!back && back.at === at });
    }

    // ---------- website forms ----------
    if (action === 'intake') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
      if (limited(req, 40)) return res.status(429).json({ error: 'Too many requests' });
      const email = clean(b.email, 200).toLowerCase();
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Valid email required' });
      const type = clean(b.type, 20);
      if (['audit', 'checkout', 'onboarding'].indexOf(type) < 0) return res.status(400).json({ error: 'Unknown form type' });
      let c = await load(idFor(email));
      const isNew = !c;
      if (!c) c = blank(email);
      const data = Object.assign({ at: now() }, cleanObj(b.data));
      if (type === 'audit') {
        fill(c, b, false);
        c.audit = data;
        log(c, 'Completed the audit' + (data.Verdict ? ': ' + data.Verdict : ''));
      } else if (type === 'checkout') {
        fill(c, b, false);
        if (PLANS[b.plan] && STAGES.indexOf(c.stage) < STAGES.indexOf('paid')) c.plan = b.plan;
        data.live = b.live ? 'yes' : 'no';
        c.checkout = data;
        advance(c, b.live ? 'checkout' : 'reserved');
        log(c, (b.live ? 'Went to Stripe checkout for ' : 'Reserved a spot on ') + ((PLANS[c.plan] || {}).name || 'a plan'));
      } else {
        fill(c, b, STAGES.indexOf(c.stage) < STAGES.indexOf('building'));
        c.onboarding = data;
        const session = clean(b.session, 200);
        if (session) c.payment = { at: now(), session, note: 'Came back from Stripe checkout. Confirm the payment in Stripe.' };
        advance(c, 'onboarding');
        if (!c.billing.startDate) c.billing.startDate = today();
        if (!c.billing.status) c.billing.status = 'current';
        log(c, 'Sent the onboarding form');
        autoTemplate(c);
      }
      if (isNew) log(c, 'New contact from the website');
      await save(c);
      return res.status(200).json({ ok: true });
    }

    // ---------- client portal (private link) ----------
    if (['portal', 'request', 'decide', 'todo', 'meeting'].indexOf(action) >= 0 || (action === 'file' && req.query.t)) {
      const t = clean(req.query.t, 60);
      if (!/^[A-Za-z0-9_-]{20,40}$/.test(t)) return res.status(404).json({ error: 'Portal not found' });
      const link = await readJSON('crm/t/' + t + '.json');
      const c = link && await load(link.id);
      if (!c) return res.status(404).json({ error: 'Portal not found' });
      if (action === 'portal') return res.status(200).json(portalView(c));
      if (action === 'file') {
        const fid = clean(req.query.f, 40);
        const shared = c.deliverables.some(x => x.status !== 'draft' && x.fileId === fid);
        const f = c.files.find(x => x.id === fid);
        if (!f || !shared) return res.status(404).json({ error: 'File not found' });
        return sendFile(res, 'crm/f/' + c.id + '/' + f.id, f);
      }
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
      if (limited(req, 60)) return res.status(429).json({ error: 'Too many requests' });

      if (action === 'request') {
        const type = REQUEST_TYPES.indexOf(b.type) >= 0 ? b.type : 'Other';
        const message = clean(b.message, 2000);
        if (!message) return res.status(400).json({ error: 'Please write a message' });
        c.requests.unshift({ id: sid('r'), at: now(), type, message, status: 'open', reply: '' });
        c.requests = c.requests.slice(0, LIMITS.requests);
        log(c, 'Client message: ' + type);
      } else if (action === 'decide') {
        const x = c.deliverables.find(d => d.id === b.id && d.status !== 'draft');
        if (!x) return res.status(404).json({ error: 'Not found' });
        const decision = b.decision === 'approved' ? 'approved' : 'changes';
        const note = clean(b.note, 2000);
        if (decision === 'changes' && !note) return res.status(400).json({ error: 'Tell us what to change' });
        x.status = decision; x.clientNote = note; x.decidedAt = now();
        log(c, (decision === 'approved' ? 'Client approved: ' : 'Client asked for changes: ') + x.title);
      } else if (action === 'todo') {
        const x = c.todos.find(d => d.id === b.id);
        if (!x) return res.status(404).json({ error: 'Not found' });
        x.done = bool(b.done); x.doneAt = x.done ? now() : '';
        log(c, 'Client ' + (x.done ? 'finished: ' : 'reopened: ') + x.title);
      } else if (action === 'meeting') {
        const m = c.meetings.find(d => d.id === b.id);
        if (!m) return res.status(404).json({ error: 'Not found' });
        const o = ['showed', 'noshow', 'notfit', 'won', ''].indexOf(b.outcome) >= 0 ? b.outcome : '';
        m.outcome = o; m.clientNote = clean(b.note, 1000); m.outcomeAt = now(); m.reviewed = false;
        if (o === 'showed' || o === 'won') m.status = 'showed';
        if (o === 'noshow') m.status = 'noshow';
        log(c, 'Client marked meeting with ' + m.prospect + ': ' + (o || 'cleared'));
      }
      await save(c);
      return res.status(200).json(portalView(c));
    }

    // ---------- admin ----------
    if (!isAdmin(req)) return res.status(403).json({ error: 'Wrong admin key' });
    const ref = { stages: STAGES, plans: PLANS, requestTypes: REQUEST_TYPES, kinds: KINDS };

    if (action === 'list') {
      const all = await loadAll();
      if (req.query.full === '1') return res.status(200).json(Object.assign({ clients: all }, ref));
      return res.status(200).json(Object.assign({ clients: all.map(summary) }, ref));
    }

    if (action === 'get') {
      const c = await load(clean(req.query.id, 60));
      if (!c) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json(Object.assign({ client: c, dates: dates(c) }, ref));
    }

    if (action === 'file') {
      const c = await load(clean(req.query.id, 60));
      const f = c && c.files.find(x => x.id === clean(req.query.f, 40));
      if (!f) return res.status(404).json({ error: 'File not found' });
      return sendFile(res, 'crm/f/' + c.id + '/' + f.id, f);
    }

    if (action === 'create') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
      const email = clean(b.email, 200).toLowerCase();
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Valid email required' });
      const existing = await load(idFor(email));
      if (existing) return res.status(409).json({ error: 'Already in the CRM', id: existing.id });
      const c = blank(email);
      fill(c, b, true);
      if (STAGES.indexOf(b.stage) >= 0) c.stage = b.stage;
      log(c, 'Added by hand');
      await save(c);
      return res.status(200).json(Object.assign({ client: c, dates: dates(c) }, ref));
    }

    if (action === 'upload') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
      const c = await load(clean(b.id, 60));
      if (!c) return res.status(404).json({ error: 'Not found' });
      const name = clean(b.name, 200) || 'file';
      const buf = Buffer.from(String(b.data || ''), 'base64');
      if (!buf.length) return res.status(400).json({ error: 'Empty file' });
      if (buf.length > 3 * 1024 * 1024) return res.status(413).json({ error: 'Files can be up to 3 MB' });
      const f = { id: sid('f'), name, size: buf.length, type: clean(b.type, 100) || 'application/octet-stream', at: now() };
      await put('crm/f/' + c.id + '/' + f.id, buf, { access: 'private', addRandomSuffix: false, contentType: f.type });
      c.files.unshift(f);
      log(c, 'Uploaded file ' + name);
      await save(c);
      return res.status(200).json(Object.assign({ client: c, dates: dates(c), file: f }, ref));
    }

    if (action === 'update') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
      const c = await load(clean(b.id, 60));
      if (!c) return res.status(404).json({ error: 'Not found' });
      const ops = Array.isArray(b.ops) ? b.ops.slice(0, 50) : [];
      for (const o of ops) {
        if (o.op === 'stage') {
          if (STAGES.indexOf(o.value) < 0) return res.status(400).json({ error: 'Unknown stage' });
          if (o.value !== c.stage) { c.stage = o.value; c.stageAt = now(); log(c, 'Stage set to ' + o.value); }
          if ((o.value === 'onboarding' || o.value === 'building') && !c.billing.startDate) c.billing.startDate = today();
          autoTemplate(c);
        } else if (o.op === 'plan') {
          if (o.value === '' || PLANS[o.value]) { c.plan = o.value; log(c, 'Plan set to ' + (o.value || 'none')); }
        } else if (o.op === 'set') {
          const rule = SETTABLE[o.field];
          if (!rule) continue;
          let v = o.value;
          if (rule[0] === 's') v = clean(v, rule[1]); else if (rule[0] === 'date') v = date(v); else if (rule[0] === 'url') v = url(v);
          else if (rule[0] === 'enum') v = rule[1].indexOf(v) >= 0 ? v : '';
          const parts = o.field.split('.');
          if (parts.length === 2) c[parts[0]][parts[1]] = v; else c[o.field] = v;
        } else if (o.op === 'add' && SCHEMA[o.coll] && o.coll !== 'requests') {
          const item = sanitize(o.coll, o.item, false);
          if (!item) return res.status(400).json({ error: 'Missing required fields for ' + o.coll });
          item.id = sid(o.coll.charAt(0)); item.at = now();
          if (o.coll === 'deliverables') { item.status = item.status || 'draft'; item.kind = item.kind || 'Other'; }
          if (o.coll === 'tasks' || o.coll === 'todos') item.done = !!item.done;
          if (o.coll === 'deliverables' && item.status !== 'draft') item.sharedAt = now();
          if (o.coll === 'meetings' && !item.status) item.status = 'booked';
          c[o.coll].unshift(item);
          c[o.coll] = c[o.coll].slice(0, LIMITS[o.coll]);
          if (o.coll === 'tasks') c.tasks.sort((x, y) => (x.due || '9') < (y.due || '9') ? -1 : 1);
          log(c, 'Added to ' + o.coll + ': ' + (item.title || item.prospect || (item.text || '').slice(0, 60)));
        } else if (o.op === 'edit' && SCHEMA[o.coll]) {
          const x = c[o.coll].find(i => i.id === o.id);
          if (!x) continue;
          const patch = sanitize(o.coll, o.item, true) || {};
          if (o.coll === 'deliverables' && patch.status && patch.status !== x.status) {
            if (patch.status === 'shared') { x.sharedAt = now(); x.decidedAt = ''; x.clientNote = x.clientNote || ''; }
            log(c, 'Deliverable "' + x.title + '" set to ' + patch.status);
          }
          if (o.coll === 'tasks' && 'done' in patch && patch.done !== x.done) { x.doneAt = patch.done ? now() : ''; log(c, (patch.done ? 'Done: ' : 'Reopened: ') + x.title); }
          if (o.coll === 'requests' && 'reply' in patch && patch.reply !== x.reply) x.repliedAt = now();
          if (o.coll === 'meetings' && o.reviewed) x.reviewed = true;
          Object.assign(x, patch);
          if (o.coll === 'tasks') c.tasks.sort((p, q) => (p.due || '9') < (q.due || '9') ? -1 : 1);
        } else if (o.op === 'remove' && (SCHEMA[o.coll] || o.coll === 'files')) {
          const before = c[o.coll].length;
          const gone = c[o.coll].find(i => i.id === o.id);
          c[o.coll] = c[o.coll].filter(i => i.id !== o.id);
          if (o.coll === 'files' && gone) {
            try { await del(gone.url || ('crm/f/' + c.id + '/' + gone.id)); } catch (e) { /* file may already be gone */ }
            c.deliverables.forEach(d => { if (d.fileId === gone.id) d.fileId = ''; });
          }
          if (c[o.coll].length < before) log(c, 'Removed from ' + o.coll);
        } else if (o.op === 'week') {
          const w = o.item || {};
          const week = date(w.week) || today();
          c.weeks = c.weeks.filter(x => x.week !== week);
          c.weeks.push({ week, sent: int(w.sent), replies: int(w.replies), interested: int(w.interested), booked: int(w.booked), showed: int(w.showed) });
          c.weeks.sort((x, y) => (x.week < y.week ? 1 : -1));
          c.weeks = c.weeks.slice(0, 260);
          log(c, 'Weekly numbers saved for ' + week);
        } else if (o.op === 'removeWeek') {
          c.weeks = c.weeks.filter(x => x.week !== o.week);
        } else if (o.op === 'template') {
          applyTemplate(c);
        } else if (o.op === 'newToken') {
          const old = c.token; c.token = newToken();
          await writeJSON('crm/t/' + c.token + '.json', { id: c.id });
          try { await del('crm/t/' + old + '.json'); } catch (e) { /* ignore */ }
          log(c, 'Portal link replaced (old link stops working)');
        }
      }
      await save(c);
      return res.status(200).json(Object.assign({ client: c, dates: dates(c) }, ref));
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error('CRM error:', e && e.message);
    return res.status(500).json({ error: 'Server error' });
  }
};
