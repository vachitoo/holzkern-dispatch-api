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
    async function sr(model, domain, fields, limit=500) {
      return odooRpc(model, 'search_read', [domain], { fields, limit });
    }

    // ── DISPATCH COUNTS ──
    const v07Open = await cnt('stock.picking', [
      ['picking_type_id','in', PT_V07],
      ['state','=','assigned'],
      ['batch_id','=',false],
      ['note','not ilike','tittynope'],
      ['note','not ilike','Juwelier'],
      ['carrier_id.name','not ilike','Expressversand'],
      ['carrier_id.name','not ilike','Express'],
      ['carrier_id.name','not ilike','Priority'],
    ]);

    const expressDE = await cnt('stock.picking', [
      ['picking_type_id','in', PT_V07],
      ['state','=','assigned'],
      ['carrier_id.name','ilike','Expressversand'],
      ['note','not ilike','tittynope'],
      ['note','not ilike','Juwelier'],
    ]);

    const expressAT = await cnt('stock.picking', [
      ['picking_type_id','in', PT_V07],
      ['state','=','assigned'],
      ['carrier_id.name','ilike','Express'],
      ['carrier_id.name','not ilike','Expressversand'],
      ['note','not ilike','tittynope'],
      ['note','not ilike','Juwelier'],
    ]);

    const prio = await cnt('stock.picking', [
      ['picking_type_id','in', PT_V07],
      ['state','=','assigned'],
      ['carrier_id.name','ilike','Priority'],
      ['note','not ilike','tittynope'],
      ['note','not ilike','Juwelier'],
    ]);

    const v07Done = await cnt('stock.picking', [
      ['picking_type_id','in', PT_V07],
      ['state','=','done'],
      ['date_done','>=',t0],['date_done','<',t1]
    ]);

    const [tToday, tYest, tDby] = await Promise.all([
      cnt('stock.picking',[['picking_type_id','in',PT_V07],['state','=','done'],['date_done','>=',t0],['date_done','<',t1]]),
      cnt('stock.picking',[['picking_type_id','in',PT_V07],['state','=','done'],['date_done','>=',ty],['date_done','<',t0]]),
      cnt('stock.picking',[['picking_type_id','in',PT_V07],['state','=','done'],['date_done','>=',tdb],['date_done','<',ty]]),
    ]);

    const [mlT, mlY, mlD] = await Promise.all([
      rg('stock.move',[['picking_id.picking_type_id','in',PT_V07],['state','=','done'],['date','>=',t0],['date','<',t1]],['product_uom_qty']),
      rg('stock.move',[['picking_id.picking_type_id','in',PT_V07],['state','=','done'],['date','>=',ty],['date','<',t0]],['product_uom_qty']),
      rg('stock.move',[['picking_id.picking_type_id','in',PT_V07],['state','=','done'],['date','>=',tdb],['date','<',ty]],['product_uom_qty']),
    ]);

    // ── CARRIER BREAKDOWN ──
    const carrierGroups = [
      { key: 'fedex',   label: 'FedEx',   keywords: ['fedex','expressversand'] },
      { key: 'post_de', label: 'Post DE',  keywords: ['post de'] },
      { key: 'post_at', label: 'Post AT',  keywords: ['post at'] },
      { key: 'ups',     label: 'UPS',      keywords: ['ups'] },
    ];

    const carriers = {};
    for (const cg of carrierGroups) {
      const domain = kws => kws.map(k => ['carrier_id.name','ilike',k]);
      const orDomain = kws => kws.length === 1
        ? domain(kws)[0]
        : ['|', ...domain(kws)];

      const buildDomain = (extra=[]) => [
        ['picking_type_id','in',PT_V07],
        ['state','=','done'],
        ...extra,
        ...(cg.keywords.length === 1
          ? [['carrier_id.name','ilike',cg.keywords[0]]]
          : [['|', ...cg.keywords.map(k => ['carrier_id.name','ilike',k])].flat()])
      ];

      // simpler approach — search_read then filter
      const todayDone = await sr('stock.picking',
        [['picking_type_id','in',PT_V07],['state','=','done'],['date_done','>=',t0],['date_done','<',t1]],
        ['carrier_id','name'], 1000
      );

      const yesterdayDone = await sr('stock.picking',
        [['picking_type_id','in',PT_V07],['state','=','done'],['date_done','>=',ty],['date_done','<',t0]],
        ['carrier_id','name'], 1000
      );

      const matchCarrier = (p) => cg.keywords.some(k =>
        (p.carrier_id?.[1] || '').toLowerCase().includes(k.toLowerCase())
      );

      carriers[cg.key] = {
        label: cg.label,
        today: todayDone.filter(matchCarrier).length,
        yesterday: yesterdayDone.filter(matchCarrier).length,
      };
    }

    // ── VERPACKER PERFORMANCE ──
    const packers = ['Raphael','John','Jonas','Tanja','Niklas','Florian','Tim','Patrycja'];

    const todayPickings = await sr('stock.picking',
      [['picking_type_id','in',PT_V07],['state','=','done'],['date_done','>=',t0],['date_done','<',t1]],
      ['id','write_uid','date_done'], 2000
    );

    const pickingIds = todayPickings.map(p => p.id);

    // Get pieces per picking
    let moveData = [];
    if (pickingIds.length > 0) {
      moveData = await sr('stock.move',
        [['picking_id','in',pickingIds],['state','=','done']],
        ['picking_id','product_uom_qty'], 5000
      );
    }

    const piecesByPicking = {};
    for (const m of moveData) {
      const pid = m.picking_id[0];
      piecesByPicking[pid] = (piecesByPicking[pid] || 0) + m.product_uom_qty;
    }

    // Group by user name
    const packerStats = {};
    for (const p of todayPickings) {
      const userName = p.write_uid?.[1] || 'Unknown';
      const matchedPacker = packers.find(n => userName.toLowerCase().includes(n.toLowerCase()));
      const key = matchedPacker || 'other';
      if (!packerStats[key]) packerStats[key] = { transfers: 0, pieces: 0 };
      packerStats[key].transfers += 1;
      packerStats[key].pieces += Math.round(piecesByPicking[p.id] || 0);
    }

    const packerList = packers.map(name => ({
      name,
      transfers: packerStats[name]?.transfers || 0,
      pieces: packerStats[name]?.pieces || 0,
    })).sort((a,b) => b.transfers - a.transfers);

    res.json({
      dispatch: {
        open: v07Open,
        done_today: v07Done,
        express_de: expressDE,
        express_at: expressAT,
        prio,
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
