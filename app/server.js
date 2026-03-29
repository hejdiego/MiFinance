const express = require('express');
const cors = require('cors');
const session = require('express-session');
const path = require('path');

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'mm-secret-dev-2025',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 30 * 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ── Notion API helper ─────────────────────────────────────────────────────
async function notion(token, method, endpoint, body = null) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`https://api.notion.com/v1${endpoint}`, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || JSON.stringify(data));
  return data;
}

async function queryAll(token, dbId, filter = null, sorts = null) {
  let results = [], cursor;
  do {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (sorts)  body.sorts  = sorts;
    if (cursor) body.start_cursor = cursor;
    const d = await notion(token, 'POST', `/databases/${dbId}/query`, body);
    results = results.concat(d.results);
    cursor = d.has_more ? d.next_cursor : undefined;
  } while (cursor);
  return results;
}

// ── OAuth ─────────────────────────────────────────────────────────────────
// Step 1: Redirect to Notion OAuth
app.get('/auth/notion', (req, res) => {
  const clientId = process.env.NOTION_CLIENT_ID;
  if (!clientId) {
    // Dev mode: accept manual token
    return res.redirect('/?mode=manual');
  }
  const redirectUri = encodeURIComponent(`${req.protocol}://${req.headers.host}/auth/callback`);
  const url = `https://api.notion.com/v1/oauth/authorize?client_id=${clientId}&response_type=code&owner=user&redirect_uri=${redirectUri}`;
  res.redirect(url);
});

// Step 2: OAuth callback
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  const clientId     = process.env.NOTION_CLIENT_ID;
  const clientSecret = process.env.NOTION_CLIENT_SECRET;

  // Forzar siempre HTTPS y tu dominio Railway
  const redirectUri  = "https://mifinance-production.up.railway.app/auth/callback";

  try {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const response = await fetch('https://api.notion.com/v1/oauth/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error_description || 'OAuth failed');
    req.session.token = data.access_token;
    req.session.workspaceName = data.workspace_name;
    req.session.ownerName = data.owner?.user?.name || '';
    res.redirect('/?onboarding=1');
  } catch (e) {
    res.redirect(`/?error=${encodeURIComponent(e.message)}`);
  }
});

// Manual token login (fallback for dev or self-hosted)
app.post('/auth/manual', async (req, res) => {
  const { token } = req.body;
  try {
    const user = await notion(token, 'GET', '/users/me');
    req.session.token = token;
    req.session.ownerName = user.name || '';
    req.session.workspaceName = 'My Workspace';
    res.json({ ok: true, name: user.name });
  } catch (e) {
    res.status(401).json({ ok: false, error: e.message });
  }
});

app.get('/auth/status', (req, res) => {
  res.json({
    authenticated: !!req.session.token,
    name: req.session.ownerName || '',
    workspace: req.session.workspaceName || '',
    hasConfig: !!req.session.config,
    config: req.session.config || null,
    oauthEnabled: !!process.env.NOTION_CLIENT_ID,
  });
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// ── Onboarding: list databases ─────────────────────────────────────────────
app.get('/api/databases', async (req, res) => {
  if (!req.session.token) return res.status(401).json({ ok: false, error: 'Not authenticated' });
  try {
    const data = await notion(req.session.token, 'POST', '/search', {
      filter: { value: 'database', property: 'object' },
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
    });
    const dbs = data.results.map(db => ({
      id: db.id.replace(/-/g, ''),
      name: db.title?.[0]?.plain_text || 'Sin nombre',
      icon: db.icon?.emoji || null,
    }));
    res.json({ ok: true, databases: dbs });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── Onboarding: get DB schema ──────────────────────────────────────────────
app.get('/api/database/:id/schema', async (req, res) => {
  if (!req.session.token) return res.status(401).json({ ok: false, error: 'Not authenticated' });
  try {
    const db = await notion(req.session.token, 'GET', `/databases/${req.params.id}`);
    const props = Object.entries(db.properties).map(([name, prop]) => ({
      name,
      type: prop.type,
      options: prop.select?.options?.map(o => ({ id: o.id, name: o.name, color: o.color }))
            || prop.multi_select?.options?.map(o => ({ id: o.id, name: o.name, color: o.color }))
            || [],
      relationDbId: prop.relation?.database_id?.replace(/-/g, '') || null,
    }));
    res.json({ ok: true, title: db.title?.[0]?.plain_text || 'DB', props });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── Onboarding: get relation DB options ───────────────────────────────────
app.get('/api/database/:id/options', async (req, res) => {
  if (!req.session.token) return res.status(401).json({ ok: false, error: 'Not authenticated' });
  try {
    const pages = await queryAll(req.session.token, req.params.id);
    const options = pages.map(p => {
      const titleProp = Object.values(p.properties).find(prop => prop.type === 'title');
      return { id: p.id, name: titleProp?.title?.[0]?.plain_text || 'Sin nombre' };
    }).filter(o => o.name !== 'Sin nombre');
    res.json({ ok: true, options });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── Save config ────────────────────────────────────────────────────────────
app.post('/api/config', (req, res) => {
  if (!req.session.token) return res.status(401).json({ ok: false, error: 'Not authenticated' });
  req.session.config = req.body;
  res.json({ ok: true });
});

// ── Load transactions ──────────────────────────────────────────────────────
app.get('/api/transactions', async (req, res) => {
  if (!req.session.token) return res.status(401).json({ ok: false, error: 'Not authenticated' });
  const cfg = req.session.config;
  if (!cfg) return res.status(400).json({ ok: false, error: 'No config' });

  try {
    const rows = await queryAll(req.session.token, cfg.databaseId, null, [
      { property: cfg.fields.date, direction: 'descending' }
    ]);

    const txs = rows.map(p => {
      const pr = p.properties;
      const getField = (fieldName) => pr[fieldName];

      const titleField = getField(cfg.fields.title);
      const amountField = getField(cfg.fields.amount);
      const dateField = getField(cfg.fields.date);
      const typeField = cfg.fields.type ? getField(cfg.fields.type) : null;
      const currencyField = cfg.fields.currency ? getField(cfg.fields.currency) : null;
      const mainCatField = cfg.fields.mainCategory ? getField(cfg.fields.mainCategory) : null;
      const trmField = cfg.fields.trm ? getField(cfg.fields.trm) : null;
      const walletField = cfg.fields.wallet ? getField(cfg.fields.wallet) : null;
      const categoryField = cfg.fields.category ? getField(cfg.fields.category) : null;

      // Computed fields (formulas)
      const expAmtField = cfg.fields.expenseAmount ? getField(cfg.fields.expenseAmount) : null;
      const incAmtField = cfg.fields.incomeAmount  ? getField(cfg.fields.incomeAmount)  : null;
      const balCopField = cfg.fields.balanceCOP    ? getField(cfg.fields.balanceCOP)    : null;

      const getTitle = (f) => f?.title?.[0]?.plain_text || f?.rich_text?.[0]?.plain_text || '';
      const getSelect = (f) => f?.select?.name || f?.multi_select?.[0]?.name || '';
      const getNum = (f) => f?.number ?? null;
      const getDate = (f) => f?.date?.start || '';
      const getFormula = (f) => f?.formula?.number ?? f?.formula?.string ?? null;
      const getRelIds = (f) => f?.relation?.map(r => r.id) || [];

      return {
        id: p.id,
        url: p.url,
        title: getTitle(titleField),
        amount: getNum(amountField),
        date: getDate(dateField),
        type: getSelect(typeField),
        currency: getSelect(currencyField) || 'COP',
        mainCategory: getSelect(mainCatField),
        trm: getNum(trmField) || 1,
        walletIds: getRelIds(walletField),
        categoryIds: getRelIds(categoryField),
        expenseAmount: getFormula(expAmtField),
        incomeAmount: getFormula(incAmtField),
        balanceCOP: getFormula(balCopField),
      };
    });

    res.json({ ok: true, transactions: txs });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── Create transaction ─────────────────────────────────────────────────────
app.post('/api/transactions', async (req, res) => {
  if (!req.session.token) return res.status(401).json({ ok: false, error: 'Not authenticated' });
  const cfg = req.session.config;
  if (!cfg) return res.status(400).json({ ok: false, error: 'No config' });

  const { tx } = req.body; // tx: { title, amount, trm, date, type, currency, walletId, categoryId, walletFromId, walletToId }
  try {
    const properties = {};
    const f = cfg.fields;

    if (f.title && tx.title)    properties[f.title]    = { title: [{ text: { content: tx.title } }] };
    if (f.amount && tx.amount != null) properties[f.amount] = { number: parseFloat(tx.amount) };
    if (f.trm    && tx.trm    != null) properties[f.trm]    = { number: parseFloat(tx.trm) };
    if (f.date   && tx.date)   properties[f.date]      = { date: { start: tx.date } };
    if (f.type   && tx.type)   properties[f.type]      = { multi_select: [{ name: tx.type }] };
    if (f.currency && tx.currency) properties[f.currency] = { select: { name: tx.currency } };

    // Relations
    if (f.wallet   && tx.walletId)     properties[f.wallet]      = { relation: [{ id: tx.walletId }] };
    if (f.category && tx.categoryId)   properties[f.category]    = { relation: [{ id: tx.categoryId }] };
    if (f.walletFrom && tx.walletFromId) properties[f.walletFrom] = { relation: [{ id: tx.walletFromId }] };
    if (f.walletTo   && tx.walletToId)   properties[f.walletTo]   = { relation: [{ id: tx.walletToId }] };

    const page = await notion(req.session.token, 'POST', '/pages', {
      parent: { database_id: cfg.databaseId },
      properties,
    });
    res.json({ ok: true, id: page.id });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── Wallet balances (from Summary relation) ────────────────────────────────
app.get('/api/wallets', async (req, res) => {
  if (!req.session.token) return res.status(401).json({ ok: false, error: 'Not authenticated' });
  const cfg = req.session.config;
  if (!cfg?.walletDbId) return res.json({ ok: true, wallets: [] });

  try {
    const pages = await queryAll(req.session.token, cfg.walletDbId);
    const wallets = pages.map(p => {
      const titleProp = Object.values(p.properties).find(x => x.type === 'title');
      const name = titleProp?.title?.[0]?.plain_text || 'Sin nombre';

      // Try to get balance — look for number or formula fields
      let balance = null;
      for (const [pname, prop] of Object.entries(p.properties)) {
        if ((prop.type === 'number') && prop.number != null && pname.toLowerCase().includes('balance')) {
          balance = prop.number; break;
        }
        if (prop.type === 'formula' && prop.formula?.number != null && pname.toLowerCase().includes('balance')) {
          balance = prop.formula.number; break;
        }
      }

      // Get type/category of wallet (Available, Debt, Pocket, Savings)
      let walletType = 'available';
      for (const [pname, prop] of Object.entries(p.properties)) {
        const val = (prop.select?.name || prop.multi_select?.[0]?.name || '').toLowerCase();
        const pn = pname.toLowerCase();
        if (pn.includes('type') || pn.includes('category') || pn.includes('kind')) {
          if (val.includes('debt') || val.includes('deuda') || val.includes('credit'))   walletType = 'debt';
          else if (val.includes('pocket') || val.includes('bolsillo'))                   walletType = 'pocket';
          else if (val.includes('saving') || val.includes('ahorro'))                     walletType = 'saving';
          else if (val.includes('available') || val.includes('disponible'))              walletType = 'available';
          break;
        }
      }

      return { id: p.id, name, balance, type: walletType };
    });
    res.json({ ok: true, wallets });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`My Money running on :${PORT}`));
