require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const KEY = process.env.GOOGLE_MAPS_API_KEY;
if (!KEY) {
  console.error('Missing GOOGLE_MAPS_API_KEY in backend/.env');
  process.exit(1);
}

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

  return [...local, ...mumbai].map((t) => ({ ...t, status: 'ASSIGNED', lastLocation: null, track: [] }));
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

// Proxy to Google Routes API so the key stays on the server
let routeCalls = 0;
let cacheHits = 0;
const ll = (p) => ({ latLng: { latitude: p.lat, longitude: p.lng } });
const fromLL = (l) => ({ lat: l.latLng.latitude, lng: l.latLng.longitude });

// Route cache: same destination + start within 150 m + younger than 10 min -> reuse, no Google call.
// Reroutes always skip the cache (the driver has left the old route).
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_RADIUS_M = 150;
const routeCache = new Map(); // destination key -> [{ origin, at, route }]
const destKey = (d) => `${d.lat.toFixed(5)},${d.lng.toFixed(5)}`;
function meters(a, b) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function fromCache(origin, destination) {
  const fresh = (routeCache.get(destKey(destination)) || []).filter((e) => Date.now() - e.at < CACHE_TTL_MS);
  routeCache.set(destKey(destination), fresh);
  return fresh.find((e) => meters(e.origin, origin) <= CACHE_RADIUS_M)?.route;
}
function toCache(origin, destination, route) {
  routeCache.get(destKey(destination)).push({ origin, at: Date.now(), route });
}

app.get('/stats', (req, res) => {
  res.json({ googleCalls: routeCalls, cacheHits });
});

app.post('/route', async (req, res) => {
  const { origin, destination, reroute = false } = req.body;
  if (!origin || !destination) return res.status(400).send('origin and destination required');

  const cached = fromCache(origin, destination);
  if (!reroute && cached) {
    cacheHits++;
    console.log(`♻️  Route from cache (Google calls: ${routeCalls}, cache hits: ${cacheHits})`);
    return res.json(cached);
  }

  try {
    const r = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': KEY,
        'X-Goog-FieldMask': [
          'routes.duration',
          'routes.distanceMeters',
          'routes.polyline.encodedPolyline',
          'routes.legs.steps.distanceMeters',
          'routes.legs.steps.startLocation',
          'routes.legs.steps.endLocation',
          'routes.legs.steps.navigationInstruction',
        ].join(','),
      },
      body: JSON.stringify({
        origin: { location: ll(origin) },
        destination: { location: ll(destination) },
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_AWARE',
        languageCode: 'en',
        units: 'METRIC',
      }),
    });
    const data = await r.json();
    routeCalls++;
    console.log(`🗺  Google Routes call #${routeCalls} (${r.status})`);

    if (!r.ok) return res.status(502).send(data.error?.message || 'Routes API error');
    const route = data.routes?.[0];
    if (!route) return res.status(404).send('No drivable route found between these points');

    const result = {
      distanceMeters: route.distanceMeters || 0,
      durationSec: parseInt(route.duration, 10) || 0,
      polyline: route.polyline.encodedPolyline,
      steps: (route.legs?.[0]?.steps || []).map((s) => ({
        distanceMeters: s.distanceMeters || 0,
        start: fromLL(s.startLocation),
        end: fromLL(s.endLocation),
        instruction: s.navigationInstruction?.instructions || '',
        maneuver: s.navigationInstruction?.maneuver || '',
      })),
    };
    toCache(origin, destination, result);
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).send('Could not reach Google Routes API');
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () => console.log(`Backend running on http://0.0.0.0:${PORT}`));
