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

const PT_V07 = [14];

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
  if (!data.result?.uid) throw new Error('Auth failed');
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
    async function sr(model, domain, fields, limit=3000) {
      return odooRpc(model, 'search_read', [domain], { fields, limit });
    }

    // ── OPEN COUNTS ──
    const [v07Open, expressDE, expressAT, prio, v07Done, tToday, tYest, tDby] = await Promise.all([
      cnt('stock.picking',[['picking_type_id','in',PT_V07],['state','=','assigned'],['batch_id','=',false],['note','not ilike','tittynope'],['note','not ilike','Juwelier'],['carrier_id.name','not ilike','Expressversand'],['carrier_id.name','not ilike','Express'],['carrier_id.name','not ilike','Prio']]),
      cnt('stock.picking',[['picking_type_id','in',PT_V07],['state','=','assigned'],['carrier_id.name','ilike','Expressversand']]),
      cnt('stock.picking',[['picking_type_id','in',PT_V07],['state','=','assigned'],['carrier_id.name','ilike','Express Post.at']]),
      cnt('stock.picking',[['picking_type_id','in',PT_V07],['state','=','assigned'],['carrier_id.name','ilike','Prio']]),
      cnt('stock.picking',[['picking_type_id','in',PT_V07],['state','=','done'],['date_done','>=',t0],['date_done','<',t1]]),
      cnt('stock.picking',[['picking_type_id','in',PT_V07],['state','=','done'],['date_done','>=',t0],['date_done','<',t1]]),
      cnt('stock.picking',[['picking_type_id','in',PT_V07],['state','=','done'],['date_done','>=',ty],['date_done','<',t0]]),
      cnt('stock.picking',[['picking_type_id','in',PT_V07],['state','=','done'],['date_done','>=',tdb],['date_done','<',ty]]),
    ]);

    const [mlT, mlY, mlD] = await Promise.all([
      rg('stock.move',[['picking_id.picking_type_id','in',PT_V07],['state','=','done'],['date','>=',t0],['date','<',t1]],['product_uom_qty']),
      rg('stock.move',[['picking_id.picking_type_id','in',PT_V07],['state','=','done'],['date','>=',ty],['date','<',t0]],['product_uom_qty']),
      rg('stock.move',[['picking_id.picking_type_id','in',PT_V07],['state','=','done'],['date','>=',tdb],['date','<',ty]],['product_uom_qty']),
    ]);

    // ── CARRIER TAGESABSCHLUSS ──
    // FedEx = Fedex + Fedex Prio
    // Post AT = Post.at DE + Post.at AT + Express Post.at AT
    // UPS = UPS - EU + UPS INTERNATIONAL
    // Expressversand = Expressversand
    const carrierGroups = [
      { key: 'fedex',       label: 'FedEx',         keywords: ['fedex'] },
      { key: 'post_de', label: 'Post DE', keywords: ['post.at de'] },
      { key: 'post_at', label: 'Post AT', keywords: ['post.at at', 'express post.at at'] },
      { key: 'ups',         label: 'UPS',            keywords: ['ups'] },
      { key: 'expressversand', label: 'Expressversand', keywords: ['expressversand'] },
    ];

    const [todayDone, yesterdayDone] = await Promise.all([
      sr('stock.picking',[['picking_type_id','in',PT_V07],['state','=','done'],['date_done','>=',t0],['date_done','<',t1]],['carrier_id']),
      sr('stock.picking',[['picking_type_id','in',PT_V07],['state','=','done'],['date_done','>=',ty],['date_done','<',t0]],['carrier_id']),
    ]);

    const match = (p, kws) => kws.some(k => (p.carrier_id?.[1]||'').toLowerCase().includes(k.toLowerCase()));

    const carriers = {};
    for (const cg of carrierGroups) {
      carriers[cg.key] = {
        label: cg.label,
        today:     todayDone.filter(p => match(p, cg.keywords)).length,
        yesterday: yesterdayDone.filter(p => match(p, cg.keywords)).length,
      };
    }

    // ── VERPACKER ──
    const packers = ['Raphael Engelsberger','John Husarik','Jonas Aichberger','Tanja Weghofer','Niklas Voss','Florian Rottensteiner','Emirhan Korkmaz','Gregor Scharf','Lisa Klauder','Patrycja Sowidzka','Tim Heßberger'];

    const todayPickings = await sr('stock.picking',
      [['picking_type_id','in',PT_V07],['state','=','done'],['date_done','>=',t0],['date_done','<',t1]],
      ['id','write_uid']
    );

    const pickingIds = todayPickings.map(p => p.id);
    let moveData = [];
    if (pickingIds.length > 0) {
      moveData = await sr('stock.move',
        [['picking_id','in',pickingIds],['state','=','done']],
        ['picking_id','product_uom_qty'], 10000
      );
    }

    const piecesByPicking = {};
    for (const m of moveData) {
      const pid = Array.isArray(m.picking_id) ? m.picking_id[0] : m.picking_id;
      piecesByPicking[pid] = (piecesByPicking[pid] || 0) + m.product_uom_qty;
    }

    const packerStats = {};
    for (const p of todayPickings) {
      const userName = p.write_uid?.[1] || '';
      const matched = packers.find(n => userName.toLowerCase().includes(n.toLowerCase()));
      if (!matched) continue;
      if (!packerStats[matched]) packerStats[matched] = { transfers: 0, pieces: 0 };
      packerStats[matched].transfers += 1;
      packerStats[matched].pieces += Math.round(piecesByPicking[p.id] || 0);
    }

    const packerList = packers.map(name => ({
      name,
      transfers: packerStats[name]?.transfers || 0,
      pieces:    packerStats[name]?.pieces    || 0,
    })).sort((a,b) => b.transfers - a.transfers);

    res.json({
      dispatch: {
        open: v07Open, done_today: v07Done,
        express_de: expressDE, express_at: expressAT, prio,
        transfers: { today: tToday, yesterday: tYest, day_before: tDby },
        pieces: {
          today:      Math.round(mlT?.[0]?.product_uom_qty || 0),
          yesterday:  Math.round(mlY?.[0]?.product_uom_qty || 0),
          day_before: Math.round(mlD?.[0]?.product_uom_qty || 0),
        }
      },
      carriers,
      packers: packerList,
      synced_at: new Date().toISOString()
    });

  } catch(err) {
    console.error('API error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Holzkern Dispatch API' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
