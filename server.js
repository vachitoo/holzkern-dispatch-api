const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const ODOO_URL = 'https://odoo.holzkern.com';
const DB       = 'holzkern-master-7173194';
const LOGIN    = 'ivan@holzkern.com';
const API_KEY  = '14aafcfa72900c3bff8e0e6048c82035009ec56c';

// Session cookie cache
let sessionCookie = null;

async function getSession() {
  const res = await fetch(`${ODOO_URL}/web/session/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'call', id: 1,
      params: { db: DB, login: LOGIN, password: API_KEY }
    })
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) sessionCookie = setCookie.split(';')[0];
  const data = await res.json();
  if (!data.result?.uid) throw new Error('Auth failed');
  return sessionCookie;
}

async function odooRpc(model, method, args, kwargs = {}) {
  if (!sessionCookie) await getSession();
  const res = await fetch(`${ODOO_URL}/web/dataset/call_kw`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': sessionCookie
    },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'call', id: Date.now(),
      params: { model, method, args, kwargs }
    })
  });
  const data = await res.json();
  if (data.error) {
    // Session expired — re-auth once
    if (data.error.code === 100) {
      sessionCookie = null;
      await getSession();
      return odooRpc(model, method, args, kwargs);
    }
    throw new Error(data.error.data?.message || JSON.stringify(data.error));
  }
  return data.result;
}

function dayStart(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

// ── MAIN DATA ENDPOINT ──
app.get('/api/dispatch', async (req, res) => {
  try {
    const t0 = dayStart(0), t1 = dayStart(1), ty = dayStart(-1), tdb = dayStart(-2);

    async function cnt(model, domain) {
      const r = await odooRpc(model, 'search_count', [domain]);
      return typeof r === 'number' ? r : 0;
    }

    async function rg(model, domain, fields) {
      const r = await odooRpc(model, 'read_group', [domain, fields, []], { lazy: false });
      return r;
    }

    // All dispatch counts in parallel
    const [openAll, doneToday, express, prio, tToday, tYest, tDby] = await Promise.all([
      cnt('stock.picking', [['picking_type_code','=','outgoing'],['state','not in',['done','cancel']]]),
      cnt('stock.picking', [['picking_type_code','=','outgoing'],['state','=','done'],['date_done','>=',t0],['date_done','<',t1]]),
      cnt('stock.picking', [['picking_type_code','=','outgoing'],['state','not in',['done','cancel']],['priority','=','1']]),
      cnt('stock.picking', [['picking_type_code','=','outgoing'],['state','not in',['done','cancel']],['priority','in',['2','3']]]),
      cnt('stock.picking', [['picking_type_code','=','outgoing'],['state','=','done'],['date_done','>=',t0],['date_done','<',t1]]),
      cnt('stock.picking', [['picking_type_code','=','outgoing'],['state','=','done'],['date_done','>=',ty],['date_done','<',t0]]),
      cnt('stock.picking', [['picking_type_code','=','outgoing'],['state','=','done'],['date_done','>=',tdb],['date_done','<',ty]]),
    ]);

    // Pieces
    const [mlT, mlY, mlD] = await Promise.all([
      rg('stock.move.line', [['picking_id.picking_type_code','=','outgoing'],['state','=','done'],['date','>=',t0],['date','<',t1]], ['qty_done']),
      rg('stock.move.line', [['picking_id.picking_type_code','=','outgoing'],['state','=','done'],['date','>=',ty],['date','<',t0]], ['qty_done']),
      rg('stock.move.line', [['picking_id.picking_type_code','=','outgoing'],['state','=','done'],['date','>=',tdb],['date','<',ty]], ['qty_done']),
    ]);

    // Warehouse picking types
    const ptypes = await odooRpc('stock.picking.type', 'search_read',
      [[['code','=','outgoing']]], { fields: ['id','name','warehouse_id'], limit: 100 });

    const whKeys = ['v03','v04','v05','v06','v09'];
    const warehouse = {};
    for (const key of whKeys) {
      const ids = (ptypes || [])
        .filter(p => ((p.warehouse_id?.[1]||'')+(p.name||'')).toLowerCase().includes(key))
        .map(p => p.id);
      warehouse[key] = ids.length
        ? await cnt('stock.picking', [['picking_type_id','in',ids],['state','not in',['done','cancel']]])
        : null;
    }

    res.json({
      dispatch: {
        open: openAll,
        done_today: doneToday,
        express,
        prio,
        transfers: { today: tToday, yesterday: tYest, day_before: tDby },
        pieces: {
          today:     Math.round(mlT?.[0]?.qty_done || 0),
          yesterday: Math.round(mlY?.[0]?.qty_done || 0),
          day_before:Math.round(mlD?.[0]?.qty_done || 0),
        }
      },
      warehouse,
      synced_at: new Date().toISOString()
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', service: 'Holzkern Dispatch API' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
