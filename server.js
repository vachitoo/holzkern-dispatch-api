const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const ODOO_URL = 'https://odoo.holzkern.com';
const DB       = 'holzkern-master-7173194';
const LOGIN    = process.env.ODOO_LOGIN;
const PASSWORD = process.env.ODOO_PASSWORD;

// Exact Picking Type IDs from Odoo
const PT_V07        = [14, 15];       // V07-Delivery + V07B-Delivery (Repair)
const PT_V03        = [10];           // V03-Inbound to Stock
const PT_V04        = [11];           // V04-Inbound to Quality
const PT_V05        = [12];           // V05-Quality to Stock
const PT_V06        = [13];           // V06-Stock to Dispatch
const PT_V09        = [17];           // V09-Returns to Dispatch

let sessionCookie = null;

async function getSession() {
  const res = await fetch(`${ODOO_URL}/web/session/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'call', id: 1,
      params: { db: DB, login: LOGIN, password: PASSWORD }
    })
  });
  const data = await res.json();
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) sessionCookie = setCookie.split(';')[0];
  if (!data.result?.uid) throw new Error('Auth failed: ' + JSON.stringify(data.result));
  return sessionCookie;
}

async function odooRpc(model, method, args, kwargs = {}) {
  if (!sessionCookie) await getSession();
  const res = await fetch(`${ODOO_URL}/web/dataset/call_kw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': sessionCookie },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'call', id: Date.now(),
      params: { model, method, args, kwargs }
    })
  });
  const data = await res.json();
  if (data.error) {
    if (data.error.code === 100) { sessionCookie = null; await getSession(); return odooRpc(model, method, args, kwargs); }
    throw new Error(data.error.data?.message || JSON.stringify(data.error));
  }
  return data.result;
}

function dayStart(offset = 0) {
  const d = new Date(); d.setDate(d.getDate() + offset); d.setHours(0,0,0,0);
  return d.toISOString().replace('T',' ').slice(0,19);
}

app.get('/api/dispatch', async (req, res) => {
  try {
    const t0=dayStart(0), t1=dayStart(1), ty=dayStart(-1), tdb=dayStart(-2);

    async function cnt(model, domain) {
      const r = await odooRpc(model, 'search_count', [domain]);
      return typeof r === 'number' ? r : 0;
    }
    async function rg(model, domain, fields) {
      return odooRpc(model, 'read_group', [domain, fields, []], { lazy: false });
    }

    // V07 open — only exact V07 picking types, not done/cancelled
    const v07Open = await cnt('stock.picking', [
      ['picking_type_id','in', PT_V07],
      ['state','=','assigned']
    ]);

    // V07 done today
    const v07Done = await cnt('stock.picking', [
      ['picking_type_id','in', PT_V07],
      ['state','=','done'],
      ['date_done','>=',t0],['date_done','<',t1]
    ]);

    // Express = priority '1' in V07
    const express = await cnt('stock.picking', [
      ['picking_type_id','in', PT_V07],
      ['state','not in',['done','cancel']],
      ['priority','=','1']
    ]);

    // Prio = priority '2' or '3' in V07
    const prio = await cnt('stock.picking', [
      ['picking_type_id','in', PT_V07],
      ['state','not in',['done','cancel']],
      ['priority','in',['2','3']]
    ]);

    // Transfers today/yesterday/day before (V07 done)
    const [tToday, tYest, tDby] = await Promise.all([
      cnt('stock.picking',[['picking_type_id','in',PT_V07],['state','=','done'],['date_done','>=',t0],['date_done','<',t1]]),
      cnt('stock.picking',[['picking_type_id','in',PT_V07],['state','=','done'],['date_done','>=',ty],['date_done','<',t0]]),
      cnt('stock.picking',[['picking_type_id','in',PT_V07],['state','=','done'],['date_done','>=',tdb],['date_done','<',ty]]),
    ]);

    // Pieces — sum of product_uom_qty for done moves in V07
    const [mlT, mlY, mlD] = await Promise.all([
      rg('stock.move',[['picking_id.picking_type_id','in',PT_V07],['state','=','done'],['date','>=',t0],['date','<',t1]],['product_uom_qty']),
      rg('stock.move',[['picking_id.picking_type_id','in',PT_V07],['state','=','done'],['date','>=',ty],['date','<',t0]],['product_uom_qty']),
      rg('stock.move',[['picking_id.picking_type_id','in',PT_V07],['state','=','done'],['date','>=',tdb],['date','<',ty]],['product_uom_qty']),
    ]);

    // Warehouse counts — open (not done/cancel)
    const [wV03, wV04, wV05, wV06, wV09] = await Promise.all([
      cnt('stock.picking',[['picking_type_id','in',PT_V03],['state','not in',['done','cancel']]]),
      cnt('stock.picking',[['picking_type_id','in',PT_V04],['state','not in',['done','cancel']]]),
      cnt('stock.picking',[['picking_type_id','in',PT_V05],['state','not in',['done','cancel']]]),
      cnt('stock.picking',[['picking_type_id','in',PT_V06],['state','not in',['done','cancel']]]),
      cnt('stock.picking',[['picking_type_id','in',PT_V09],['state','not in',['done','cancel']]]),
    ]);

    res.json({
      dispatch: {
        open: v07Open,
        done_today: v07Done,
        express,
        prio,
        transfers: { today: tToday, yesterday: tYest, day_before: tDby },
        pieces: {
          today:      Math.round(mlT?.[0]?.product_uom_qty || 0),
          yesterday:  Math.round(mlY?.[0]?.product_uom_qty || 0),
          day_before: Math.round(mlD?.[0]?.product_uom_qty || 0),
        }
      },
      warehouse: { v03: wV03, v04: wV04, v05: wV05, v06: wV06, v09: wV09 },
      synced_at: new Date().toISOString()
    });

  } catch(err) {
    console.error('API error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Debug route
app.get('/api/types', async (req, res) => {
  try {
    const types = await odooRpc('stock.picking.type', 'search_read',
      [[]], { fields: ['id','name','code','warehouse_id'], limit: 100 });
    res.json(types);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Holzkern Dispatch API' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
