const HELSINKI_CENTER = [60.1699, 24.9384];
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const FALLBACK_DATA_URL = './data/fallback-terraces.json';

const DIRECTION_TO_AZIMUTH = {
  N: 0,
  NE: 45,
  E: 90,
  SE: 135,
  S: 180,
  SW: 225,
  W: 270,
  NW: 315,
};

const TYPE_BONUS = {
  rooftop: 0.12,
  waterfront: 0.1,
  courtyard: 0.03,
  street: 0.02,
  mixed: 0.05,
};

const state = {
  map: null,
  userMarker: null,
  terraceMarkers: [],
  rawTerraces: [],
  terraces: [],
  userLocation: null,
  sourceLabel: 'Loading…',
};

const els = {
  locateBtn: document.getElementById('locateBtn'),
  refreshBtn: document.getElementById('refreshBtn'),
  statusText: document.getElementById('statusText'),
  resultsList: document.getElementById('resultsList'),
  resultCount: document.getElementById('resultCount'),
  topNow: document.getElementById('pickNow'),
  topEvening: document.getElementById('pickEvening'),
  top1km: document.getElementById('pick1km'),
  searchInput: document.getElementById('searchInput'),
  dateInput: document.getElementById('dateInput'),
  timeInput: document.getElementById('timeInput'),
  sortSelect: document.getElementById('sortSelect'),
  sunnyNowOnly: document.getElementById('sunnyNowOnly'),
  eveningOnly: document.getElementById('eveningOnly'),
  dataSourceNote: document.getElementById('dataSourceNote'),
};

function initMap() {
  state.map = L.map('map', { scrollWheelZoom: true }).setView(HELSINKI_CENTER, 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(state.map);
}

function setDefaultInputs() {
  const now = new Date();
  const localDate = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  els.dateInput.value = localDate.toISOString().slice(0, 10);
  els.timeInput.value = `${String(now.getHours()).padStart(2, '0')}:${String(Math.round(now.getMinutes() / 15) * 15 % 60).padStart(2, '0')}`;
}

function getSelectedDateTime() {
  const date = els.dateInput.value;
  const time = els.timeInput.value || '16:00';
  return new Date(`${date}T${time}:00`);
}

function directionToAzimuth(direction) {
  if (!direction) return null;
  return DIRECTION_TO_AZIMUTH[String(direction).toUpperCase()] ?? null;
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function normalizeAngleDiff(a, b) {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

function scoreForAzimuth(terrace, azimuth) {
  const primary = directionToAzimuth(terrace.directionPrimary);
  const secondary = directionToAzimuth(terrace.directionSecondary);
  const primaryScore = primary == null ? 0.35 : 1 - normalizeAngleDiff(primary, azimuth) / 180;
  const secondaryScore = secondary == null ? 0 : 1 - normalizeAngleDiff(secondary, azimuth) / 180;
  const base = Math.max(primaryScore, secondaryScore * 0.92);
  const confidencePenalty = terrace.orientationConfidence === 'high' ? 1 : terrace.orientationConfidence === 'medium' ? 0.92 : 0.82;
  return clamp(base * confidencePenalty);
}

function getSunData(lat, lon, date) {
  const sunPos = SunCalc.getPosition(date, lat, lon);
  const altitude = sunPos.altitude;
  const azimuthDeg = (sunPos.azimuth * 180) / Math.PI + 180;
  return { altitude, azimuthDeg };
}

function distanceMeters(aLat, aLon, bLat, bLon) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function normalizeTerrace(item) {
  return {
    id: item.id || `${item.name}-${item.lat}-${item.lon}`.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
    name: item.name || 'Unnamed terrace',
    address: item.address || 'Address unknown',
    district: item.district || 'Helsinki',
    lat: Number(item.lat),
    lon: Number(item.lon),
    category: item.category || 'restaurant',
    terraceType: item.terraceType || 'mixed',
    description: item.description || '',
    source: item.source || 'unknown',
    terraceConfidence: Number(item.terraceConfidence ?? 0.7),
    directionPrimary: item.directionPrimary || 'SW',
    directionSecondary: item.directionSecondary || null,
    exposureType: item.exposureType || item.terraceType || 'mixed',
    orientationConfidence: item.orientationConfidence || 'low',
    website: item.website || null,
  };
}

async function loadFallbackData() {
  const response = await fetch(FALLBACK_DATA_URL);
  if (!response.ok) throw new Error('Fallback data unavailable');
  const data = await response.json();
  return data.map(normalizeTerrace);
}

async function loadLiveOverpassData() {
  const query = `
    [out:json][timeout:18];
    (
      node["amenity"~"cafe|restaurant|bar"](60.13,24.86,60.22,25.05);
      way["amenity"~"cafe|restaurant|bar"](60.13,24.86,60.22,25.05);
    );
    out center tags 120;
  `;

  const response = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: query,
  });
  if (!response.ok) throw new Error(`Overpass failed: ${response.status}`);
  const json = await response.json();
  const mapped = (json.elements || [])
    .map((el) => {
      const tags = el.tags || {};
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      const name = tags.name;
      if (!lat || !lon || !name) return null;
      const category = tags.amenity || 'restaurant';
      const text = `${tags.name || ''} ${tags.description || ''} ${tags['addr:street'] || ''}`.toLowerCase();
      const terraceType = inferTerraceType(text);
      return normalizeTerrace({
        id: `osm-${el.type}-${el.id}`,
        name,
        address: buildAddress(tags),
        district: tags['addr:suburb'] || tags['addr:city'] || 'Helsinki',
        lat,
        lon,
        category,
        terraceType,
        description: tags.description || tags.outdoor_seating === 'yes' ? 'Outdoor seating / terrace likely available.' : 'Venue discovered from OpenStreetMap.',
        source: 'openstreetmap',
        terraceConfidence: tags.outdoor_seating === 'yes' ? 0.82 : 0.58,
        directionPrimary: inferDirectionFromText(text),
        directionSecondary: null,
        exposureType: terraceType,
        orientationConfidence: 'low',
        website: tags.website || tags.contact_website || null,
      });
    })
    .filter(Boolean)
    .slice(0, 120);

  return mapped;
}

function inferTerraceType(text) {
  if (/(rooftop|sky|torni|ateljee|top floor)/.test(text)) return 'rooftop';
  if (/(ranta|beach|sea|harbor|satama|kanava|waterfront|meri)/.test(text)) return 'waterfront';
  if (/(courtyard|piha|yard|sisäpiha)/.test(text)) return 'courtyard';
  if (/(street|katu|bulevardi|terassi)/.test(text)) return 'street';
  return 'mixed';
}

function inferDirectionFromText(text) {
  if (/(west|länsi|ilta-aurinko|sunset)/.test(text)) return 'W';
  if (/(south|etelä)/.test(text)) return 'S';
  if (/(east|itä|morning)/.test(text)) return 'E';
  return 'SW';
}

function buildAddress(tags) {
  const street = tags['addr:street'];
  const number = tags['addr:housenumber'];
  if (street && number) return `${street} ${number}, Helsinki`;
  if (street) return `${street}, Helsinki`;
  return 'Helsinki';
}

async function loadTerraces() {
  updateStatus('Loading terrace data…');
  try {
    const [live, fallback] = await Promise.allSettled([loadLiveOverpassData(), loadFallbackData()]);
    const fallbackData = fallback.status === 'fulfilled' ? fallback.value : [];
    const liveData = live.status === 'fulfilled' ? live.value : [];

    const combined = dedupeByNameAndCoords([...fallbackData, ...liveData]);
    state.rawTerraces = combined;
    state.sourceLabel = liveData.length ? `Live OSM + fallback (${combined.length} places)` : `Fallback dataset (${combined.length} places)`;
    els.dataSourceNote.textContent = liveData.length
      ? 'Data source: OpenStreetMap live query combined with curated fallback terraces.'
      : 'Data source: curated fallback terrace dataset. Live OSM query was unavailable.';
    applyFiltersAndRender();
    updateStatus(state.sourceLabel);
  } catch (error) {
    console.error(error);
    updateStatus('Failed to load data');
    els.dataSourceNote.textContent = 'Could not load terrace data.';
  }
}

function dedupeByNameAndCoords(items) {
  const map = new Map();
  for (const item of items) {
    const key = `${item.name.toLowerCase()}-${item.lat.toFixed(3)}-${item.lon.toFixed(3)}`;
    if (!map.has(key) || (item.source === 'fallback-curated' && map.get(key).source !== 'fallback-curated')) {
      map.set(key, item);
    }
  }
  return Array.from(map.values());
}

function updateStatus(text) {
  els.statusText.textContent = text;
}

function getActiveCheckboxValues(selector) {
  return Array.from(document.querySelectorAll(selector))
    .filter((el) => el.checked)
    .map((el) => el.value);
}

function getDistanceFilter() {
  const active = document.querySelector('input[name="distance"]:checked');
  return active?.value || 'all';
}

function enrichTerraceScores(terrace) {
  const selectedDate = getSelectedDateTime();
  const { altitude, azimuthDeg } = getSunData(terrace.lat, terrace.lon, selectedDate);
  const afternoonAz = getSunData(terrace.lat, terrace.lon, new Date(`${els.dateInput.value}T15:00:00`)).azimuthDeg;
  const eveningAz = getSunData(terrace.lat, terrace.lon, new Date(`${els.dateInput.value}T18:00:00`)).azimuthDeg;
  const nowSunScore = altitude > 0 ? scoreForAzimuth(terrace, azimuthDeg) : 0.05;
  const afternoonScore = scoreForAzimuth(terrace, afternoonAz);
  const eveningScore = scoreForAzimuth(terrace, eveningAz);
  const distance = state.userLocation
    ? distanceMeters(state.userLocation.lat, state.userLocation.lon, terrace.lat, terrace.lon)
    : null;
  const distanceScore = distance == null ? 0.4 : clamp(1 - distance / 5000);
  const typeBonus = TYPE_BONUS[terrace.terraceType] || 0;
  const confidence = clamp(terrace.terraceConfidence || 0.7);
  const combinedScore = clamp(nowSunScore * 0.38 + distanceScore * 0.28 + eveningScore * 0.12 + afternoonScore * 0.08 + confidence * 0.1 + typeBonus * 0.04);
  const sunnyNow = nowSunScore >= 0.62 && altitude > 0;
  const eveningSun = eveningScore >= 0.7;
  return {
    ...terrace,
    nowSunScore,
    afternoonScore,
    eveningScore,
    distance,
    distanceScore,
    confidence,
    combinedScore,
    sunnyNow,
    eveningSun,
  };
}

function sortTerraces(items) {
  const mode = els.sortSelect.value;
  const sorters = {
    combined: (a, b) => b.combinedScore - a.combinedScore,
    nearest: (a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity),
    sunnyNow: (a, b) => b.nowSunScore - a.nowSunScore,
    afternoon: (a, b) => b.afternoonScore - a.afternoonScore,
    evening: (a, b) => b.eveningScore - a.eveningScore,
    overall: (a, b) => (b.combinedScore + b.confidence * 0.2) - (a.combinedScore + a.confidence * 0.2),
  };
  return items.sort(sorters[mode] || sorters.combined);
}

function applyFiltersAndRender() {
  const activeCategories = getActiveCheckboxValues('.categoryFilter');
  const activeTypes = getActiveCheckboxValues('.typeFilter');
  const search = els.searchInput.value.trim().toLowerCase();
  const distanceLimit = getDistanceFilter();

  let terraces = state.rawTerraces.map(enrichTerraceScores);
  terraces = terraces.filter((item) => activeCategories.includes(item.category));
  terraces = terraces.filter((item) => activeTypes.includes(item.terraceType));

  if (search) {
    terraces = terraces.filter((item) =>
      `${item.name} ${item.address} ${item.district} ${item.description}`.toLowerCase().includes(search)
    );
  }

  if (els.sunnyNowOnly.checked) terraces = terraces.filter((item) => item.sunnyNow);
  if (els.eveningOnly.checked) terraces = terraces.filter((item) => item.eveningSun);
  if (distanceLimit !== 'all') terraces = terraces.filter((item) => item.distance == null || item.distance <= Number(distanceLimit));

  sortTerraces(terraces);
  state.terraces = terraces;
  renderList();
  renderMapMarkers();
  renderTopPicks();
}

function formatDistance(meters) {
  if (meters == null) return 'Location not set';
  if (meters < 1000) return `${Math.round(meters)} m away`;
  return `${(meters / 1000).toFixed(1)} km away`;
}

function pct(value) {
  return `${Math.round(value * 100)}%`;
}

function googleMapsLink(item) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${item.lat},${item.lon}`)}`;
}

function renderList() {
  els.resultCount.textContent = `${state.terraces.length} result${state.terraces.length === 1 ? '' : 's'}`;
  if (!state.terraces.length) {
    els.resultsList.innerHTML = '<div class="result-card"><p>No terraces matched the current filters.</p></div>';
    return;
  }

  els.resultsList.innerHTML = state.terraces.map((item) => `
    <article class="result-card">
      <h3>${escapeHtml(item.name)}</h3>
      <div class="result-meta">
        <span class="badge">${escapeHtml(item.district)}</span>
        <span class="badge">${escapeHtml(item.category)}</span>
        <span class="badge">${escapeHtml(item.terraceType)}</span>
        <span class="badge ${item.sunnyNow ? 'sunny' : 'shade'}">Sun now ${pct(item.nowSunScore)}</span>
        <span class="badge ${item.eveningSun ? 'sunny' : ''}">Evening ${pct(item.eveningScore)}</span>
      </div>
      <p>${escapeHtml(item.description || item.address)}</p>
      <p>${escapeHtml(item.address)} · ${formatDistance(item.distance)} · confidence ${pct(item.confidence)}</p>
      <div class="result-actions">
        <a class="link-button" href="${googleMapsLink(item)}" target="_blank" rel="noreferrer">Open in Maps</a>
        ${item.website ? `<a class="link-button" href="${item.website}" target="_blank" rel="noreferrer">Website</a>` : ''}
      </div>
    </article>
  `).join('');
}

function renderMapMarkers() {
  for (const marker of state.terraceMarkers) marker.remove();
  state.terraceMarkers = [];

  const bounds = [];
  state.terraces.forEach((item, index) => {
    const marker = L.marker([item.lat, item.lon]).addTo(state.map);
    marker.bindPopup(`
      <strong>${escapeHtml(item.name)}</strong><br />
      ${escapeHtml(item.address)}<br />
      Sun now: ${pct(item.nowSunScore)}<br />
      Evening: ${pct(item.eveningScore)}<br />
      ${formatDistance(item.distance)}<br />
      Rank #${index + 1}
    `);
    state.terraceMarkers.push(marker);
    bounds.push([item.lat, item.lon]);
  });

  if (state.userLocation) bounds.push([state.userLocation.lat, state.userLocation.lon]);
  if (bounds.length) state.map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
}

function renderTopPicks() {
  const bestNow = state.terraces[0];
  const bestEvening = [...state.terraces].sort((a, b) => b.eveningScore - a.eveningScore)[0];
  const best1km = state.terraces.filter((item) => item.distance == null || item.distance <= 1000)[0];
  els.topNow.textContent = bestNow ? `${bestNow.name} · ${pct(bestNow.nowSunScore)}` : 'No match';
  els.topEvening.textContent = bestEvening ? `${bestEvening.name} · ${pct(bestEvening.eveningScore)}` : 'No match';
  els.top1km.textContent = best1km ? `${best1km.name} · ${formatDistance(best1km.distance)}` : 'No nearby match';
}

function setUserLocation(lat, lon) {
  state.userLocation = { lat, lon };
  if (state.userMarker) state.userMarker.remove();
  state.userMarker = L.marker([lat, lon], { title: 'Your location' }).addTo(state.map);
  state.userMarker.bindPopup('Your location').openPopup();
  applyFiltersAndRender();
}

function locateUser() {
  if (!navigator.geolocation) {
    updateStatus('Geolocation not supported in this browser');
    return;
  }
  updateStatus('Locating you…');
  navigator.geolocation.getCurrentPosition(
    (position) => {
      setUserLocation(position.coords.latitude, position.coords.longitude);
      updateStatus(`${state.sourceLabel} · location active`);
    },
    () => {
      updateStatus(`${state.sourceLabel} · location denied`);
      applyFiltersAndRender();
    },
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
  );
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function bindEvents() {
  els.locateBtn.addEventListener('click', locateUser);
  els.refreshBtn.addEventListener('click', loadTerraces);
  [els.searchInput, els.dateInput, els.timeInput, els.sortSelect, els.sunnyNowOnly, els.eveningOnly].forEach((el) => {
    el.addEventListener('input', applyFiltersAndRender);
    el.addEventListener('change', applyFiltersAndRender);
  });
  document.querySelectorAll('.categoryFilter, .typeFilter, input[name="distance"]').forEach((el) => {
    el.addEventListener('change', applyFiltersAndRender);
  });
}

async function main() {
  initMap();
  setDefaultInputs();
  bindEvents();
  await loadTerraces();
}

main();