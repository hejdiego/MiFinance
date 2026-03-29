const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Notion helper ──────────────────────────────────────────────────────────
async function notionRequest(token, method, endpoint, body = null) {
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
  if (!res.ok) throw new Error(data.message || 'Notion API error');
  return data;
}

// ── Validate credentials & fetch DB schema ─────────────────────────────────
app.post('/api/validate', async (req, res) => {
  const { token, databaseId } = req.body;
  try {
    const db = await notionRequest(token, 'GET', `/databases/${databaseId}`);
    const props = Object.entries(db.properties).map(([name, prop]) => ({
      name,
      type: prop.type,
      options: prop.select?.options?.map(o => ({ id: o.id, name: o.name, color: o.color }))
        || prop.multi_select?.options?.map(o => ({ id: o.id, name: o.name, color: o.color }))
        || [],
    }));
    res.json({ ok: true, dbTitle: db.title?.[0]?.plain_text || 'My Money', props });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── Add expense ────────────────────────────────────────────────────────────
app.post('/api/expense', async (req, res) => {
  const { token, databaseId, mapping, expense } = req.body;
  // mapping: { name, amount, category, date, account, tags }
  // expense: { name, amount, category, date, account, tags[] }

  try {
    const properties = {};

    if (mapping.name && expense.name) {
      properties[mapping.name] = { title: [{ text: { content: expense.name } }] };
    }
    if (mapping.amount && expense.amount != null) {
      properties[mapping.amount] = { number: parseFloat(expense.amount) };
    }
    if (mapping.category && expense.category) {
      properties[mapping.category] = { select: { name: expense.category } };
    }
    if (mapping.date && expense.date) {
      properties[mapping.date] = { date: { start: expense.date } };
    }
    if (mapping.account && expense.account) {
      properties[mapping.account] = { select: { name: expense.account } };
    }
    if (mapping.tags && expense.tags?.length) {
      properties[mapping.tags] = { multi_select: expense.tags.map(t => ({ name: t })) };
    }

    const page = await notionRequest(token, 'POST', '/pages', {
      parent: { database_id: databaseId },
      properties,
    });

    res.json({ ok: true, pageId: page.id, url: page.url });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── Fetch recent expenses for charts ──────────────────────────────────────
app.post('/api/expenses', async (req, res) => {
  const { token, databaseId, mapping } = req.body;
  try {
    const data = await notionRequest(token, 'POST', `/databases/${databaseId}/query`, {
      sorts: [{ property: mapping.date, direction: 'descending' }],
      page_size: 100,
    });

    const expenses = data.results.map(page => {
      const p = page.properties;
      return {
        id: page.id,
        name: p[mapping.name]?.title?.[0]?.plain_text || '',
        amount: p[mapping.amount]?.number || 0,
        category: p[mapping.category]?.select?.name || 'Sin categoría',
        date: p[mapping.date]?.date?.start || '',
        account: p[mapping.account]?.select?.name || '',
        tags: p[mapping.tags]?.multi_select?.map(t => t.name) || [],
      };
    });

    res.json({ ok: true, expenses });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
