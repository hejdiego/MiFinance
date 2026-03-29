const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Notion helper ──────────────────────────────────────────────────────────
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

// Paginate through all results of a database query
async function queryAll(token, dbId, filter = null) {
  let results = [], cursor = undefined;
  do {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (cursor) body.start_cursor = cursor;
    const data = await notion(token, 'POST', `/databases/${dbId}/query`, body);
    results = results.concat(data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return results;
}

// ── Validate & load schema ─────────────────────────────────────────────────
app.post('/api/validate', async (req, res) => {
  const { token, databaseId } = req.body;
  try {
    const db = await notion(token, 'GET', `/databases/${databaseId}`);

    // Find relation property IDs for Wallet and Category
    const relations = {};
    for (const [name, prop] of Object.entries(db.properties)) {
      if (prop.type === 'relation') {
        relations[name] = prop.relation.database_id.replace(/-/g, '');
      }
    }

    // Get select options for Type, Currency, Main Category
    const selects = {};
    for (const [name, prop] of Object.entries(db.properties)) {
      if (prop.type === 'select') {
        selects[name] = prop.select.options.map(o => ({ id: o.id, name: o.name, color: o.color }));
      }
      if (prop.type === 'multi_select') {
        selects[name] = prop.multi_select.options.map(o => ({ id: o.id, name: o.name, color: o.color }));
      }
    }

    res.json({ ok: true, dbTitle: db.title?.[0]?.plain_text || 'My Money', relations, selects });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── Load relation options (Wallet, Category pages) ─────────────────────────
app.post('/api/relation-options', async (req, res) => {
  const { token, databaseId } = req.body;
  try {
    const pages = await queryAll(token, databaseId);
    const options = pages.map(p => {
      // Get title from any title property
      const titleProp = Object.values(p.properties).find(prop => prop.type === 'title');
      const name = titleProp?.title?.[0]?.plain_text || 'Sin nombre';
      return { id: p.id, name };
    }).filter(o => o.name !== 'Sin nombre');

    res.json({ ok: true, options });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── Add transaction ────────────────────────────────────────────────────────
app.post('/api/expense', async (req, res) => {
  const { token, databaseId, transaction } = req.body;
  // transaction: { note, amount, trm, date, type, currency, mainCategory, walletId, categoryId, walletFromId, walletToId }

  try {
    const properties = {};

    // Title - Note
    if (transaction.note) {
      properties['Note'] = { title: [{ text: { content: transaction.note } }] };
    }

    // Number fields
    if (transaction.amount != null) properties['Amount'] = { number: parseFloat(transaction.amount) };
    if (transaction.trm != null)    properties['TRM']    = { number: parseFloat(transaction.trm) };

    // Date
    if (transaction.date) properties['Date'] = { date: { start: transaction.date } };

    // Multi-select: Type
    if (transaction.type) properties['Type'] = { multi_select: [{ name: transaction.type }] };

    // Select: Currency
    if (transaction.currency) properties['Currency'] = { select: { name: transaction.currency } };

    // Select: Main Category
    if (transaction.mainCategory) properties['Main Category'] = { select: { name: transaction.mainCategory } };

    // Relations
    if (transaction.walletId)    properties['Wallet']      = { relation: [{ id: transaction.walletId }] };
    if (transaction.categoryId)  properties['Category']    = { relation: [{ id: transaction.categoryId }] };
    if (transaction.walletFromId) properties['Wallet From'] = { relation: [{ id: transaction.walletFromId }] };
    if (transaction.walletToId)   properties['Wallet To']   = { relation: [{ id: transaction.walletToId }] };

    const page = await notion(token, 'POST', '/pages', {
      parent: { database_id: databaseId },
      properties,
    });

    res.json({ ok: true, pageId: page.id, url: page.url });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── Fetch recent transactions for dashboard ────────────────────────────────
app.post('/api/expenses', async (req, res) => {
  const { token, databaseId } = req.body;
  try {
    const data = await notion(token, 'POST', `/databases/${databaseId}/query`, {
      sorts: [{ property: 'Date', direction: 'descending' }],
      page_size: 100,
    });

    const expenses = data.results.map(page => {
      const p = page.properties;
      return {
        id: page.id,
        note: p['Note']?.title?.[0]?.plain_text || '',
        amount: p['Amount']?.number || 0,
        trm: p['TRM']?.number || 1,
        date: p['Date']?.date?.start || '',
        type: p['Type']?.multi_select?.[0]?.name || '',
        currency: p['Currency']?.select?.name || 'COP',
        mainCategory: p['Main Category']?.select?.name || '',
        expenseAmount: p['Expense Amount']?.formula?.number || null,
        incomeAmount: p['Income Amount']?.formula?.number || null,
        balanceCOP: p['Balance COP']?.formula?.number || null,
        month: p['Month']?.formula?.string || '',
        wallet: p['Wallet']?.relation?.[0]?.id || null,
      };
    });

    res.json({ ok: true, expenses });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
