require('dotenv').config();
const express = require('express');
const cors = require('cors');
const flexpolyline = require('@here/flexpolyline');
const polyline = require('@mapbox/polyline');

const app = express();
app.use(cors());
app.use(express.json());

const KEY = process.env.HERE_API_KEY;
if (!KEY) {
  console.error('Missing HERE_API_KEY in backend/.env');
  process.exit(1);
}
const TRUCK_GROSS_WEIGHT_KG = parseInt(process.env.TRUCK_GROSS_WEIGHT_KG, 10) || 40000;

function coord(name) {
  const n = parseFloat(process.env[name]);
  if (Number.isNaN(n)) {
    console.error(`Set ${name} in backend/.env`);
    process.exit(1);
  }
  return n;
}

const pickup = { name: process.env.PICKUP_NAME || 'Plant Gate', lat: coord('PICKUP_LAT'), lng: coord('PICKUP_LNG') };
const drop = { name: process.env.DROP_NAME || 'Customer Site', lat: coord('DROP_LAT'), lng: coord('DROP_LNG') };

const at = (daysFromToday, h, m) => {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

// Mumbai sample plants and customer sites (approximate area coordinates; Google snaps to the nearest road)
const P = {
  turbhe: { name: 'Turbhe MIDC Plant', lat: 19.076, lng: 73.018 },
  taloja: { name: 'Taloja MIDC Plant', lat: 19.066, lng: 73.115 },
  wadala: { name: 'Wadala Truck Terminal Plant', lat: 19.017, lng: 72.865 },
  bhiwandi: { name: 'Bhiwandi Depot', lat: 19.296, lng: 73.063 },
};
const S = {
  bkc: { name: 'BKC Tower Site', lat: 19.066, lng: 72.868 },
  lowerParel: { name: 'Lower Parel Site', lat: 18.996, lng: 72.83 },
  powai: { name: 'Powai Site', lat: 19.118, lng: 72.906 },
  thane: { name: 'Ghodbunder Road Thane Site', lat: 19.25, lng: 72.97 },
  worli: { name: 'Worli Site', lat: 19.01, lng: 72.817 },
  goregaon: { name: 'Goregaon East Site', lat: 19.164, lng: 72.849 },
  vashi: { name: 'Vashi Site', lat: 19.077, lng: 72.999 },
  kharghar: { name: 'Kharghar Site', lat: 19.047, lng: 73.069 },
  panvel: { name: 'Panvel Site', lat: 18.989, lng: 73.117 },
  mulund: { name: 'Mulund West Site', lat: 19.173, lng: 72.956 },
  andheri: { name: 'Andheri East Site', lat: 19.115, lng: 72.869 },
  chembur: { name: 'Chembur Site', lat: 19.062, lng: 72.9 },
};

// Trip stops in order: six inside the plant, then the customer. `radius` (m) = counts as reached.
// Entry gate and gate out sit on the public road (HERE routes to / from them); the stops in between
// are inside the plant and joined by straight lines in the app. Demo layouts only: real positions
// come from plant master data.
const PLANT_STOPS = [
  { name: 'Entry gate', radius: 35 },
  { name: 'Security check', radius: 25 },
  { name: 'Waiting area', radius: 25 },
  { name: 'Loading gate', radius: 25 },
  { name: 'Silo loading', radius: 25 },
  { name: 'Gate out', radius: 35 },
];
const PICKUP_STOP = 4; // "Confirm pickup" unlocks at Silo loading
const CUSTOMER_RADIUS = 60;

// [entry gate, gate out] on the road outside each demo plant
const PLANT_GATES = {
  'Wadala Truck Terminal Plant': [[19.01703, 72.86485], [19.018174, 72.865402]],
  'Turbhe MIDC Plant': [[19.07603, 73.01837], [19.077367, 73.018182]],
  'Taloja MIDC Plant': [[19.066, 73.11499], [19.065987, 73.11393]],
  'Bhiwandi Depot': [[19.29618, 73.06278], [19.296804, 73.063186]],
  local: [[19.0326, 73.04241], [19.03292, 73.041339]], // T-100x, valid while PICKUP_* in .env is unchanged
};

function towards(a, b, m) {
  const f = Math.min(1, m / meters(a, b));
  return { lat: +(a.lat + (b.lat - a.lat) * f).toFixed(6), lng: +(a.lng + (b.lng - a.lng) * f).toFixed(6) };
}

// Places the internal stops inside the plant, beside the road between the two gates (within ~200 m)
function plantLayout(entry, exit) {
  const k = 111320;
  const cos = Math.cos((entry.lat * Math.PI) / 180);
  const ex = (exit.lng - entry.lng) * k * cos;
  const ey = (exit.lat - entry.lat) * k;
  const len = Math.hypot(ex, ey) || 1;
  const u = [ex / len, ey / len];
  const v = [-u[1], u[0]];
  const at = (a, b) => ({
    lat: +(entry.lat + (a * u[1] + b * v[1]) / k).toFixed(6),
    lng: +(entry.lng + (a * u[0] + b * v[0]) / (k * cos)).toFixed(6),
  });
  return [entry, at(25, 45), at(40, 130), at(100, 170), at(140, 110), exit];
}

function withStops(t) {
  const gates = PLANT_GATES[t.pickup.name] || PLANT_GATES.local;
  let [entry, exit] = gates.map(([lat, lng]) => ({ lat, lng }));
  if (meters(entry, t.pickup) > 300) {
    entry = { lat: t.pickup.lat, lng: t.pickup.lng };
    exit = towards(t.pickup, t.drop, 150);
  }
  const stops = [
    ...plantLayout(entry, exit).map((p, i) => ({ ...PLANT_STOPS[i], ...p })),
    { name: t.drop.name, lat: t.drop.lat, lng: t.drop.lng, radius: CUSTOMER_RADIUS },
  ];
  const silo = stops[PICKUP_STOP];
  return { ...t, pickup: { name: t.pickup.name, lat: silo.lat, lng: silo.lng }, stops, pickupStop: PICKUP_STOP };
}

// In-memory store. Replace with your DB later.
function seed() {
  const local = [
    { id: 'T-1001', customer: 'Green Concrete', material: 'OPC 53 Grade, 50 TON', vehicleNo: 'GCC-VTO 10', scheduledAt: at(0, 10, 30) },
    { id: 'T-1002', customer: 'Skyline Builders', material: 'PPC, 40 TON', vehicleNo: 'GCC-VTO 10', scheduledAt: at(1, 9, 0) },
    { id: 'T-1003', customer: 'Harbor Infra', material: 'OPC 43 Grade, 45 TON', vehicleNo: 'GCC-VTO 10', scheduledAt: at(3, 14, 15) },
  ].map((t) => ({ ...t, pickup, drop }));

  const mumbai = [
    ['T-2001', 'BKC Commercial Projects', 'OPC 53 Grade, 40 TON', 'MH-43 BX 4102', P.wadala, S.bkc, at(0, 7, 30)],
    ['T-2002', 'Parel Heights Builders', 'PPC, 35 TON', 'MH-43 BX 4102', P.wadala, S.lowerParel, at(0, 11, 0)],
    ['T-2003', 'Vashi Infra Works', 'OPC 53 Grade, 45 TON', 'MH-43 BX 4118', P.turbhe, S.vashi, at(0, 15, 30)],
    ['T-2004', 'Lakeside Powai Developers', 'GGBS Blend, 30 TON', 'MH-43 BX 4118', P.turbhe, S.powai, at(1, 6, 45)],
    ['T-2005', 'Kharghar Residency LLP', 'OPC 43 Grade, 40 TON', 'MH-43 BX 4125', P.taloja, S.kharghar, at(1, 9, 30)],
    ['T-2006', 'Panvel Township Constructions', 'PPC, 45 TON', 'MH-43 BX 4125', P.taloja, S.panvel, at(1, 13, 0)],
    ['T-2007', 'Ghodbunder Towers Pvt Ltd', 'OPC 53 Grade, 35 TON', 'MH-43 BX 4131', P.bhiwandi, S.thane, at(2, 8, 0)],
    ['T-2008', 'Mulund Greens Builders', 'GGBS Blend, 40 TON', 'MH-43 BX 4131', P.bhiwandi, S.mulund, at(2, 12, 15)],
    ['T-2009', 'Worli Sea Face Projects', 'OPC 43 Grade, 30 TON', 'MH-43 BX 4102', P.wadala, S.worli, at(3, 7, 0)],
    ['T-2010', 'Goregaon Film City Infra', 'OPC 53 Grade, 40 TON', 'MH-43 BX 4118', P.turbhe, S.goregaon, at(4, 10, 30)],
    ['T-2011', 'Andheri Metro Contractors', 'PPC, 45 TON', 'MH-43 BX 4125', P.wadala, S.andheri, at(5, 9, 0)],
    ['T-2012', 'Chembur Skyline LLP', 'OPC 53 Grade, 50 TON', 'MH-43 BX 4131', P.turbhe, S.chembur, at(6, 14, 0)],
  ].map(([id, customer, material, vehicleNo, pk, dr, scheduledAt]) => ({ id, customer, material, vehicleNo, pickup: pk, drop: dr, scheduledAt }));

  return [...local, ...mumbai].map((t) => ({ ...withStops(t), status: 'ASSIGNED', lastLocation: null, track: [] }));
}
let trips = seed();

const NEXT = { ASSIGNED: 'ACCEPTED', ACCEPTED: 'PICKED_UP', PICKED_UP: 'DELIVERED' };
const publicTrip = ({ track, ...t }) => t;
const find = (id) => trips.find((t) => t.id === id);

app.get('/trips', (req, res) => {
  res.json(trips.map(publicTrip).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)));
});

app.get('/trips/:id', (req, res) => {
  const t = find(req.params.id);
  if (!t) return res.status(404).send('Trip not found');
  res.json(publicTrip(t));
});

app.post('/trips/:id/status', (req, res) => {
  const t = find(req.params.id);
  if (!t) return res.status(404).send('Trip not found');
  const { status } = req.body;
  if (NEXT[t.status] !== status) return res.status(409).send(`Cannot move from ${t.status} to ${status}`);
  t.status = status;
  t[`${status.toLowerCase()}At`] = new Date().toISOString();
  console.log(`🚚 ${t.id} -> ${status}`);
  res.json(publicTrip(t));
});

app.post('/trips/:id/location', (req, res) => {
  const t = find(req.params.id);
  if (!t) return res.status(404).send('Trip not found');
  const { lat, lng, speed = 0, heading = -1, ts = Date.now() } = req.body;
  t.lastLocation = { lat, lng, speed, heading, ts };
  t.track.push(t.lastLocation);
  if (t.track.length > 5000) t.track.shift();
  console.log(`📍 ${t.id} ${lat.toFixed(5)},${lng.toFixed(5)}  ${Math.round(speed * 3.6)} km/h`);
  res.json({ ok: true });
});

app.get('/trips/:id/track', (req, res) => {
  const t = find(req.params.id);
  if (!t) return res.status(404).send('Trip not found');
  res.json(t.track);
});

// Reset every trip to ASSIGNED so you can test again
app.post('/dev/reset', (req, res) => {
  trips = seed();
  console.log('↺ trips reset');
  res.json({ ok: true });
});

// Proxy to HERE Routing API v8 (truck mode, live traffic) so the key stays on the server
let routeCalls = 0;
let cacheHits = 0;

// Route cache: same stops + start within 150 m + younger than 10 min -> reuse, no HERE call.
// Reroutes always skip the cache (the driver has left the old route).
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_RADIUS_M = 150;
const routeCache = new Map(); // stops key -> [{ origin, at, route }]
const stopsKey = (via, d) => [...via, d].map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join('|');
function meters(a, b) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function fromCache(origin, key) {
  const fresh = (routeCache.get(key) || []).filter((e) => Date.now() - e.at < CACHE_TTL_MS);
  routeCache.set(key, fresh);
  return fresh.find((e) => meters(e.origin, origin) <= CACHE_RADIUS_M)?.route;
}
function toCache(origin, key, route) {
  routeCache.get(key).push({ origin, at: Date.now(), route });
}

// HERE action -> maneuver names the app already has icons for
function maneuverOf(a) {
  const side = a.direction === 'left' ? 'LEFT' : 'RIGHT';
  if (a.action === 'arrive') return 'ARRIVE';
  if (a.action === 'uTurn') return `UTURN_${side}`;
  if (a.action.startsWith('roundabout')) return `ROUNDABOUT_${side}`;
  if (a.action === 'keep') return `FORK_${side}`;
  if (a.action === 'exit' || a.action === 'ramp' || a.action === 'enterHighway') return `RAMP_${side}`;
  if (a.action === 'turn' && a.direction !== 'middle') {
    if (a.severity === 'light') return `TURN_SLIGHT_${side}`;
    if (a.severity === 'heavy') return `TURN_SHARP_${side}`;
    return `TURN_${side}`;
  }
  return '';
}

app.get('/stats', (req, res) => {
  res.json({ provider: 'HERE', routeCalls, cacheHits });
});

// Body: { origin, destination, via?: [stops in order], reroute? }; stops may carry a `name`
app.post('/route', async (req, res) => {
  const { origin, destination, via = [], reroute = false } = req.body;
  if (!origin || !destination) return res.status(400).send('origin and destination required');

  const key = stopsKey(via, destination);
  const cached = fromCache(origin, key);
  if (!reroute && cached) {
    cacheHits++;
    console.log(`♻️  Route from cache (HERE calls: ${routeCalls}, cache hits: ${cacheHits})`);
    return res.json(cached);
  }

  const params = new URLSearchParams({
    transportMode: 'truck',
    origin: `${origin.lat},${origin.lng}`,
    destination: `${destination.lat},${destination.lng}`,
    return: 'polyline,summary,actions,instructions',
    lang: 'en-US',
    'vehicle[grossWeight]': String(TRUCK_GROSS_WEIGHT_KG),
    apiKey: KEY,
  });
  via.forEach((v) => params.append('via', `${v.lat},${v.lng}`));

  try {
    const r = await fetch(`https://router.hereapi.com/v8/routes?${params}`);
    const data = await r.json();
    routeCalls++;
    console.log(`HERE route call #${routeCalls} (${r.status}, ${via.length} stops on the way)`);

    if (!r.ok) return res.status(502).send(data.title || data.error_description || data.cause || 'HERE Routing API error');
    const sections = data.routes?.[0]?.sections;
    if (!sections?.length) return res.status(404).send('No drivable truck route found between these points');

    // One section per stop: join their lines and turn-by-turn actions into one route
    const stopNames = [...via, destination].map((p) => p.name);
    const coords = [];
    const steps = [];
    let distanceMeters = 0;
    let durationSec = 0;
    sections.forEach((s, si) => {
      const pts = flexpolyline.decode(s.polyline).polyline.map(([lat, lng]) => ({ lat, lng }));
      const actions = s.actions || [];
      actions.forEach((a, k) => {
        const endIdx = k + 1 < actions.length ? actions[k + 1].offset : pts.length - 1;
        steps.push({
          distanceMeters: a.length || 0,
          start: pts[a.offset],
          end: pts[endIdx],
          instruction: a.action === 'arrive' && stopNames[si] ? `Arrive at ${stopNames[si]}` : a.instruction || '',
          maneuver: maneuverOf(a),
        });
      });
      coords.push(...pts);
      distanceMeters += s.summary?.length || 0;
      durationSec += s.summary?.duration || 0;
    });

    const result = {
      distanceMeters,
      durationSec,
      polyline: polyline.encode(coords.map((p) => [p.lat, p.lng])),
      steps,
    };
    toCache(origin, key, result);
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).send('Could not reach HERE Routing API');
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () => console.log(`Backend running on http://0.0.0.0:${PORT}`));
