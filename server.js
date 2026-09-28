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

const at = (daysFromToday, h, m) => {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

// Plant checkpoints, surveyed on site. Every trip uses the same six so the flow can be tested
// repeatedly. `radius` (m) = counts as reached; inside the plant stops are reached in this order.
const PLANT = {
  name: 'GCC Test Plant',
  stops: [
    { name: 'Entry gate', lat: 19.114051, lng: 72.893248, radius: 20 },
    { name: 'Security check', lat: 19.113715, lng: 72.892954, radius: 15 },
    { name: 'Waiting area', lat: 19.112686, lng: 72.893075, radius: 15 },
    { name: 'Loading gate', lat: 19.112392, lng: 72.893295, radius: 15 },
    { name: 'Silo loading', lat: 19.112819, lng: 72.892895, radius: 15 },
    { name: 'Gate out', lat: 19.113602, lng: 72.892435, radius: 20 },
  ],
};
const PICKUP_STOP = 4; // "Confirm pickup" unlocks at Silo loading
const CUSTOMER_RADIUS = 60;

// Customer sites about 4-5 km (straight line) from the plant's gate out
const S = {
  andheriWest: { name: 'Andheri West Site', lat: 19.1197, lng: 72.8464 },
  kurla: { name: 'Kurla West Site', lat: 19.0726, lng: 72.8845 },
  jogeshwari: { name: 'Jogeshwari East Site', lat: 19.1395, lng: 72.8555 },
  kanjurmarg: { name: 'Kanjurmarg East Site', lat: 19.129, lng: 72.933 },
  vileParle: { name: 'Vile Parle East Site', lat: 19.099, lng: 72.849 },
  goregaon: { name: 'Goregaon East Site', lat: 19.155, lng: 72.875 },
  ghatkopar: { name: 'Ghatkopar East Site', lat: 19.08, lng: 72.91 },
  vidyavihar: { name: 'Vidyavihar Site', lat: 19.079, lng: 72.897 },
  vikhroli: { name: 'Vikhroli West Site', lat: 19.108, lng: 72.929 },
  kalina: { name: 'Kalina Site', lat: 19.076, lng: 72.863 },
  bhandup: { name: 'Bhandup West Site', lat: 19.144, lng: 72.93 },
  vakola: { name: 'Vakola Site', lat: 19.085, lng: 72.859 },
};

function makeTrip([id, customer, material, vehicleNo, site, scheduledAt]) {
  const silo = PLANT.stops[PICKUP_STOP];
  return {
    id, customer, material, vehicleNo, scheduledAt,
    pickup: { name: PLANT.name, lat: silo.lat, lng: silo.lng },
    drop: { ...site },
    stops: [...PLANT.stops, { ...site, radius: CUSTOMER_RADIUS }],
    pickupStop: PICKUP_STOP,
    status: 'ASSIGNED',
    lastLocation: null,
    track: [],
  };
}

// In-memory store. Replace with your DB later.
function seed() {
  return [
    ['T-1001', 'Green Concrete', 'OPC 53 Grade, 50 TON', 'GCC-VTO 10', S.andheriWest, at(0, 10, 30)],
    ['T-1002', 'Skyline Builders', 'PPC, 40 TON', 'GCC-VTO 10', S.kurla, at(1, 9, 0)],
    ['T-1003', 'Harbor Infra', 'OPC 43 Grade, 45 TON', 'GCC-VTO 10', S.jogeshwari, at(3, 14, 15)],
    ['T-2001', 'Kanjur Commercial Projects', 'OPC 53 Grade, 40 TON', 'MH-02 BX 4102', S.kanjurmarg, at(0, 7, 30)],
    ['T-2002', 'Parle Heights Builders', 'PPC, 35 TON', 'MH-02 BX 4102', S.vileParle, at(0, 12, 0)],
    ['T-2003', 'Aarey Infra Works', 'OPC 53 Grade, 45 TON', 'MH-02 BX 4118', S.goregaon, at(0, 15, 30)],
    ['T-2004', 'Ghatkopar Metro Developers', 'GGBS Blend, 30 TON', 'MH-02 BX 4118', S.ghatkopar, at(1, 6, 45)],
    ['T-2005', 'Vidyavihar Residency LLP', 'OPC 43 Grade, 40 TON', 'MH-02 BX 4125', S.vidyavihar, at(1, 11, 30)],
    ['T-2006', 'Vikhroli Township Constructions', 'PPC, 45 TON', 'MH-02 BX 4125', S.vikhroli, at(1, 15, 0)],
    ['T-2007', 'Kalina Campus Projects', 'OPC 53 Grade, 35 TON', 'MH-02 BX 4131', S.kalina, at(2, 8, 0)],
    ['T-2008', 'Bhandup Greens Builders', 'GGBS Blend, 40 TON', 'MH-02 BX 4131', S.bhandup, at(2, 12, 15)],
    ['T-2009', 'Vakola Heights Pvt Ltd', 'OPC 43 Grade, 30 TON', 'MH-02 BX 4102', S.vakola, at(3, 7, 0)],
    ['T-2010', 'Andheri Metro Contractors', 'OPC 53 Grade, 40 TON', 'MH-02 BX 4118', S.andheriWest, at(4, 10, 30)],
    ['T-2011', 'Kurla Junction Infra', 'PPC, 45 TON', 'MH-02 BX 4125', S.kurla, at(5, 9, 0)],
    ['T-2012', 'Jogeshwari Skyline LLP', 'OPC 53 Grade, 50 TON', 'MH-02 BX 4131', S.jogeshwari, at(6, 14, 0)],
  ].map(makeTrip);
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
