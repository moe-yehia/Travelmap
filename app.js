/* =========================================================
   Travelmap — Draw Your Route
   Vanilla JS app: Leaflet + OSRM + Nominatim
   ========================================================= */

const MODES = [
  { id: 'walk',  icon: '🚶', label: 'Walk',  profile: 'foot',    color: '#3fb950' },
  { id: 'bike',  icon: '🚴', label: 'Bike',  profile: 'cycling', color: '#f0c14a' },
  { id: 'car',   icon: '🚗', label: 'Car',   profile: 'driving', color: '#4f8cff' },
  { id: 'bus',   icon: '🚌', label: 'Bus',   profile: 'driving', color: '#a855f7' },
  { id: 'train', icon: '🚆', label: 'Train', profile: null,      color: '#f04a4a' },
  { id: 'boat',  icon: '⛴️', label: 'Boat',  profile: null,      color: '#2dd4bf' },
  { id: 'plane', icon: '✈️', label: 'Plane', profile: null,      color: '#ec4899' },
];

const MODE_BY_ID = Object.fromEntries(MODES.map(m => [m.id, m]));

const NOMINATIM = 'https://nominatim.openstreetmap.org';
// Overpass mirrors. Primary first; the rest are fallbacks that may be down at
// any given moment. We use GET (not POST) so we avoid a CORS preflight, which
// some browsers/extensions/networks block.
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
];

// CORS-proxy fallback. Tried only if every direct endpoint fails with
// "Failed to fetch" — typically because a privacy extension (uBlock Origin,
// Privacy Badger) or a corporate firewall is blocking overpass-api.de. This
// proxy is rate-limited so we only use it as a last resort.
const OVERPASS_PROXIES = [
  (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
];

// Per-profile OSRM endpoints hosted by routing.openstreetmap.de.
// The public router.project-osrm.org demo only has the car graph loaded,
// so asking it for `foot` or `cycling` silently returns driving routes
// (with all the one-way-street detours that come with it). These
// per-profile hosts return real pedestrian / cycling routes.
const OSRM_HOSTS = {
  foot:    'https://routing.openstreetmap.de/routed-foot',
  cycling: 'https://routing.openstreetmap.de/routed-bike',
  driving: 'https://routing.openstreetmap.de/routed-car',
};

const STORAGE_KEY = 'travelmap.routes.v1'; // legacy — kept for migration
const TRIPS_KEY = 'travelmap.trips.v1';
const THEME_KEY = 'travelmap.theme';

// Helper — declared as a function (hoisted) so anything called during the
// initial script run can use it.
function $(id) { return document.getElementById(id); }

// ---------------- STATE ----------------
const state = {
  waypoints: [
    { name: '', latlng: null, kind: 'origin' },
    { name: '', latlng: null, kind: 'destination' },
  ],
  segmentModes: ['walk'],
  units: 'km',
  segments: [], // per-segment: { coords: [[lat,lng]...], distance, duration, mode }
  showInfo: false,
  panelMinimized: false,
  trips: [],
  activeContext: null, // { tripId, dayId, routeId } when editing a trip-bound route
  suggestions: [],
  showDiscover: false,
};

// ---------------- MAP ----------------
const map = L.map('map', { zoomControl: false }).setView(
  [40.7589, -73.9851],
  16
);
L.control.zoom({ position: 'bottomright' }).addTo(map);

const tileLayers = {
  dark: L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
      maxZoom: 19,
      subdomains: 'abcd',
    }
  ),
  light: L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
      maxZoom: 19,
      subdomains: 'abcd',
    }
  ),
};

let currentTheme = localStorage.getItem(THEME_KEY) || 'dark';
applyTheme(currentTheme);

const routeLayer = L.layerGroup().addTo(map);
const markersLayer = L.layerGroup().addTo(map);
const suggestionsLayer = L.layerGroup().addTo(map);
let playMarker = null;
let playAnimHandle = null;

// ---------------- HELPERS ----------------
const fmtKm = (m) => (m / 1000).toFixed(m < 10000 ? 2 : 1);
const fmtMi = (m) => (m / 1609.344).toFixed(m < 16000 ? 2 : 1);
const fmtMin = (s) => Math.max(1, Math.round(s / 60));

function letterFor(i) {
  return String.fromCharCode(65 + i); // A, B, ...
}

// Nominatim returns long, comma-separated addresses. For map labels we just
// want the recognizable bit — usually the first segment.
function shortName(name) {
  if (!name) return '';
  const first = name.split(',')[0].trim();
  return first.length > 32 ? first.slice(0, 30) + '…' : first;
}

function haversine(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

function toast(msg, ms = 2200) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), ms);
}

// ---------------- CUSTOM DIALOGS ----------------
// Replaces native window.prompt / window.confirm with in-app modals styled
// to match the rest of the UI. Both return Promises so callers can `await`.

let _dialogResolver = null;
let _dialogKeyHandler = null;
let _dialogHiddenModals = [];

function _hideOtherModalsForDialog() {
  // Hide any other open modal (e.g. the Trips modal) so the dialog is the
  // only thing on screen. We remember which ones were open so we can put
  // them back when the dialog closes.
  _dialogHiddenModals = [];
  document.querySelectorAll('.modal').forEach((m) => {
    if (m.id !== 'appDialog' && !m.hidden) {
      _dialogHiddenModals.push(m);
      m.hidden = true;
    }
  });
}

function _restoreModalsAfterDialog() {
  _dialogHiddenModals.forEach((m) => (m.hidden = false));
  _dialogHiddenModals = [];
}

function _closeDialog(value) {
  $('appDialog').hidden = true;
  _restoreModalsAfterDialog();
  if (_dialogKeyHandler) {
    document.removeEventListener('keydown', _dialogKeyHandler);
    _dialogKeyHandler = null;
  }
  const resolve = _dialogResolver;
  _dialogResolver = null;
  if (resolve) resolve(value);
}

function askInput({
  title,
  message = '',
  defaultValue = '',
  placeholder = '',
  type = 'text',
  confirmText = 'OK',
} = {}) {
  // If a dialog is already open, close it as cancelled first.
  if (_dialogResolver) _closeDialog(null);

  return new Promise((resolve) => {
    _dialogResolver = resolve;
    _hideOtherModalsForDialog();
    const dlg = $('appDialog');
    $('appDialogTitle').textContent = title || '';
    const msgEl = $('appDialogMessage');
    msgEl.textContent = message;
    msgEl.hidden = !message;
    const input = $('appDialogInput');
    input.hidden = false;
    input.type = type;
    input.placeholder = placeholder;
    input.value = defaultValue;
    $('appDialogConfirm').textContent = confirmText;
    $('appDialogConfirm').classList.remove('danger');
    dlg.hidden = false;

    setTimeout(() => {
      input.focus();
      if (type === 'text') input.select();
    }, 30);

    _dialogKeyHandler = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const v = input.value.trim();
        _closeDialog(v || null);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        _closeDialog(null);
      }
    };
    document.addEventListener('keydown', _dialogKeyHandler);
  });
}

function askConfirm({
  title,
  message = '',
  confirmText = 'OK',
  cancelText = 'Cancel',
  danger = false,
} = {}) {
  if (_dialogResolver) _closeDialog(null);

  return new Promise((resolve) => {
    _dialogResolver = resolve;
    _hideOtherModalsForDialog();
    const dlg = $('appDialog');
    $('appDialogTitle').textContent = title || '';
    const msgEl = $('appDialogMessage');
    msgEl.textContent = message;
    msgEl.hidden = !message;
    $('appDialogInput').hidden = true;
    $('appDialogCancel').textContent = cancelText;
    const confirmBtn = $('appDialogConfirm');
    confirmBtn.textContent = confirmText;
    confirmBtn.classList.toggle('danger', !!danger);
    dlg.hidden = false;

    setTimeout(() => confirmBtn.focus(), 30);

    _dialogKeyHandler = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        _closeDialog(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        _closeDialog(false);
      }
    };
    document.addEventListener('keydown', _dialogKeyHandler);
  });
}

// Read-only "copy this URL" dialog for the share fallback.
function showCopyDialog({ title, value }) {
  if (_dialogResolver) _closeDialog(null);
  return new Promise((resolve) => {
    _dialogResolver = resolve;
    const dlg = $('appDialog');
    $('appDialogTitle').textContent = title || '';
    $('appDialogMessage').hidden = true;
    const input = $('appDialogInput');
    input.hidden = false;
    input.type = 'text';
    input.value = value;
    input.readOnly = true;
    $('appDialogConfirm').textContent = 'Copy';
    $('appDialogConfirm').classList.remove('danger');
    $('appDialogCancel').textContent = 'Close';
    dlg.hidden = false;

    setTimeout(() => {
      input.focus();
      input.select();
    }, 30);

    _dialogKeyHandler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        input.readOnly = false;
        _closeDialog(null);
      }
    };
    document.addEventListener('keydown', _dialogKeyHandler);
  });
}

// ---------------- THEME ----------------
function applyTheme(theme) {
  currentTheme = theme;
  localStorage.setItem(THEME_KEY, theme);
  Object.values(tileLayers).forEach((l) => map.removeLayer(l));
  tileLayers[theme].addTo(map);
  document.body.classList.toggle('light', theme === 'light');
  const btn = $('themeBtn');
  if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
}

// ---------------- GEOCODING ----------------
async function geocode(q) {
  if (!q || q.length < 2) return [];
  const url = `${NOMINATIM}/search?format=json&q=${encodeURIComponent(
    q
  )}&limit=6&addressdetails=1`;
  const res = await fetch(url, {
    headers: { 'Accept-Language': 'en' },
  });
  if (!res.ok) return [];
  return res.json();
}

async function reverseGeocode(lat, lng) {
  const url = `${NOMINATIM}/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

// ---------------- ROUTING ----------------
async function routeOSRM(profile, from, to) {
  const host = OSRM_HOSTS[profile];
  if (!host) throw new Error(`Unsupported profile: ${profile}`);
  // routing.openstreetmap.de uses the v1 URL with 'driving' as the literal
  // path segment regardless of profile — the host itself determines the graph.
  const url = `${host}/route/v1/driving/${from[1]},${from[0]};${to[1]},${to[0]}?overview=full&geometries=geojson`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('OSRM error');
  const data = await res.json();
  if (!data.routes || !data.routes.length) throw new Error('No route');
  const r = data.routes[0];
  return {
    coords: r.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
    distance: r.distance,
    duration: r.duration,
  };
}

function straightSegment(from, to) {
  return {
    coords: [from, to],
    distance: haversine(from, to),
    duration: 0,
  };
}

async function computeSegment(mode, from, to) {
  const m = MODE_BY_ID[mode];
  if (!m || !m.profile) return straightSegment(from, to);
  try {
    return await routeOSRM(m.profile, from, to);
  } catch (e) {
    console.warn('Routing failed, falling back to straight line', e);
    return straightSegment(from, to);
  }
}

// ---------------- RENDER PANEL ----------------
function renderPanel() {
  const wrap = $('waypoints');
  wrap.innerHTML = '';
  state.waypoints.forEach((wp, i) => {
    const isFirst = i === 0;
    const isLast = i === state.waypoints.length - 1;
    const letter = letterFor(i);
    const dotClass = isFirst ? 'dot-A' : isLast ? 'dot-E' : 'dot-mid';
    const placeholder = isFirst
      ? 'Origin'
      : isLast
      ? 'Destination'
      : `Stop ${letter}`;

    const wpDiv = document.createElement('div');
    wpDiv.className = 'waypoint';
    wpDiv.innerHTML = `
      <div class="waypoint-row" data-idx="${i}">
        <div class="waypoint-dot ${dotClass}" data-idx="${i}" draggable="true" title="Drag to reorder">${letter}</div>
        <input
          class="waypoint-input"
          type="text"
          data-idx="${i}"
          placeholder="${placeholder}"
          value="${escapeAttr(wp.name)}"
          autocomplete="off" />
        <button class="waypoint-remove" data-idx="${i}" title="Clear / Remove">×</button>
        <div class="wp-suggestions" data-idx="${i}" hidden></div>
      </div>
    `;
    wrap.appendChild(wpDiv);

    if (isLast) {
      // After the destination — let the user extend the route
      const appendRow = document.createElement('div');
      appendRow.className = 'append-row';
      appendRow.innerHTML = `<button class="add-stop-end" data-action="append">+ Add stop</button>`;
      wrap.appendChild(appendRow);
    }

    if (!isLast) {
      const modeRow = document.createElement('div');
      modeRow.className = 'mode-row';
      const mode = state.segmentModes[i] || 'walk';
      modeRow.innerHTML =
        MODES.map((m) => {
          const isActive = m.id === mode;
          const style = isActive
            ? `style="border-color:${m.color};background:${m.color}22;"`
            : '';
          const labelStyle = isActive ? `style="color:${m.color};"` : '';
          return `
          <button class="mode-btn ${isActive ? 'active' : ''}"
            data-seg="${i}" data-mode="${m.id}" title="${m.label}" ${style}>
            <span class="mode-icon">${m.icon}</span>
            <span class="mode-label" ${labelStyle}>${m.label}</span>
          </button>`;
        }).join('') +
        `<button class="add-stop" data-after="${i}" title="Insert stop">+&nbsp;Stop</button>`;
      wrap.appendChild(modeRow);
    }
  });

  bindWaypointEvents();
  renderDistance();
  renderRouteInfo();
}

function escapeAttr(s) {
  return (s || '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function bindWaypointEvents() {
  // Inputs (debounced search OR rename — depending on whether the waypoint
  // already has coordinates).
  document.querySelectorAll('.waypoint-input').forEach((inp) => {
    inp.addEventListener(
      'input',
      debounce(async (e) => {
        const idx = +e.target.dataset.idx;
        const q = e.target.value.trim();
        const wp = state.waypoints[idx];
        wp.name = q;
        const box = document.querySelector(
          `.wp-suggestions[data-idx="${idx}"]`
        );

        // If this waypoint is already located on the map, typing is a rename.
        // Skip autocomplete, mark the name as user-set so reverse geocoding
        // and drags won't overwrite it, and refresh map labels.
        if (wp.latlng) {
          wp.customName = true;
          if (box) {
            box.hidden = true;
            box.innerHTML = '';
          }
          refreshMap();
          return;
        }

        if (!q) {
          box.hidden = true;
          box.innerHTML = '';
          return;
        }
        const results = await geocode(q);
        if (!results.length) {
          box.hidden = true;
          return;
        }
        box.hidden = false;
        box.innerHTML = results
          .map(
            (r, k) =>
              `<div class="suggestion" data-lat="${r.lat}" data-lon="${
                r.lon
              }" data-display="${escapeAttr(r.display_name)}">${escapeHTML(
                r.display_name
              )}</div>`
          )
          .join('');
        box.querySelectorAll('.suggestion').forEach((sug) => {
          sug.addEventListener('click', () => {
            const lat = parseFloat(sug.dataset.lat);
            const lon = parseFloat(sug.dataset.lon);
            const display = sug.dataset.display;
            setWaypoint(idx, display, [lat, lon]);
            box.hidden = true;
          });
        });
      }, 350)
    );

    inp.addEventListener('blur', () => {
      setTimeout(() => {
        const idx = +inp.dataset.idx;
        const box = document.querySelector(
          `.wp-suggestions[data-idx="${idx}"]`
        );
        if (box) box.hidden = true;
      }, 200);
    });
  });

  // Remove buttons
  document.querySelectorAll('.waypoint-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = +btn.dataset.idx;
      removeWaypoint(idx);
    });
  });

  // Mode buttons
  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const seg = +btn.dataset.seg;
      state.segmentModes[seg] = btn.dataset.mode;
      renderPanel();
      recomputeRoute();
    });
  });

  // Add stop (between existing waypoints, from a mode row)
  document.querySelectorAll('.add-stop').forEach((btn) => {
    btn.addEventListener('click', () => {
      const after = +btn.dataset.after;
      insertStopAfter(after);
    });
  });

  // Append a new waypoint at the end of the route
  const appendBtn = document.querySelector('.add-stop-end');
  if (appendBtn) {
    appendBtn.addEventListener('click', appendStop);
  }

  // Drag-and-drop to reorder waypoints (handle = the letter dot)
  document.querySelectorAll('.waypoint-dot').forEach((dot) => {
    dot.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', dot.dataset.idx);
      e.dataTransfer.effectAllowed = 'move';
      dot.closest('.waypoint').classList.add('dragging');
    });
    dot.addEventListener('dragend', () => {
      document.querySelectorAll('.waypoint').forEach((w) => {
        w.classList.remove('dragging', 'drop-target');
      });
    });
  });

  document.querySelectorAll('.waypoint').forEach((wpEl) => {
    wpEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      document
        .querySelectorAll('.waypoint')
        .forEach((w) => w.classList.remove('drop-target'));
      wpEl.classList.add('drop-target');
    });
    wpEl.addEventListener('dragleave', (e) => {
      // only remove when leaving to outside the element
      if (!wpEl.contains(e.relatedTarget)) {
        wpEl.classList.remove('drop-target');
      }
    });
    wpEl.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
      const row = wpEl.querySelector('.waypoint-row');
      const to = parseInt(row?.dataset.idx ?? '-1', 10);
      if (Number.isNaN(from) || Number.isNaN(to) || from === to) return;
      moveWaypoint(from, to);
    });
  });
}

function escapeHTML(s) {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------------- WAYPOINT OPS ----------------
function setWaypoint(idx, name, latlng) {
  state.waypoints[idx].name = name;
  state.waypoints[idx].latlng = latlng;
  // Picking a suggestion replaces the location and resets the user-named flag
  state.waypoints[idx].customName = false;
  renderPanel();
  refreshMap();
  fitToWaypoints();
  recomputeRoute();
}

function removeWaypoint(idx) {
  if (state.waypoints.length <= 2) {
    // Minimum is 2 waypoints (origin + destination) — just clear this one.
    state.waypoints[idx].name = '';
    state.waypoints[idx].latlng = null;
    state.waypoints[idx].customName = false;
  } else {
    // Remove the waypoint outright. We also need to drop one segment-mode so
    // the modes list stays length-aligned (waypoints.length - 1).
    state.waypoints.splice(idx, 1);
    if (idx === 0) {
      // Removed the origin — the segment that started at it is gone.
      state.segmentModes.shift();
    } else if (idx === state.waypoints.length) {
      // After splice, idx now equals the new length when the old waypoint
      // was last. The segment that ended at it is gone.
      state.segmentModes.pop();
    } else {
      // Removed a middle stop. The outgoing segment merges with the previous
      // one; keep the incoming mode and drop the outgoing.
      state.segmentModes.splice(idx, 1);
    }
    // Re-tag endpoint kinds for the new sequence.
    const last = state.waypoints.length - 1;
    state.waypoints.forEach((w, i) => {
      w.kind = i === 0 ? 'origin' : i === last ? 'destination' : 'stop';
    });
  }
  renderPanel();
  refreshMap();
  recomputeRoute();
}

function insertStopAfter(idx) {
  // Insert a new empty waypoint at position idx+1
  state.waypoints.splice(idx + 1, 0, {
    name: '',
    latlng: null,
    kind: 'stop',
  });
  // Inherit mode from the segment we're splitting
  state.segmentModes.splice(idx + 1, 0, state.segmentModes[idx] || 'walk');
  renderPanel();
}

// ---------------- OPTIMIZE ORDER ----------------
// Reorder waypoints to minimize total travel distance, keeping the origin
// (index 0) in place. Uses the OSRM Table API for a real road-distance matrix
// when possible, falling back to straight-line distance.
async function fetchDistanceMatrix(coords, profile = 'foot') {
  const host = OSRM_HOSTS[profile] || OSRM_HOSTS.foot;
  const coordStr = coords.map((c) => `${c[1]},${c[0]}`).join(';');
  const url = `${host}/table/v1/driving/${coordStr}?annotations=distance`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Table API error');
  const data = await res.json();
  if (!data.distances) throw new Error('No distance matrix in response');
  return data.distances;
}

function haversineMatrix(coords) {
  return coords.map((a) => coords.map((b) => haversine(a, b)));
}

function pathDistance(matrix, order) {
  let total = 0;
  for (let i = 0; i < order.length - 1; i++) {
    total += matrix[order[i]][order[i + 1]];
  }
  return total;
}

function* permutations(arr) {
  if (arr.length <= 1) {
    yield arr.slice();
    return;
  }
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permutations(rest)) {
      yield [arr[i], ...p];
    }
  }
}

function nearestNeighborOrder(matrix, start, others, fixedEnd = null) {
  // Walk greedy from `start` through `others`. If a `fixedEnd` index is
  // provided, it's excluded from the greedy walk and appended at the end.
  const remaining = new Set(others.filter((i) => i !== fixedEnd));
  const order = [start];
  let current = start;
  while (remaining.size > 0) {
    let best = -1;
    let bestDist = Infinity;
    for (const i of remaining) {
      if (matrix[current][i] < bestDist) {
        bestDist = matrix[current][i];
        best = i;
      }
    }
    order.push(best);
    remaining.delete(best);
    current = best;
  }
  if (fixedEnd !== null && fixedEnd !== start) order.push(fixedEnd);
  return order;
}

// 2-opt refinement: swap any pair of edges if it shortens the route.
function twoOpt(matrix, order) {
  const n = order.length;
  let improved = true;
  let best = order.slice();
  while (improved) {
    improved = false;
    for (let i = 1; i < n - 2; i++) {
      for (let j = i + 1; j < n - 1; j++) {
        const candidate = best
          .slice(0, i)
          .concat(best.slice(i, j + 1).reverse(), best.slice(j + 1));
        if (pathDistance(matrix, candidate) < pathDistance(matrix, best)) {
          best = candidate;
          improved = true;
        }
      }
    }
  }
  return best;
}

async function optimizeOrder() {
  const wps = state.waypoints;
  const allLocated = wps.every((w) => w.latlng);
  if (wps.length < 3) {
    toast('Add at least 3 waypoints first');
    return;
  }
  if (!allLocated) {
    toast('Set a location for every waypoint first');
    return;
  }
  const coords = wps.map((w) => w.latlng);

  const btn = $('optimizeBtn');
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span>⏳</span> Optimizing…';

  let matrix;
  try {
    // Use foot profile for a uniform pedestrian distance graph
    matrix = await fetchDistanceMatrix(coords, 'foot');
  } catch (e) {
    console.warn('Table API failed, using haversine fallback', e);
    matrix = haversineMatrix(coords);
  }

  // The origin is always kept in place. Whether the LAST waypoint is kept
  // in place (a "returning point" / round trip) is up to the user, via the
  // "Return to start" checkbox. We auto-detect when the first and last
  // waypoints are at the same physical location — in that case the route
  // is clearly a round trip and we don't bother asking.
  const N = wps.length;
  const lastIdx = N - 1;
  const autoDetectedRoundTrip =
    N >= 2 && haversine(wps[0].latlng, wps[lastIdx].latlng) < 100;
  const userWantsLockedEnd = $('lockEndpoints')?.checked ?? false;
  const lockEnd = autoDetectedRoundTrip || userWantsLockedEnd;

  if (N < 3) {
    toast('Add at least one stop between your origin and destination');
    return;
  }
  if (lockEnd && N < 4) {
    toast('Add at least 2 stops between your start and end to optimize a round trip');
    return;
  }

  // Build the permutation set + the "before" baseline.
  let middle, beforeOrder, wrap;
  if (lockEnd) {
    middle = Array.from({ length: N - 2 }, (_, i) => i + 1);
    beforeOrder = [0, ...middle, lastIdx];
    wrap = (perm) => [0, ...perm, lastIdx];
  } else {
    middle = Array.from({ length: N - 1 }, (_, i) => i + 1);
    beforeOrder = [0, ...middle];
    wrap = (perm) => [0, ...perm];
  }
  const beforeDist = pathDistance(matrix, beforeOrder);

  let bestOrder;
  if (middle.length <= 8) {
    // Brute force — up to 8! = 40,320 permutations, instant in JS
    let bestDist = Infinity;
    for (const perm of permutations(middle)) {
      const order = wrap(perm);
      const d = pathDistance(matrix, order);
      if (d < bestDist) {
        bestDist = d;
        bestOrder = order;
      }
    }
  } else {
    // Too many for brute force — nearest neighbor + 2-opt. twoOpt() already
    // preserves the first and last positions, so when we lock the end the
    // last position stays put. When we don't lock the end, we pass no
    // forced final node so NN picks the best path.
    bestOrder = nearestNeighborOrder(matrix, 0, middle, lockEnd ? lastIdx : null);
    bestOrder = twoOpt(matrix, bestOrder);
  }

  const afterDist = pathDistance(matrix, bestOrder);
  const newWps = bestOrder.map((i) => wps[i]);
  // Reset endpoint kinds for the new positions
  const last = newWps.length - 1;
  newWps.forEach((w, i) => {
    w.kind = i === 0 ? 'origin' : i === last ? 'destination' : 'stop';
  });
  state.waypoints = newWps;

  btn.disabled = false;
  btn.innerHTML = originalText;

  const tripLabel = isRoundTrip ? 'Round trip · ' : '';
  if (afterDist >= beforeDist - 1) {
    toast(`${tripLabel}Order is already optimal`);
  } else {
    const saved = ((beforeDist - afterDist) / 1000).toFixed(2);
    toast(`${tripLabel}Reordered — saved ~${saved} km`);
  }
  renderPanel();
  refreshMap();
  fitToWaypoints();
  recomputeRoute();
}

// ---------------- DISCOVER NEARBY POIs ----------------
// Geodesic-accurate point-to-segment distance in meters.
function pointToSegmentMeters(p, a, b) {
  const midLat = (a[0] + b[0]) / 2;
  const k = Math.cos((midLat * Math.PI) / 180);
  const M_LAT = 111320; // meters per degree latitude
  const M_LON = M_LAT * k;
  const ax = a[1] * M_LON, ay = a[0] * M_LAT;
  const bx = b[1] * M_LON, by = b[0] * M_LAT;
  const px = p[1] * M_LON, py = p[0] * M_LAT;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx;
  const qy = ay + t * dy;
  return Math.hypot(px - qx, py - qy);
}

// Find the segment whose polyline passes closest to `point`, plus that
// distance. We use this both to filter out POIs that are too far away and
// to decide which segment to insert the POI into when the user adds it.
function nearestSegmentToPoint(point, segments) {
  let bestDist = Infinity;
  let bestSegIdx = -1;
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    if (!seg || !seg.coords) continue;
    for (let i = 1; i < seg.coords.length; i++) {
      const d = pointToSegmentMeters(point, seg.coords[i - 1], seg.coords[i]);
      if (d < bestDist) {
        bestDist = d;
        bestSegIdx = s;
      }
    }
  }
  return { distance: bestDist, segIdx: bestSegIdx };
}

const POI_ICONS = {
  attraction: '🎡', museum: '🏛️', gallery: '🎨', artwork: '🖼️',
  viewpoint: '👁️', monument: '🗿', memorial: '🕯️', castle: '🏰',
  fort: '🏯', ruins: '🏚️', archaeological_site: '⛏️', theme_park: '🎢',
  zoo: '🦁', park: '🌳',
};

function poiTypeOf(tags) {
  return tags.tourism || tags.historic || tags.leisure || 'place';
}

function poiIconOf(tags) {
  const t = poiTypeOf(tags);
  return POI_ICONS[t] || '📍';
}

async function discoverNearby() {
  const located = state.waypoints.filter((w) => w.latlng);
  if (located.length < 2) {
    toast('Add at least an origin and destination first');
    return;
  }
  // Build the line we measure distances against. Prefer real route segments;
  // fall back to straight-line waypoints if routing hasn't completed.
  let routePoints = state.segments
    .flatMap((s) => (s ? s.coords : []))
    .filter(Boolean);
  if (!routePoints.length) routePoints = located.map((w) => w.latlng);

  const lats = routePoints.map((p) => p[0]);
  const lngs = routePoints.map((p) => p[1]);
  const PAD = 0.004; // ~ 450m
  const bbox = [
    Math.min(...lats) - PAD,
    Math.min(...lngs) - PAD,
    Math.max(...lats) + PAD,
    Math.max(...lngs) + PAD,
  ];

  const query = `
    [out:json][timeout:25];
    (
      node["tourism"~"attraction|museum|viewpoint|gallery|artwork|theme_park|zoo"](${bbox.join(',')});
      node["historic"~"monument|memorial|castle|fort|ruins|archaeological_site"](${bbox.join(',')});
      node["leisure"="park"](${bbox.join(',')});
    );
    out body 80;
  `;

  const status = $('discoverStatus');
  const listEl = $('suggestionsList');
  status.textContent = 'Searching nearby places…';
  listEl.innerHTML = '';

  // Try each direct endpoint. If they all give us "Failed to fetch"
  // (i.e. browser blocked the request before it left), fall back to a
  // CORS proxy.
  async function attempt(url, host, label) {
    status.textContent = `Searching via ${label}…`;
    const ctl = new AbortController();
    const tid = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      clearTimeout(tid);
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const data = await res.json();
      return { ok: true, elements: data.elements || [] };
    } catch (e) {
      clearTimeout(tid);
      const reason =
        e.name === 'AbortError'
          ? 'timed out'
          : e.message || e.toString() || 'network error';
      return { ok: false, error: reason };
    }
  }

  let elements;
  const errors = [];
  let everyDirectWasBlocked = true;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    const host = new URL(endpoint).host;
    const url = `${endpoint}?data=${encodeURIComponent(query)}`;
    const r = await attempt(url, host, host);
    if (r.ok) {
      elements = r.elements;
      break;
    }
    errors.push(`${host}: ${r.error}`);
    if (!/Failed to fetch|NetworkError/i.test(r.error)) {
      everyDirectWasBlocked = false;
    }
  }

  if (!elements && everyDirectWasBlocked) {
    // Direct requests were all blocked at the browser level — likely a
    // privacy extension or corporate firewall. Route through a public
    // CORS proxy as a last resort.
    const direct = OVERPASS_ENDPOINTS[0] + '?data=' + encodeURIComponent(query);
    for (const wrap of OVERPASS_PROXIES) {
      const proxied = wrap(direct);
      const proxyHost = new URL(proxied).host;
      const r = await attempt(proxied, proxyHost, `${proxyHost} (proxy)`);
      if (r.ok) {
        elements = r.elements;
        break;
      }
      errors.push(`${proxyHost} (proxy): ${r.error}`);
    }
  }

  if (!elements) {
    console.warn('Overpass attempts failed:', errors);
    const blockedHint = everyDirectWasBlocked
      ? ' This usually means a browser extension (ad blocker, privacy tool) or your network is blocking overpass-api.de. Try disabling extensions or switching networks.'
      : '';
    status.textContent = `Places service unavailable.${blockedHint} (${errors.join(' · ')})`;
    return;
  }

  // Build a quick set of already-added coords (rounded) so we don't
  // recommend things the user is already visiting.
  const existing = new Set(
    state.waypoints
      .filter((w) => w.latlng)
      .map((w) => `${w.latlng[0].toFixed(4)},${w.latlng[1].toFixed(4)}`)
  );

  // Build the same "route polyline" we'll measure distance from.
  // If we have real segments, use them; otherwise stitch waypoints into
  // pseudo-segments so distance still works.
  const measureSegments =
    state.segments.length && state.segments.some((s) => s && s.coords)
      ? state.segments
      : (() => {
          const out = [];
          for (let i = 0; i < located.length - 1; i++) {
            out.push({ coords: [located[i].latlng, located[i + 1].latlng] });
          }
          return out;
        })();

  const MAX_DIST_M = 350;
  state.suggestions = elements
    .filter((p) => p.tags && p.tags.name)
    .map((p) => {
      const latlng = [p.lat, p.lon];
      const key = `${latlng[0].toFixed(4)},${latlng[1].toFixed(4)}`;
      if (existing.has(key)) return null;
      const { distance, segIdx } = nearestSegmentToPoint(latlng, measureSegments);
      return {
        id: p.id,
        name: p.tags.name,
        tags: p.tags,
        latlng,
        distance,
        segIdx: segIdx < 0 ? 0 : segIdx,
      };
    })
    .filter((p) => p && p.distance <= MAX_DIST_M)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 15);

  if (!state.suggestions.length) {
    status.textContent = 'No places of interest found near this route.';
  } else {
    status.textContent = `${state.suggestions.length} places along your route`;
  }
  renderSuggestions();
  drawSuggestionMarkers();
}

function renderSuggestions() {
  const listEl = $('suggestionsList');
  if (!state.suggestions.length) {
    listEl.innerHTML = '';
    return;
  }
  listEl.innerHTML = state.suggestions
    .map((p, i) => {
      const type = poiTypeOf(p.tags);
      const icon = poiIconOf(p.tags);
      return `
      <div class="suggestion-item" data-idx="${i}">
        <span class="suggestion-icon">${icon}</span>
        <div class="suggestion-body">
          <div class="suggestion-name">${escapeHTML(p.name)}</div>
          <div class="suggestion-meta">${escapeHTML(type)} · ${Math.round(p.distance)} m from route</div>
        </div>
        <button class="suggestion-add" data-idx="${i}" title="Add to route">+ Add</button>
      </div>
    `;
    })
    .join('');
  listEl.querySelectorAll('.suggestion-add').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      addSuggestion(+btn.dataset.idx);
    });
  });
  listEl.querySelectorAll('.suggestion-item').forEach((row) => {
    row.addEventListener('click', () => {
      const p = state.suggestions[+row.dataset.idx];
      map.setView(p.latlng, Math.max(map.getZoom(), 16));
    });
  });
}

function drawSuggestionMarkers() {
  suggestionsLayer.clearLayers();
  state.suggestions.forEach((p, i) => {
    const icon = L.divIcon({
      className: '',
      html: `<div class="poi-marker">${poiIconOf(p.tags)}</div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });
    const marker = L.marker(p.latlng, { icon }).addTo(suggestionsLayer);
    marker.bindTooltip(p.name, {
      direction: 'top',
      offset: [0, -10],
      className: 'wp-tooltip',
    });
    marker.on('click', () => addSuggestion(i));
  });
}

function addSuggestion(idx) {
  const p = state.suggestions[idx];
  if (!p) return;
  // Insert as a new waypoint right after the segment it's closest to,
  // i.e. between waypoint[segIdx] and waypoint[segIdx + 1].
  const insertAt = p.segIdx + 1;
  state.waypoints.splice(insertAt, 0, {
    name: p.name,
    latlng: p.latlng,
    kind: 'stop',
  });
  state.segmentModes.splice(insertAt, 0, state.segmentModes[p.segIdx] || 'walk');
  // Re-tag endpoint kinds and remove this suggestion
  const last = state.waypoints.length - 1;
  state.waypoints.forEach((w, i) => {
    w.kind = i === 0 ? 'origin' : i === last ? 'destination' : 'stop';
  });
  state.suggestions.splice(idx, 1);
  renderPanel();
  refreshMap();
  recomputeRoute();
  renderSuggestions();
  drawSuggestionMarkers();
  toast(`Added "${p.name}"`);
}

function toggleDiscover() {
  state.showDiscover = !state.showDiscover;
  const section = $('discoverSection');
  const btn = $('discoverToggle');
  section.hidden = !state.showDiscover;
  btn.innerHTML = state.showDiscover
    ? '<span>🔍</span> Hide suggestions'
    : '<span>🔍</span> Discover nearby places';
  if (state.showDiscover) {
    discoverNearby();
  } else {
    state.suggestions = [];
    suggestionsLayer.clearLayers();
  }
}

function moveWaypoint(from, to) {
  if (from === to) return;
  const [wp] = state.waypoints.splice(from, 1);
  state.waypoints.splice(to, 0, wp);
  // Re-tag endpoint kinds (origin / destination / stop)
  const last = state.waypoints.length - 1;
  state.waypoints.forEach((w, i) => {
    w.kind = i === 0 ? 'origin' : i === last ? 'destination' : 'stop';
  });
  renderPanel();
  refreshMap();
  recomputeRoute();
}

function appendStop() {
  // The previous destination becomes a stop; the new one is the destination.
  const lastIdx = state.waypoints.length - 1;
  if (state.waypoints[lastIdx]) state.waypoints[lastIdx].kind = 'stop';
  state.waypoints.push({ name: '', latlng: null, kind: 'destination' });
  // Inherit the mode from the last segment, or default to walk
  state.segmentModes.push(state.segmentModes[lastIdx - 1] || 'walk');
  renderPanel();
  recomputeRoute();
}

function clearAll() {
  state.waypoints = [
    { name: '', latlng: null, kind: 'origin' },
    { name: '', latlng: null, kind: 'destination' },
  ];
  state.segmentModes = ['walk'];
  state.segments = [];
  state.suggestions = [];
  setActiveContext(null);
  stopPlay();
  suggestionsLayer.clearLayers();
  renderPanel();
  refreshMap();
}

// ---------------- MAP RENDERING ----------------
function makeMarker(latlng, letter, isFirst, isLast) {
  const cls = isFirst ? 'A' : isLast ? 'E' : '';
  const icon = L.divIcon({
    className: '',
    html: `<div class="wp-marker ${cls}">${letter}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
  return L.marker(latlng, { icon, draggable: true });
}

function refreshMap() {
  markersLayer.clearLayers();
  routeLayer.clearLayers();
  state.waypoints.forEach((wp, i) => {
    if (!wp.latlng) return;
    const isFirst = i === 0;
    const isLast = i === state.waypoints.length - 1;
    const m = makeMarker(wp.latlng, letterFor(i), isFirst, isLast);
    const label = shortName(wp.name);
    if (label) {
      m.bindTooltip(label, {
        permanent: true,
        direction: 'right',
        offset: [14, 0],
        className: `wp-tooltip ${isFirst ? 'A' : isLast ? 'E' : ''}`,
      });
    }
    m.on('dragend', async (e) => {
      const ll = e.target.getLatLng();
      const newLatlng = [ll.lat, ll.lng];
      state.waypoints[i].latlng = newLatlng;
      // Don't overwrite a user-chosen name when the waypoint moves.
      if (!state.waypoints[i].customName) {
        const rev = await reverseGeocode(newLatlng[0], newLatlng[1]).catch(
          () => null
        );
        state.waypoints[i].name = rev?.display_name || `${ll.lat}, ${ll.lng}`;
      }
      renderPanel();
      refreshMap();
      recomputeRoute();
    });
    m.addTo(markersLayer);
  });
  drawRoute();
}

function drawRoute() {
  routeLayer.clearLayers();
  state.segments.forEach((seg, i) => {
    if (!seg) return;
    const modeId = seg.mode || state.segmentModes[i] || 'walk';
    const m = MODE_BY_ID[modeId];
    const isStraight = !m?.profile;
    L.polyline(seg.coords, {
      color: m?.color || '#4f8cff',
      weight: 5,
      opacity: 0.92,
      dashArray: isStraight ? '8 8' : null,
      lineJoin: 'round',
      lineCap: 'round',
    }).addTo(routeLayer);
  });
}

function fitToWaypoints() {
  const pts = state.waypoints.filter((w) => w.latlng).map((w) => w.latlng);
  if (pts.length < 2) {
    if (pts.length === 1) map.setView(pts[0], Math.max(map.getZoom(), 14));
    return;
  }
  map.fitBounds(L.latLngBounds(pts), { padding: [60, 60] });
}

// ---------------- ROUTE COMPUTATION ----------------
let routeReqId = 0;
async function recomputeRoute() {
  const reqId = ++routeReqId;
  state.segments = [];
  const pairs = [];
  for (let i = 0; i < state.waypoints.length - 1; i++) {
    const a = state.waypoints[i];
    const b = state.waypoints[i + 1];
    if (a.latlng && b.latlng) {
      pairs.push({ i, from: a.latlng, to: b.latlng, mode: state.segmentModes[i] });
    } else {
      pairs.push(null);
    }
  }

  const results = await Promise.all(
    pairs.map((p) => (p ? computeSegment(p.mode, p.from, p.to) : null))
  );
  if (reqId !== routeReqId) return; // a newer request came in
  // Keep null placeholders so segment indices align with segmentModes
  state.segments = results.map((r, i) =>
    r ? { ...r, mode: state.segmentModes[i] } : null
  );
  drawRoute();
  renderDistance();
  renderRouteInfo();
}

// ---------------- DISTANCE / INFO ----------------
function totalDistance() {
  return state.segments.reduce((acc, s) => acc + (s?.distance || 0), 0);
}

function renderDistance() {
  const d = totalDistance();
  const text =
    state.units === 'km' ? `${fmtKm(d)} km` : `${fmtMi(d)} mi`;
  $('distanceValue').textContent = text;
}

function renderRouteInfo() {
  const box = $('routeInfo');
  const toggle = $('routeInfoToggle');
  box.hidden = !state.showInfo;
  toggle.textContent = state.showInfo
    ? 'Hide route information'
    : 'Show route information';
  if (!state.showInfo) return;

  let html = '<h3>BY SEGMENT</h3>';
  for (let i = 0; i < state.waypoints.length - 1; i++) {
    const from = letterFor(i);
    const to = letterFor(i + 1);
    const seg = state.segments[i];
    const mode = MODE_BY_ID[state.segmentModes[i]];
    let stats = '—';
    if (seg) {
      const d =
        state.units === 'km'
          ? `${fmtKm(seg.distance)} km`
          : `${fmtMi(seg.distance)} mi`;
      stats = seg.duration
        ? `${d} · ${fmtMin(seg.duration)} min`
        : d;
    }
    html += `
      <div class="segment">
        <span class="segment-label">${from} → ${to}</span>
        <span class="segment-mode">${mode.icon} ${mode.label}</span>
        <span class="segment-stats">${stats}</span>
      </div>
    `;
  }
  box.innerHTML = html;
}

// ---------------- TRIPS / DAYS / ROUTES ----------------
// Storage model:
// trips: [{ id, name, createdAt, days: [{ id, date (YYYY-MM-DD), routes: [{ id, name, savedAt, waypoints, segmentModes, units }] }] }]

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}

function loadTrips() {
  try {
    const data = JSON.parse(localStorage.getItem(TRIPS_KEY) || '[]');
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function persistTrips() {
  localStorage.setItem(TRIPS_KEY, JSON.stringify(state.trips));
}

// One-time migration: if the user has legacy flat saves but no trips yet,
// fold them all into an "Imported routes" trip dated today.
function migrateLegacyRoutes() {
  if (state.trips.length > 0) return;
  let legacy;
  try {
    legacy = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return;
  }
  if (!Array.isArray(legacy) || legacy.length === 0) return;
  const today = new Date().toISOString().slice(0, 10);
  const imported = {
    id: makeId('trip'),
    name: 'Imported routes',
    createdAt: new Date().toISOString(),
    days: [
      {
        id: makeId('day'),
        date: today,
        routes: legacy.map((r) => ({
          id: makeId('route'),
          name: r.name,
          savedAt: r.savedAt || new Date().toISOString(),
          waypoints: r.waypoints || [],
          segmentModes: r.segmentModes || ['walk'],
          units: r.units || 'km',
        })),
      },
    ],
  };
  state.trips.push(imported);
  persistTrips();
  // Keep the legacy key in storage as a safety net.
}

function findContext(ctx) {
  if (!ctx) return {};
  const trip = state.trips.find((t) => t.id === ctx.tripId);
  const day = trip?.days.find((d) => d.id === ctx.dayId);
  const route = day?.routes.find((r) => r.id === ctx.routeId);
  return { trip, day, route };
}

function setActiveContext(ctx) {
  state.activeContext = ctx || null;
  const chip = $('loadedRouteChip');
  const crumb = $('loadedRouteBreadcrumb');
  const saveBtn = $('saveBtn');
  const { trip, day, route } = findContext(ctx);
  if (route && trip && day) {
    crumb.innerHTML = `
      <span class="crumb-trip">${escapeHTML(trip.name)}</span>
      <span class="crumb-sep">›</span>
      <span class="crumb-day">${formatDayDate(day.date)}</span>
      <span class="crumb-sep">›</span>
      <span class="crumb-route">${escapeHTML(route.name)}</span>`;
    chip.hidden = false;
    saveBtn.innerHTML = '<span>💾</span> Update';
    saveBtn.title = `Save changes to "${route.name}"`;
  } else {
    chip.hidden = true;
    saveBtn.innerHTML = '<span>💾</span> Save';
    saveBtn.title = 'Save this route into a trip';
  }
}

function formatDayDate(iso) {
  // iso: YYYY-MM-DD
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function makeRoutePayload(name) {
  return {
    id: makeId('route'),
    name,
    savedAt: new Date().toISOString(),
    waypoints: state.waypoints.map((w) => ({
      name: w.name,
      latlng: w.latlng,
      kind: w.kind,
      customName: !!w.customName,
    })),
    segmentModes: [...state.segmentModes],
    units: state.units,
  };
}

function updateRouteInPlace(route) {
  route.savedAt = new Date().toISOString();
  route.waypoints = state.waypoints.map((w) => ({
    name: w.name,
    latlng: w.latlng,
    kind: w.kind,
    customName: !!w.customName,
  }));
  route.segmentModes = [...state.segmentModes];
  route.units = state.units;
}

function saveCurrent() {
  // Editing an existing route in a trip → just update it.
  if (state.activeContext) {
    const { route } = findContext(state.activeContext);
    if (route) {
      updateRouteInPlace(route);
      persistTrips();
      toast(`Updated "${route.name}"`);
      return;
    }
    // Was deleted; fall through to the picker
    state.activeContext = null;
  }

  // Fresh route — needs a trip+day. Open the trips modal in "save target"
  // mode so the user picks where it goes.
  openTripsDialog({ saveTarget: true });
}

function defaultRouteName() {
  const first = state.waypoints[0]?.name?.split(',')[0] || 'Origin';
  const last =
    state.waypoints[state.waypoints.length - 1]?.name?.split(',')[0] ||
    'Destination';
  return `${first} → ${last}`;
}

function createTrip(name) {
  const trip = {
    id: makeId('trip'),
    name,
    createdAt: new Date().toISOString(),
    days: [],
  };
  state.trips.push(trip);
  persistTrips();
  return trip;
}

function addDayToTrip(tripId, date) {
  const trip = state.trips.find((t) => t.id === tripId);
  if (!trip) return null;
  if (trip.days.some((d) => d.date === date)) {
    toast('A day with that date already exists');
    return trip.days.find((d) => d.date === date);
  }
  const day = { id: makeId('day'), date, routes: [] };
  trip.days.push(day);
  trip.days.sort((a, b) => a.date.localeCompare(b.date));
  persistTrips();
  return day;
}

function deleteTrip(tripId) {
  const idx = state.trips.findIndex((t) => t.id === tripId);
  if (idx < 0) return;
  state.trips.splice(idx, 1);
  if (state.activeContext?.tripId === tripId) {
    setActiveContext(null);
  }
  persistTrips();
}

function deleteDay(tripId, dayId) {
  const trip = state.trips.find((t) => t.id === tripId);
  if (!trip) return;
  trip.days = trip.days.filter((d) => d.id !== dayId);
  if (state.activeContext?.dayId === dayId) setActiveContext(null);
  persistTrips();
}

function deleteRouteEntry(tripId, dayId, routeId) {
  const trip = state.trips.find((t) => t.id === tripId);
  const day = trip?.days.find((d) => d.id === dayId);
  if (!day) return;
  day.routes = day.routes.filter((r) => r.id !== routeId);
  if (state.activeContext?.routeId === routeId) setActiveContext(null);
  persistTrips();
}

function openRoute(tripId, dayId, routeId) {
  const trip = state.trips.find((t) => t.id === tripId);
  const day = trip?.days.find((d) => d.id === dayId);
  const route = day?.routes.find((r) => r.id === routeId);
  if (!route) return;
  state.waypoints = route.waypoints.map((w) => ({ ...w }));
  state.segmentModes = [...route.segmentModes];
  state.units = route.units || 'km';
  document.querySelectorAll('.unit').forEach((u) => {
    u.classList.toggle('active', u.dataset.unit === state.units);
  });
  setActiveContext({ tripId, dayId, routeId });
  renderPanel();
  refreshMap();
  fitToWaypoints();
  recomputeRoute();
  toast(`Opened "${route.name}"`);
}

function newRouteInDay(tripId, dayId, name) {
  const trip = state.trips.find((t) => t.id === tripId);
  const day = trip?.days.find((d) => d.id === dayId);
  if (!day) return;
  const route = {
    id: makeId('route'),
    name,
    savedAt: new Date().toISOString(),
    waypoints: [
      { name: '', latlng: null, kind: 'origin' },
      { name: '', latlng: null, kind: 'destination' },
    ],
    segmentModes: ['walk'],
    units: 'km',
  };
  day.routes.push(route);
  persistTrips();
  openRoute(tripId, dayId, route.id);
}

async function saveCurrentInto(tripId, dayId) {
  const name = await askInput({
    title: 'Name this route',
    defaultValue: defaultRouteName(),
    placeholder: 'e.g. Morning walk',
    confirmText: 'Save',
  });
  if (!name) return;
  const trip = state.trips.find((t) => t.id === tripId);
  const day = trip?.days.find((d) => d.id === dayId);
  if (!day) return;
  const payload = makeRoutePayload(name);
  day.routes.push(payload);
  persistTrips();
  setActiveContext({ tripId, dayId, routeId: payload.id });
  toast(`Saved into ${trip.name} › ${formatDayDate(day.date)}`);
}

// ---------------- TRIPS MODAL ----------------
function openTripsDialog(opts = {}) {
  const modal = $('tripsModal');
  modal.hidden = false;
  modal.dataset.mode = opts.saveTarget ? 'save' : 'browse';
  renderTripsBody();
}

function closeTripsDialog() {
  $('tripsModal').hidden = true;
}

function renderTripsBody() {
  const body = $('tripsBody');
  const isSaveMode = $('tripsModal').dataset.mode === 'save';

  if (isSaveMode) {
    const banner = `<div class="trips-banner">Pick a day to save the current route into.</div>`;
    body.innerHTML = banner + renderTripsTree(true);
  } else {
    body.innerHTML = renderTripsTree(false);
  }

  bindTripsEvents();
}

function renderTripsTree(saveMode) {
  if (!state.trips.length) {
    return `<div class="trips-empty">No trips yet. Click <strong>+ New trip</strong> below to get started.</div>`;
  }
  return state.trips
    .map((trip) => {
      const daysHtml = trip.days.length
        ? trip.days
            .map((day) => {
              const routesHtml = day.routes.length
                ? day.routes
                    .map((r) => {
                      const isActive =
                        state.activeContext?.routeId === r.id ? 'active' : '';
                      return `
                <div class="trip-route ${isActive}" data-trip="${trip.id}" data-day="${day.id}" data-route="${r.id}">
                  <span class="trip-route-icon">📍</span>
                  <div class="trip-route-body">
                    <div class="trip-route-name">${escapeHTML(r.name)}</div>
                    <div class="trip-route-meta">${r.waypoints.length} pts · saved ${new Date(r.savedAt).toLocaleDateString()}</div>
                  </div>
                  <button class="trip-route-delete" data-trip="${trip.id}" data-day="${day.id}" data-route="${r.id}" title="Delete route">🗑</button>
                </div>`;
                    })
                    .join('')
                : '<div class="trip-empty-routes">No routes yet for this day.</div>';

              const saveBtn = saveMode
                ? `<button class="trip-save-here" data-trip="${trip.id}" data-day="${day.id}">💾 Save here</button>`
                : `<button class="trip-new-route" data-trip="${trip.id}" data-day="${day.id}">+ New route</button>`;

              return `
            <div class="trip-day" data-day="${day.id}">
              <div class="trip-day-header">
                <span class="trip-day-icon">📅</span>
                <span class="trip-day-date">${formatDayDate(day.date)}</span>
                ${saveBtn}
                <button class="trip-day-delete" data-trip="${trip.id}" data-day="${day.id}" title="Delete day">×</button>
              </div>
              <div class="trip-day-routes">${routesHtml}</div>
            </div>`;
            })
            .join('')
        : '<div class="trip-empty-days">No days yet. Add one below.</div>';

      return `
      <div class="trip-card" data-trip="${trip.id}">
        <div class="trip-card-header">
          <span class="trip-card-icon">✈️</span>
          <span class="trip-card-name">${escapeHTML(trip.name)}</span>
          <button class="trip-add-day" data-trip="${trip.id}">+ Add day</button>
          <button class="trip-delete" data-trip="${trip.id}" title="Delete trip">🗑</button>
        </div>
        <div class="trip-days-list">${daysHtml}</div>
      </div>`;
    })
    .join('');
}

function bindTripsEvents() {
  // Open existing route
  document.querySelectorAll('.trip-route').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.trip-route-delete')) return;
      openRoute(el.dataset.trip, el.dataset.day, el.dataset.route);
      closeTripsDialog();
    });
  });
  // Save current into a day (save-mode only)
  document.querySelectorAll('.trip-save-here').forEach((btn) => {
    btn.addEventListener('click', () => {
      saveCurrentInto(btn.dataset.trip, btn.dataset.day);
      closeTripsDialog();
    });
  });
  // New empty route inside a day
  document.querySelectorAll('.trip-new-route').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const name = await askInput({
        title: 'Name this route',
        defaultValue: 'New route',
        placeholder: 'e.g. Morning walk',
        confirmText: 'Create',
      });
      if (!name) return;
      newRouteInDay(btn.dataset.trip, btn.dataset.day, name);
      closeTripsDialog();
    });
  });
  // Add a day to a trip — uses a real date picker
  document.querySelectorAll('.trip-add-day').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const date = await askInput({
        title: 'Pick a date',
        defaultValue: today,
        type: 'date',
        confirmText: 'Add day',
      });
      if (!date) return;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        toast('Please pick a valid date');
        return;
      }
      addDayToTrip(btn.dataset.trip, date);
      renderTripsBody();
    });
  });
  // Delete a trip
  document.querySelectorAll('.trip-delete').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const trip = state.trips.find((t) => t.id === btn.dataset.trip);
      if (!trip) return;
      const ok = await askConfirm({
        title: 'Delete trip?',
        message: `"${trip.name}" and all its days and routes will be permanently removed.`,
        confirmText: 'Delete',
        danger: true,
      });
      if (!ok) return;
      deleteTrip(btn.dataset.trip);
      renderTripsBody();
    });
  });
  // Delete a day
  document.querySelectorAll('.trip-day-delete').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await askConfirm({
        title: 'Delete this day?',
        message: 'All routes for this day will be deleted.',
        confirmText: 'Delete',
        danger: true,
      });
      if (!ok) return;
      deleteDay(btn.dataset.trip, btn.dataset.day);
      renderTripsBody();
    });
  });
  // Delete a route
  document.querySelectorAll('.trip-route-delete').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await askConfirm({
        title: 'Delete this route?',
        confirmText: 'Delete',
        danger: true,
      });
      if (!ok) return;
      deleteRouteEntry(btn.dataset.trip, btn.dataset.day, btn.dataset.route);
      renderTripsBody();
    });
  });
}

// ---------------- SHARE ----------------
function encodeState() {
  const payload = {
    w: state.waypoints.map((w) => [w.name, w.latlng]),
    m: state.segmentModes,
    u: state.units,
  };
  return btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
}

function decodeState(s) {
  try {
    const p = JSON.parse(decodeURIComponent(escape(atob(s))));
    state.waypoints = p.w.map(([name, latlng], i) => ({
      name: name || '',
      latlng: latlng || null,
      kind:
        i === 0
          ? 'origin'
          : i === p.w.length - 1
          ? 'destination'
          : 'stop',
    }));
    state.segmentModes = p.m;
    state.units = p.u || 'km';
    document.querySelectorAll('.unit').forEach((u) => {
      u.classList.toggle('active', u.dataset.unit === state.units);
    });
    renderPanel();
    refreshMap();
    fitToWaypoints();
    recomputeRoute();
    return true;
  } catch (e) {
    console.warn('Invalid shared state', e);
    return false;
  }
}

async function shareCurrent() {
  const enc = encodeState();
  const url = `${location.origin}${location.pathname}#r=${enc}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Share link copied to clipboard');
  } catch {
    // Clipboard blocked (older browser / non-secure context) — show the URL
    // in our own dialog so the user can copy it manually.
    await showCopyDialog({ title: 'Share link', value: url });
    toast('Press ⌘C to copy the selected link');
  }
}

// ---------------- PLAY ----------------
function fullPath() {
  const pts = [];
  state.segments.forEach((s) => {
    if (!s) return;
    s.coords.forEach((c) => pts.push(c));
  });
  return pts;
}

function stopPlay() {
  if (playAnimHandle) {
    cancelAnimationFrame(playAnimHandle);
    playAnimHandle = null;
  }
  if (playMarker) {
    markersLayer.removeLayer(playMarker);
    playMarker = null;
  }
}

function playRoute() {
  stopPlay();
  const path = fullPath();
  if (path.length < 2) {
    toast('Add at least two located waypoints first');
    return;
  }
  // Pre-compute cumulative distances
  const cum = [0];
  for (let i = 1; i < path.length; i++) {
    cum.push(cum[i - 1] + haversine(path[i - 1], path[i]));
  }
  const total = cum[cum.length - 1];
  if (total === 0) return;

  // Animation: ~8s total, regardless of length (cap)
  const durationMs = Math.min(12000, Math.max(4000, total * 2));
  const start = performance.now();

  const icon = L.divIcon({
    className: '',
    html: '<div class="play-marker"></div>',
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
  playMarker = L.marker(path[0], { icon }).addTo(markersLayer);

  function step(now) {
    const t = Math.min(1, (now - start) / durationMs);
    const targetDist = total * t;
    // binary search
    let lo = 0,
      hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < targetDist) lo = mid + 1;
      else hi = mid;
    }
    const i = Math.max(1, lo);
    const segStart = cum[i - 1];
    const segLen = cum[i] - segStart || 1;
    const frac = (targetDist - segStart) / segLen;
    const a = path[i - 1];
    const b = path[i];
    const lat = a[0] + (b[0] - a[0]) * frac;
    const lng = a[1] + (b[1] - a[1]) * frac;
    playMarker.setLatLng([lat, lng]);
    map.panTo([lat, lng], { animate: true, duration: 0.2 });
    if (t < 1) {
      playAnimHandle = requestAnimationFrame(step);
    } else {
      // leave the marker at the end briefly, then clear
      setTimeout(stopPlay, 1200);
    }
  }
  playAnimHandle = requestAnimationFrame(step);
}

// ---------------- JUMP TO LOCATION ----------------
const onJumpInput = debounce(async (e) => {
  const q = e.target.value.trim();
  const box = $('jumpSuggestions');
  if (!q) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  const results = await geocode(q);
  if (!results.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.innerHTML = results
    .map(
      (r) =>
        `<div class="suggestion" data-lat="${r.lat}" data-lon="${
          r.lon
        }">${escapeHTML(r.display_name)}</div>`
    )
    .join('');
  box.querySelectorAll('.suggestion').forEach((sug) => {
    sug.addEventListener('click', () => {
      map.setView([+sug.dataset.lat, +sug.dataset.lon], 15);
      box.hidden = true;
      $('jumpInput').value = '';
    });
  });
}, 350);

// ---------------- MAP CLICK: place waypoint ----------------
map.on('click', async (e) => {
  // Find first empty waypoint, else add a stop before destination
  let idx = state.waypoints.findIndex((w) => !w.latlng);
  if (idx === -1) {
    // insert a new stop before destination
    const lastIdx = state.waypoints.length - 1;
    state.waypoints.splice(lastIdx, 0, {
      name: '',
      latlng: null,
      kind: 'stop',
    });
    state.segmentModes.splice(lastIdx, 0, state.segmentModes[lastIdx - 1] || 'walk');
    idx = lastIdx;
  }
  const latlng = [e.latlng.lat, e.latlng.lng];
  state.waypoints[idx].latlng = latlng;
  state.waypoints[idx].name = `${latlng[0].toFixed(5)}, ${latlng[1].toFixed(5)}`;
  renderPanel();
  refreshMap();
  recomputeRoute();
  reverseGeocode(latlng[0], latlng[1]).then((r) => {
    if (r?.display_name && !state.waypoints[idx].customName) {
      state.waypoints[idx].name = r.display_name;
      renderPanel();
      refreshMap();
    }
  });
});

// ---------------- UI WIRING ----------------
function init() {
  // Hydrate trips from storage and bring legacy saves over if needed.
  state.trips = loadTrips();
  migrateLegacyRoutes();
  setActiveContext(null);

  // Render initial panel
  renderPanel();

  // Buttons
  $('clearBtn').addEventListener('click', async () => {
    const ok = await askConfirm({
      title: 'Clear the current route?',
      message: 'All waypoints and modes will be reset.',
      confirmText: 'Clear',
      danger: true,
    });
    if (ok) clearAll();
  });
  $('minimizeBtn').addEventListener('click', () => {
    state.panelMinimized = !state.panelMinimized;
    $('panel').classList.toggle('minimized', state.panelMinimized);
    $('minimizeBtn').textContent = state.panelMinimized ? '+' : '−';
  });
  $('saveBtn').addEventListener('click', saveCurrent);
  $('tripsBtn').addEventListener('click', () => openTripsDialog());
  $('tripsCloseBtn').addEventListener('click', closeTripsDialog);
  $('tripsModal').addEventListener('click', (e) => {
    if (e.target.id === 'tripsModal') closeTripsDialog();
  });
  // Custom dialog buttons
  $('appDialogConfirm').addEventListener('click', async () => {
    const input = $('appDialogInput');
    if (!input.hidden && input.readOnly) {
      // Copy dialog — try to copy to clipboard
      try {
        await navigator.clipboard.writeText(input.value);
        toast('Copied to clipboard');
      } catch {
        input.select();
        document.execCommand?.('copy');
      }
      _closeDialog(true);
      return;
    }
    if (!input.hidden) {
      _closeDialog(input.value.trim() || null);
    } else {
      _closeDialog(true);
    }
  });
  $('appDialogCancel').addEventListener('click', () => {
    const input = $('appDialogInput');
    if (!input.hidden && !input.readOnly) {
      _closeDialog(null);
    } else {
      _closeDialog(false);
    }
  });
  $('appDialog').addEventListener('click', (e) => {
    if (e.target.id === 'appDialog') {
      const input = $('appDialogInput');
      if (!input.hidden && !input.readOnly) _closeDialog(null);
      else _closeDialog(false);
    }
  });

  $('newTripBtn').addEventListener('click', async () => {
    const name = await askInput({
      title: 'New trip',
      placeholder: 'e.g. USA, Japan, road trip…',
      defaultValue: '',
      confirmText: 'Create',
    });
    if (!name) return;
    createTrip(name);
    renderTripsBody();
  });
  $('shareBtn').addEventListener('click', shareCurrent);
  $('playBtn').addEventListener('click', playRoute);
  $('optimizeBtn').addEventListener('click', optimizeOrder);
  $('discoverToggle').addEventListener('click', toggleDiscover);

  // Distance unit toggle
  document.querySelectorAll('.unit').forEach((u) => {
    u.addEventListener('click', () => {
      document
        .querySelectorAll('.unit')
        .forEach((el) => el.classList.remove('active'));
      u.classList.add('active');
      state.units = u.dataset.unit;
      renderDistance();
      renderRouteInfo();
    });
  });

  // Route info toggle
  $('routeInfoToggle').addEventListener('click', () => {
    state.showInfo = !state.showInfo;
    renderRouteInfo();
  });

  // Theme toggle
  $('themeBtn').addEventListener('click', () => {
    applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
  });

  // Jump input
  $('jumpInput').addEventListener('input', onJumpInput);
  $('jumpInput').addEventListener('blur', () =>
    setTimeout(() => ($('jumpSuggestions').hidden = true), 200)
  );

  // Try to load shared route from URL hash
  const hash = location.hash;
  if (hash.startsWith('#r=')) {
    if (decodeState(hash.slice(3))) {
      toast('Loaded shared route');
    }
  }
}

init();

// ---------------- SERVICE WORKER (PWA) ----------------
// Register the service worker so the app can be installed as a PWA and
// works offline. Only runs on http(s) — service workers don't register
// from file:// URLs, which is fine because we want users on a local
// server or hosted environment anyway.
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('sw.js')
      .catch((err) => console.warn('[SW] registration failed', err));
  });
}
