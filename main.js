(function () {
  // --- Config ---
  const FEED_URL = "https://ttc-gtfsrt.onrender.com/vehicles"; // Server endpoint that returns decoded GTFS-RT JSON
  const POLL_MS = 10_000;

  // GitHub repository for processed GTFS data
  // Update this with your GitHub username/repository
  const GITHUB_REPO = "LookArail/ttc_gtfsrt"; // e.g., "username/gtfs-processed-data"
  const GITHUB_BRANCH = "main";
  const GTFS_DATA_BASE_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/data`;

  // We'll render timestamps using the Toronto time zone *name* (no fixed offset),
  // which avoids hard-coding offsets and respects DST automatically.
  const TORONTO_TZ = "America/Toronto";

  // GTFS Static Data (loaded from GitHub processed files)
  let gtfsData = {
    routes: {},
    trips: {},
    stops: {},
    shapes: {},
    shapeRouteMap: {}, // shape_id -> route_id
    metadata: null,  // Contains stop_times_files mapping (route_id -> filename)
    stopTimesByRoute: {},  // Loaded on-demand: route_id -> { trip_id -> array of stop_time records }
    isLoaded: false
  };
  
  // Stop times data (loaded selectively on-demand)
  // Field mappings: sid=stop_id, seq=stop_sequence, arr=arrival_time, dep=departure_time
  //                 hs=stop_headsign, pu=pickup_type, do=drop_off_type
  let stopTimes = [];  // Array of stop_time records for currently filtered trips

  // Leaflet layer for static shapes and stops
  let shapesLayer = null;
  let stopsLayer = null;
  
  // Map to track shape polylines by route_id for highlighting
  const shapesByRouteId = new Map(); // route_id -> [polyline, polyline, ...]
  let highlightedShapes = []; // currently highlighted shapes

  // Cache: vehicle_id -> { tripId, routeId, tripData, routeData }
  // Reused across RT feed updates so we don't re-link every vehicle every poll.
  const staticLinkCache = new Map();
  
  // Bus icon size configuration - customize these values
  const BUS_ICON_CONFIG = {
    baseSize: 32,        // base icon size in pixels at zoom level 14
    referenceZoom: 14,   // reference zoom level
    scaleFactor: 1.5     // how much size changes per zoom level (higher = more dramatic scaling)
  };

  // Active filter state. null means "no filter / show all".
  let activeFilter = { routeTypes: null, routeIds: null };

  // Human-readable labels for GTFS route_type codes
  const ROUTE_TYPE_LABELS = {
    0: 'Tram / Streetcar / Light rail',
    1: 'Subway / Metro',
    2: 'Rail',
    3: 'Bus',
    4: 'Ferry',
    11: 'Trolleybus',
    12: 'Monorail'
  };

  // ---------------------------------------------------------------------------
  // DOM elements and UI helpers (must be declared before loadGTFSData)
  // ---------------------------------------------------------------------------
  
  // Status UI helpers
  const statusEl = document.getElementById('status');
  const statusTextEl = document.getElementById('statusText');
  function setStatus(text, mode) {
    statusTextEl.textContent = text;
    statusEl.classList.remove('error', 'stale');
    if (mode === 'error') statusEl.classList.add('error');
    if (mode === 'stale') statusEl.classList.add('stale');
  }

  // ---------------------------------------------------------------------------
  // Load GTFS Static Data from GitHub processed files
  // ---------------------------------------------------------------------------
  
  async function loadGTFSData() {
    try {
      setStatus('Loading GTFS data...', null);
      
      // Load all core files in parallel (except stop-times which load on-demand)
      const [routes, trips, stops, shapes, shapeRouteMap, metadata] = await Promise.all([
        fetch(`${GTFS_DATA_BASE_URL}/routes.json`).then(r => r.json()),
        fetch(`${GTFS_DATA_BASE_URL}/trips.json`).then(r => r.json()),
        fetch(`${GTFS_DATA_BASE_URL}/stops.json`).then(r => r.json()),
        fetch(`${GTFS_DATA_BASE_URL}/shapes.json`).then(r => r.json()),
        fetch(`${GTFS_DATA_BASE_URL}/shape-route-map.json`).then(r => r.json()),
        fetch(`${GTFS_DATA_BASE_URL}/metadata.json`).then(r => r.json())
      ]);
      
      gtfsData.routes = routes;
      gtfsData.trips = trips;
      gtfsData.stops = stops;
      gtfsData.shapes = shapes;
      gtfsData.shapeRouteMap = shapeRouteMap;
      gtfsData.metadata = metadata;
      gtfsData.isLoaded = true;
      
      console.log('GTFS static data loaded successfully');
      console.log(`  Routes: ${Object.keys(routes).length}`);
      console.log(`  Trips: ${Object.keys(trips).length}`);
      console.log(`  Stops: ${Object.keys(stops).length}`);
      console.log(`  Shapes: ${Object.keys(shapes).length}`);
      console.log(`  Stop-times files available: ${metadata.stats.stop_times_route_files} (loaded on-demand)`);
      
      setStatus('GTFS data loaded', null);
      
      // Clear cache so all vehicles re-link to static data on next poll
      staticLinkCache.clear();
      populateFilterPanel();
      
      // Plot shapes with filtering support (now that we have shape-route-map)
      plotShapes();
      
      // Fetch vehicles to enrich with static data
      fetchVehicles();
      
    } catch (error) {
      console.error('Failed to load GTFS data:', error);
      setStatus('Failed to load GTFS data', 'error');
    }
  }
  
  // Start loading GTFS data immediately
  loadGTFSData();

  // ---------------------------------------------------------------------------
  // Shape plotting
  // Colors match the other GTFS project: route_color if set, else type defaults
  // ---------------------------------------------------------------------------
  const ROUTE_TYPE_DEFAULT_COLORS = {
    0: '#e74c3c',  // Tram / Streetcar
    1: '#3498db',  // Subway / Metro
    2: '#2c3e50',  // Rail
    3: '#e67e22',  // Bus
    4: '#1abc9c',  // Ferry
    11: '#9b59b6', // Trolleybus
    12: '#f39c12'  // Monorail
  };

  /**
   * Plot shapes with filtering support
   * Uses pre-computed shape-route-map from GitHub Actions
   */
  function plotShapes() {
    if (shapesLayer) {
      map.removeLayer(shapesLayer);
      shapesLayer = null;
    }
    shapesLayer = L.layerGroup();
    shapesByRouteId.clear();
    highlightedShapes = [];

    const shapes       = gtfsData.shapes;       // shape_id -> [{lat,lon,sequence}]
    const shapeRouteMap = gtfsData.shapeRouteMap; // shape_id -> route_id
    const routes       = gtfsData.routes;        // route_id -> route

    let shapesPlotted = 0;
    let colorsUsed = { fromRouteColor: 0, fromRouteType: 0, fallback: 0 };

    for (const shapeId in shapes) {
      const points = shapes[shapeId];
      if (!points || points.length < 2) continue;

      const routeId = shapeRouteMap[shapeId];
      const route   = routeId ? routes[routeId] : null;

      // Apply filter FIRST - skip shapes that don't match filter
      if (!passesFilter(routeId)) continue;

      let color  = '#888888';
      let weight = 2;
      let opacity = 0.55;

      if (route) {
        // Use route_color from GTFS if present (strip leading # in case)
        // Check for non-empty string explicitly
        if (route.route_color && route.route_color.length > 0) {
          color = route.route_color.startsWith('#')
            ? route.route_color
            : `#${route.route_color}`;
          colorsUsed.fromRouteColor++;
        } else {
          color = ROUTE_TYPE_DEFAULT_COLORS[route.route_type] || '#888888';
          colorsUsed.fromRouteType++;
        }
        // Streetcar / tram lines drawn slightly thicker
        if (route.route_type === 0) { weight = 3; opacity = 0.65; }
      } else {
        colorsUsed.fallback++;
      }

      shapesPlotted++;

      const polyline = L.polyline(
        points.map(p => [p.lat, p.lon]),
        { color, weight, opacity, interactive: false }
      );
      
      // Store original style for later restoration
      polyline._originalStyle = { color, weight, opacity };
      polyline._routeId = routeId;
      
      polyline.addTo(shapesLayer);
      
      // Track shapes by route_id for highlighting
      if (routeId) {
        if (!shapesByRouteId.has(routeId)) shapesByRouteId.set(routeId, []);
        shapesByRouteId.get(routeId).push(polyline);
      }
    }

    // Add shapes below vehicle markers (Leaflet pane order: tilePane < overlayPane)
    shapesLayer.addTo(map);
    // Ensure shapes stay behind vehicle markers by moving their SVG to the back
    shapesLayer.eachLayer(l => { if (l.bringToBack) l.bringToBack(); });
  }
  
  // Plot stops layer
  function plotStops() {
    if (stopsLayer) {
      map.removeLayer(stopsLayer);
      stopsLayer = null;
    }
    
    if (!gtfsData.stops || Object.keys(gtfsData.stops).length === 0) return;
    
    stopsLayer = L.layerGroup();
    
    const stops = gtfsData.stops;
    
    // Build set of stop_ids that are used by currently filtered trips
    const usedStopIds = new Set();
    for (const st of stopTimes) {
      if (st.sid) {  // 'sid' is the abbreviated field name for stop_id
        usedStopIds.add(st.sid);
      }
    }
    
    // If no stop_times loaded yet, don't show any stops
    if (usedStopIds.size === 0) {
      console.log('No stop_times loaded yet, skipping stops plot');
      return;
    }
    
    // Plot only stops that are used by filtered trips
    for (const stopId in stops) {
      if (!usedStopIds.has(stopId)) continue;
      
      const stop = stops[stopId];
      if (!stop.stop_lat || !stop.stop_lon) continue;
      
      const marker = L.circleMarker([stop.stop_lat, stop.stop_lon], {
        radius: 4,
        color: '#d32f2f',
        fillColor: '#ff5252',
        fillOpacity: 0.7,
        weight: 1
      }).bindTooltip(stop.stop_name || stopId, { sticky: true });
      
      marker.addTo(stopsLayer);
    }
    
    stopsLayer.addTo(map);
    console.log(`Plotted ${stopsLayer.getLayers().length} stops`);
  }
  
  // Highlight shapes for a specific route
  function highlightShapesByRouteId(routeId) {
    // First, unhighlight any previously highlighted shapes
    unhighlightAllShapes();
    
    if (!routeId || !shapesByRouteId.has(routeId)) return;
    
    const shapesToHighlight = shapesByRouteId.get(routeId);
    shapesToHighlight.forEach(polyline => {
      const original = polyline._originalStyle;
      polyline.setStyle({
        color: original.color,
        weight: original.weight + 3, // Make thicker
        opacity: Math.min(1, original.opacity + 0.3) // Make more opaque
      });
      polyline.bringToFront();
      highlightedShapes.push(polyline);
    });
  }
  
  // Remove highlighting from all shapes
  function unhighlightAllShapes() {
    highlightedShapes.forEach(polyline => {
      const original = polyline._originalStyle;
      if (original) {
        polyline.setStyle(original);
        polyline.bringToBack();
      }
    });
    highlightedShapes = [];
  }

  // ---------------------------------------------------------------------------
  // Filter helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns true if a vehicle/shape passes the active filter.
   * Vehicles with no static link (routeId === null) are excluded from display
   * when a filter is active.
   */
  function passesFilter(routeId) {
    // No route ID — if user has selected specific routes, exclude vehicles with no route ID
    const { routeIds } = activeFilter;
    if (routeId === null || routeId === undefined) {
      // If a filter is active, hide vehicles with no route ID
      return routeIds === null;
    }
    if (routeIds !== null && !routeIds.has(String(routeId))) return false;
    return true;
  }

  /** Populate both filter selects from loaded gtfsData. Called once after GTFS loads. */
  function populateFilterPanel() {
    const routes = gtfsData.routes;

    // ── Route Type ──
    const typeSet = new Set();
    for (const r of Object.values(routes)) typeSet.add(String(r.route_type));

    const typeSelect = document.getElementById('filterRouteType');
    typeSelect.innerHTML = '';
    for (const t of [...typeSet].sort((a, b) => Number(a) - Number(b))) {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = `${t} – ${ROUTE_TYPE_LABELS[Number(t)] || 'Unknown'}`;
      opt.selected = true; // all selected by default
      typeSelect.appendChild(opt);
    }

    // ── Route Name (cascade) ──
    repopulateRouteNames();
  }

  /** Repopulate the route name list based on currently selected route types. */
  function repopulateRouteNames() {
    const typeSelect = document.getElementById('filterRouteType');
    const nameSelect = document.getElementById('filterRouteName');
    const routes = gtfsData.routes;

    const selectedTypes = new Set([...typeSelect.selectedOptions].map(o => o.value));

    // Remember previously selected route IDs so we can keep them selected
    const prevSelected = new Set([...nameSelect.selectedOptions].map(o => o.value));

    nameSelect.innerHTML = '';

    const sorted = Object.entries(routes)
      .filter(([, r]) => selectedTypes.has(String(r.route_type)))
      .sort(([, a], [, b]) => {
        const an = Number(a.route_short_name);
        const bn = Number(b.route_short_name);
        if (!isNaN(an) && !isNaN(bn)) return an - bn;
        return (a.route_short_name || '').localeCompare(b.route_short_name || '');
      });

    for (const [routeId, r] of sorted) {
      const opt = document.createElement('option');
      opt.value = routeId;
      const sn = r.route_short_name || '';
      const ln = r.route_long_name  || '';
      opt.textContent = sn && ln ? `${sn} – ${ln}` : sn || ln || routeId;
      // Keep previously selected, or default to all if none were selected before
      opt.selected = prevSelected.size === 0 || prevSelected.has(routeId);
      nameSelect.appendChild(opt);
    }

    // If nothing ended up selected, select all (handles first-run)
    if (nameSelect.selectedOptions.length === 0) {
      for (const opt of nameSelect.options) opt.selected = true;
    }
  }

  /** Read the filter selects and apply filter to shapes + markers. */
  function applyFilter() {
    const typeSelect = document.getElementById('filterRouteType');
    const nameSelect = document.getElementById('filterRouteName');

    const selTypes    = [...typeSelect.selectedOptions].map(o => o.value);
    const selRouteIds = [...nameSelect.selectedOptions].map(o => o.value);

    // Only treat as "no filter" if BOTH types and routes are fully selected
    const allTypes  = selTypes.length  === typeSelect.options.length;
    const allRoutes = selRouteIds.length === nameSelect.options.length;

    activeFilter.routeTypes = allTypes  ? null : new Set(selTypes);
    // Only set routeIds to null if both type and route filters are unfiltered
    activeFilter.routeIds   = (allTypes && allRoutes) ? null : new Set(selRouteIds);

    // Re-plot shapes with new filter
    plotShapes();
    
    // Request new stop_times for the updated filter (unless too many routes)
    // Don't show stops if more than 10 routes are selected
    if (selRouteIds.length > 10) {
      console.log(`Too many routes selected (${selRouteIds.length}), skipping stop_times load`);
      stopTimes = []; // Clear stop_times
      plotStops();  // Will show nothing since stopTimes is empty
    } else {
      requestStopTimesForCurrentFilter();
    }

    // Show/hide existing vehicle markers
    for (const [id, m] of markers) {
      const vis = passesFilter(m._routeId);
      if (vis && !m._visible)  { 
        m.addTo(map); 
        m._visible = true;
      }
      else if (!vis && m._visible) { 
        m.closePopup(); 
        m.remove(); 
        m._visible = false;
      }
    }

    updateVehicleCount();
  }

  // ---------------------------------------------------------------------------
  // Map init (Toronto downtown)
  const map = L.map('map', {
    worldCopyJump: true
  }).setView([43.6532, -79.3832], 12);

  // OSM tiles
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  // Marker cache keyed by vehicle id
  const markers = new Map();

  // Utilities
  function toNumber(v, fallback = undefined) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function formatSpeedKmh(mps) {
    if (!Number.isFinite(mps)) return '—';
    const kmh = mps * 3.6;
    return `${kmh.toFixed(1)} km/h`;
  }

  function formatBearing(deg) {
    if (!Number.isFinite(deg)) return '—';
    return `${Math.round(deg)}°`;
  }

  function formatTimestamp(epochSeconds) {
    if (!Number.isFinite(epochSeconds)) return '—';
    const d = new Date(epochSeconds * 1000);
    // Format as local Toronto time without hard-coding offset
    return new Intl.DateTimeFormat(undefined, {
      timeZone: TORONTO_TZ,
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      year: 'numeric', month: 'short', day: '2-digit'
    }).format(d);
  }

  function ageSeconds(epochSeconds) {
    if (!Number.isFinite(epochSeconds)) return undefined;
    return (Date.now() / 1000) - epochSeconds;
    // Positive: how many seconds ago this update was
  }

  // Create a rotated bus icon marker with zoom-based sizing
  function createBusDivIcon(bearingDeg) {
    // Bearing: 0° = North (up), 90° = East (right), 180° = South (down), 270° = West (left)
    const rot = Number.isFinite(bearingDeg) ? bearingDeg : 0;
    
    // Calculate size based on current zoom level
    const currentZoom = map.getZoom();
    const zoomDiff = currentZoom - BUS_ICON_CONFIG.referenceZoom;
    const size = Math.round(BUS_ICON_CONFIG.baseSize * Math.pow(BUS_ICON_CONFIG.scaleFactor, zoomDiff / 3));
    const clampedSize = Math.max(16, Math.min(128, size)); // Clamp between 16px and 128px
    
    const img = document.createElement('img');
    img.src = 'bus icon.png';
    img.style.width = `${clampedSize}px`;
    img.style.height = `${clampedSize}px`;
    img.style.transform = `rotate(${rot}deg)`;
    img.style.transformOrigin = 'center';

    return L.divIcon({
      className: '', // prevent Leaflet from adding its default styles
      html: img.outerHTML,
      iconSize: [clampedSize, clampedSize],
      iconAnchor: [clampedSize / 2, clampedSize / 2] // center
    });
  }

  // ---------------------------------------------------------------------------
  // Static link cache helpers
  // ---------------------------------------------------------------------------
  /**
   * Request stop_times for trips matching the current filter
   */
  async function requestStopTimesForCurrentFilter() {
    if (!gtfsData.isLoaded || !gtfsData.metadata) return;
    
    const { routeIds } = activeFilter;
    const trips = gtfsData.trips;
    
    // Determine which routes we need to load
    const routesToLoad = new Set();
    for (const tripId in trips) {
      const trip = trips[tripId];
      if (passesFilter(trip.route_id)) {
        routesToLoad.add(trip.route_id);
      }
    }
    
    console.log(`Need stop_times for ${routesToLoad.size} routes`);
    
    // Load stop-times for routes that aren't already loaded
    const loadPromises = [];
    for (const routeId of routesToLoad) {
      if (!gtfsData.stopTimesByRoute[routeId]) {
        const filename = gtfsData.metadata.stop_times_files[routeId];
        if (filename) {
          const promise = fetch(`${GTFS_DATA_BASE_URL}/${filename}`)
            .then(r => r.json())
            .then(data => {
              gtfsData.stopTimesByRoute[routeId] = data;
              console.log(`✓ Loaded stop-times for route ${routeId}`);
            })
            .catch(err => {
              console.warn(`Failed to load stop-times for route ${routeId}:`, err);
            });
          loadPromises.push(promise);
        }
      }
    }
    
    // Wait for all loads to complete
    if (loadPromises.length > 0) {
      console.log(`Loading ${loadPromises.length} stop-times files...`);
      await Promise.all(loadPromises);
    }
    
    // Extract stop_times from the loaded route data
    stopTimes = [];
    for (const routeId of routesToLoad) {
      const routeStopTimes = gtfsData.stopTimesByRoute[routeId];
      if (routeStopTimes) {
        for (const tripId in routeStopTimes) {
          const trip = trips[tripId];
          if (trip && passesFilter(trip.route_id)) {
            stopTimes.push(...routeStopTimes[tripId]);
          }
        }
      }
    }
    
    console.log(`Loaded ${stopTimes.length} stop_time records from ${routesToLoad.size} routes`);
    
    // Plot stops immediately (shapes already plotted and remain visible)
    plotStops();
  }
  
  function getStaticLink(vehicleId, tripId, routeId) {
    const cached = staticLinkCache.get(vehicleId);
    // Reuse cached entry if trip_id and route_id are unchanged
    if (cached && cached.tripId === tripId && cached.routeId === routeId) {
      return cached;
    }
    // Build a fresh link and cache it
    const tripData  = (tripId  && gtfsData.trips[tripId])  ? gtfsData.trips[tripId]  : null;
    const resolvedRouteId = routeId || tripData?.route_id || null;
    const routeData = (resolvedRouteId && gtfsData.routes[resolvedRouteId])
      ? gtfsData.routes[resolvedRouteId]
      : null;
    const link = { tripId, routeId: resolvedRouteId, tripData, routeData };
    staticLinkCache.set(vehicleId, link);
    return link;
  }

  function upsertMarker(v) {
    const id = v?.vehicle?.vehicle?.id || v?.id || v?.vehicle?.id || v?.vehicle?.label;
    const pos = v?.vehicle?.position || v?.position || {};
    const lat = toNumber(pos.latitude);
    const lon = toNumber(pos.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !id) return;

    const bearing = toNumber(pos.bearing, 0);
    const speed = toNumber(pos.speed); // m/s if present
    const ts = toNumber(v?.vehicle?.timestamp || v?.timestamp);

    // Enrich with GTFS static data using cache
    // Note: RT feed uses camelCase (tripId, routeId), not snake_case (trip_id, route_id)
    const tripId  = v?.vehicle?.trip?.tripId  || v?.vehicle?.trip?.trip_id  || v?.trip?.tripId  || v?.trip?.trip_id  || null;
    const routeId = v?.vehicle?.trip?.routeId || v?.vehicle?.trip?.route_id || v?.trip?.routeId || v?.trip?.route_id || null;

    let routeShortName = '';
    let routeLongName  = '';
    let tripHeadsign   = '';
    let directionLabel = '';
    let link = null;

    // Always try to link if GTFS is loaded, OR if this is an existing marker
    // without valid static data yet (failsafe for race condition)
    const m = markers.get(id);
    const shouldLink = gtfsData.isLoaded || (m && m._routeType === null && tripId);

    if (shouldLink) {
      link = getStaticLink(id, tripId, routeId);
      if (link.routeData) {
        routeShortName = link.routeData.route_short_name || '';
        routeLongName  = link.routeData.route_long_name  || '';
      }
      if (link.tripData) {
        tripHeadsign   = link.tripData.trip_headsign || '';
        directionLabel = link.tripData.direction_id === 1 ? 'Inbound' : 'Outbound';
      }
    }

    const resolvedRouteId = link?.routeId || routeId || null;

    // Create marker if new, or reuse existing
    let marker = m;
    if (!marker) {
      marker = null; // Will be created below
    }

    const routeDisplay = routeShortName
      ? (routeLongName ? `${routeShortName} – ${routeLongName}` : routeShortName)
      : (routeLongName || routeId || '');

    const title = [
      routeDisplay ? `Route: ${routeDisplay}` : `Vehicle: ${id}`,
      tripHeadsign   ? `→ ${tripHeadsign}`    : '',
      directionLabel ? `Direction: ${directionLabel}` : '',
      `Speed: ${formatSpeedKmh(speed)}`,
      `Bearing: ${formatBearing(bearing)}`,
      `Updated: ${formatTimestamp(ts)}`
    ].filter(Boolean).join('\n');

    const popupHtml = `
      <table class="popup-table">
        <tr><td>Vehicle</td><td><b>${escapeHtml(id)}</b></td></tr>
        ${routeDisplay   ? `<tr><td>Route</td><td><b>${escapeHtml(routeDisplay)}</b></td></tr>` : ''}
        ${tripHeadsign   ? `<tr><td>Destination</td><td>${escapeHtml(tripHeadsign)}</td></tr>` : ''}
        ${directionLabel ? `<tr><td>Direction</td><td>${escapeHtml(directionLabel)}</td></tr>` : ''}
        ${tripId         ? `<tr><td>Trip ID</td><td>${escapeHtml(tripId)}</td></tr>` : ''}
        <tr><td>Speed</td><td>${formatSpeedKmh(speed)}</td></tr>
        <tr><td>Bearing</td><td>${formatBearing(bearing)}</td></tr>
        <tr><td>Last update</td><td>${formatTimestamp(ts)}</td></tr>
      </table>
    `;

    if (!marker) {
      marker = L.marker([lat, lon], {
        icon: createBusDivIcon(bearing),

        title
      });
      marker.bindPopup(popupHtml);
      // Console-log static GTFS info and highlight shapes when user clicks the marker
      marker.on('click', (e) => {
        // Prevent map click event from unhighlighting  
        L.DomEvent.stopPropagation(e);
        
        const cached = staticLinkCache.get(id);
        const raw    = marker._rtEntity;
        const rawTripId  = raw?.vehicle?.trip?.tripId  || raw?.vehicle?.trip?.trip_id  || raw?.trip?.tripId  || raw?.trip?.trip_id  || null;
        const rawRouteId = raw?.vehicle?.trip?.routeId || raw?.vehicle?.trip?.route_id || raw?.trip?.routeId || raw?.trip?.route_id || null;
        console.groupCollapsed(`%c[GTFS] Vehicle ${id}`, 'color:#1976d2;font-weight:bold');
        console.log('── RT feed values ──────────────────────────');
        console.log('  raw trip_id :', rawTripId);
        console.log('  raw route_id:', rawRouteId);
        console.log('── Static lookup results ───────────────────');
        console.log('  trips[trip_id]   :', gtfsData.trips[rawTripId]   ?? '(no match)');
        console.log('  routes[route_id] :', gtfsData.routes[rawRouteId] ?? '(no match)');
        console.log('── Cache entry ─────────────────────────────');
        console.log('  staticLinkCache  :', cached ?? '(not cached)');
        console.log('── Sample static keys (first 5) ────────────');
        console.log('  gtfsData.trips  keys:', Object.keys(gtfsData.trips).slice(0, 5));
        console.log('  gtfsData.routes keys:', Object.keys(gtfsData.routes).slice(0, 5));
        console.groupEnd();
        
        // Highlight the route's shapes
        if (marker._routeId) {
          highlightShapesByRouteId(marker._routeId);
        }
      });
      marker._visible = false;
      markers.set(id, marker);
    } else {
      // Update position
      marker.setLatLng([lat, lon]);
      // Update icon to rotate arrow
      marker.setIcon(createBusDivIcon(bearing));
      // Update title + DOM title attribute (Leaflet doesn't sync these automatically)
      marker.options.title = title;
      const iconEl = marker.getElement();
      if (iconEl) iconEl.title = title;
      // Always refresh popup so route/trip info is current after GTFS loads
      marker.setPopupContent(popupHtml);
    }

    // Store route metadata + raw RT entity on marker for filter checks and debugging
    marker._rtEntity  = v;
    marker._routeId   = resolvedRouteId;
    marker._routeType = link && link.routeData ? toNumber(link.routeData.route_type) : null;
    marker._bearing   = bearing; // Store bearing for icon recreation on zoom

    // Show or hide based on active filter (use explicit _visible flag, not Leaflet internals)
    const visible = passesFilter(marker._routeId);
    if (visible && !marker._visible)  { 
      marker.addTo(map); 
      marker._visible = true;
    }
    else if (!visible && marker._visible) { 
      marker.closePopup(); 
      marker.remove(); 
      marker._visible = false;
    }
  }

  function pruneMarkers(existingIds) {
    // Remove markers and static link cache entries that are no longer in the feed
    for (const [id, m] of markers) {
      if (!existingIds.has(id)) {
        m.closePopup();
        m.remove();
        m._visible = false;
        markers.delete(id);
        staticLinkCache.delete(id);
      }
    }
    updateVehicleCount();
  }

  function updateVehicleCount() {
    const el = document.getElementById('vehicleCount');
    if (!el) return;
    let visible = 0;
    for (const m of markers.values()) if (m._visible) visible++;
    el.textContent = `${visible} vehicle${visible !== 1 ? 's' : ''} active`;
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  async function fetchVehicles() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000); // 10s timeout
    try {
      setStatus('Updating…', null);
      const resp = await fetch(FEED_URL, { signal: controller.signal, cache: 'no-store' });
      clearTimeout(timeout); // Clear timeout on successful fetch
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      
      // Server returns decoded JSON from protobuf
      const data = await resp.json();
      const entities = Array.isArray(data?.entity) ? data.entity : (Array.isArray(data) ? data : []);

      const seen = new Set();
      for (const e of entities) {
        // guard per-entity
        try {
          upsertMarker(e);
          const id =
            e?.vehicle?.vehicle?.id || e?.id || e?.vehicle?.id || e?.vehicle?.label;
          if (id) seen.add(id);
        } catch (err) {
          // skip malformed
          console.debug('Entity parse skipped', err);
        }
      }
      // Keep last positions on failure is enabled; on success, prune missing
      pruneMarkers(seen);      

      // Determine staleness from max vehicle timestamp (if present)
      let newestTs = undefined;
      for (const e of entities) {
        const ts = toNumber(e?.vehicle?.timestamp || e?.timestamp);
        if (Number.isFinite(ts)) {
          newestTs = Math.max(newestTs ?? ts, ts);
        }
      }
      if (Number.isFinite(newestTs)) {
        const age = ageSeconds(newestTs);
        if (age != null && age > 60) {
          setStatus(`Updated (feed age ${Math.round(age)}s)`, 'stale');
        } else {
          setStatus('Updated', null);
        }
      } else {
        setStatus('Updated (no timestamps)', 'stale');
      }
    } catch (err) {
      console.warn('Fetch error:', err);
      // Keep last positions; show non-blocking error status
      setStatus('Network error – showing last positions', 'error');
    } finally {
      clearTimeout(timeout);
    }
  }

  // Initial fetch and schedule polling
  fetchVehicles();
  setInterval(fetchVehicles, POLL_MS);

  // ---------------------------------------------------------------------------
  // Filter panel event wiring
  // ---------------------------------------------------------------------------
  const applyFilterBtn = document.getElementById('applyFilterBtn');
  const selAllType     = document.getElementById('selectAllRouteType');
  const selAllName     = document.getElementById('selectAllRouteName');
  const filterRouteType = document.getElementById('filterRouteType');
  const filterRouteName = document.getElementById('filterRouteName');

  // Select All buttons
  selAllType.addEventListener('click', () => {
    for (const o of filterRouteType.options) o.selected = true;
    repopulateRouteNames();
  });
  selAllName.addEventListener('click', () => {
    for (const o of filterRouteName.options) o.selected = true;
  });

  // Cascade: changing route type repopulates route name list
  filterRouteType.addEventListener('change', () => repopulateRouteNames());

  // Apply button
  applyFilterBtn.addEventListener('click', applyFilter);
  
  // ---------------------------------------------------------------------------
  // Zoom event: update all marker icon sizes when zoom changes
  // ---------------------------------------------------------------------------
  map.on('zoomend', () => {
    for (const [, marker] of markers) {
      if (marker._visible) {
        // Get current bearing and recreate icon with new size
        const bearing = marker._bearing || 0;
        marker.setIcon(createBusDivIcon(bearing));
      }
    }
  });
  
  // ---------------------------------------------------------------------------
  // Map click: unhighlight shapes when clicking on empty map area
  // ---------------------------------------------------------------------------
  map.on('click', (e) => {
    // Only unhighlight if clicking on the map itself, not on a marker
    if (!e.originalEvent.defaultPrevented) {
      unhighlightAllShapes();
    }
  });
  
  // ---------------------------------------------------------------------------
  // RT Data Recorder: Collect trip update data for performance analysis
  // ---------------------------------------------------------------------------
  
  const TRIP_UPDATE_URL = "https://ttc-gtfsrt.onrender.com/trip-updates";
  const TRIP_UPDATE_INTERVAL_MS = 60_000; // 60 seconds
  
  // Recording state
  let isRecording = false;
  let recordingIntervalId = null;
  let recordedData = {}; // { tripId: { rid, stops: { stopSeq: { sid, seq, arr, sch_arr, sch_dep } } } }
  let selectedTripId = null;
  
  // Scheduled times cache and loading queue
  const seenTripIds = new Set(); // Track which trips we've already encountered
  const pendingRoutesToLoad = new Set(); // Routes that need stop_times loaded
  const scheduledTimesCache = {}; // { tripId: { stopSeq: { sch_arr, sch_dep } } }
  const loadingRoutes = new Set(); // Routes currently being loaded
  let totalRoutesQueued = 0; // Total unique routes ever queued
  
  // DOM elements
  const startRecordBtn = document.getElementById('startRecordBtn');
  const stopRecordBtn = document.getElementById('stopRecordBtn');
  const downloadRecordBtn = document.getElementById('downloadRecordBtn');
  const recorderStatus = document.getElementById('recorderStatus');
  const tripListEl = document.getElementById('tripList');
  const tripDetailsEl = document.getElementById('tripDetails');
  
  // Fetch trip updates from server
  async function fetchTripUpdates() {
    try {
      const resp = await fetch(TRIP_UPDATE_URL, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      return data;
    } catch (err) {
      console.warn('Failed to fetch trip updates:', err);
      return null;
    }
  }
  
  // Load and extract scheduled times for a route
  async function loadAndExtractScheduledTimes(routeId) {
    if (loadingRoutes.has(routeId)) return; // Already loading
    loadingRoutes.add(routeId);
    
    try {
      const filename = gtfsData.metadata.stop_times_files[routeId];
      if (!filename) {
        console.warn(`[RT Recorder] No stop_times file for route ${routeId}`);
        return;
      }
      
      console.log(`[RT Recorder] Loading scheduled times for route ${routeId}...`);
      const resp = await fetch(`${GTFS_DATA_BASE_URL}/${filename}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      
      const stopTimesData = await resp.json();
      
      // Extract into compact cache format
      let tripsExtracted = 0;
      for (const tripId in stopTimesData) {
        if (!scheduledTimesCache[tripId]) {
          scheduledTimesCache[tripId] = {};
        }
        for (const stop of stopTimesData[tripId]) {
          // Only store both if different, otherwise store just one
          const arr = stop.arr || null;
          const dep = stop.dep || null;
          scheduledTimesCache[tripId][stop.seq] = {
            sch_arr: arr || dep,
            sch_dep: (dep && dep !== arr) ? dep : null
          };
        }
        tripsExtracted++;
      }
      
      console.log(`[RT Recorder] ✓ Route ${routeId} loaded: ${tripsExtracted} trips, ${Object.keys(stopTimesData[Object.keys(stopTimesData)[0]] || []).length} stops avg`);
      
      // Pre-populate all scheduled stops for trips in recordedData that match this route
      for (const tripId in recordedData) {
        const trip = recordedData[tripId];
        if (trip.rid === routeId && scheduledTimesCache[tripId]) {
          // Populate all scheduled stops for this trip
          for (const stopSeq in scheduledTimesCache[tripId]) {
            const seq = parseInt(stopSeq);
            const scheduled = scheduledTimesCache[tripId][seq];
            
            // Only populate if not already recorded (don't overwrite RT data)
            if (!trip.stops[seq]) {
              // Get stop_id from the original stopTimesData
              const stopData = stopTimesData[tripId]?.find(s => s.seq === seq);
              if (stopData) {
                trip.stops[seq] = {
                  sid: stopData.sid,
                  seq: seq,
                  arr: null,  // No actual RT data yet
                  sch_arr: scheduled.sch_arr,
                  sch_dep: scheduled.sch_dep
                };
              }
            } else {
              // Merge scheduled times into existing entry (in case RT data came first)
              if (!trip.stops[seq].sch_arr) trip.stops[seq].sch_arr = scheduled.sch_arr;
              if (!trip.stops[seq].sch_dep) trip.stops[seq].sch_dep = scheduled.sch_dep;
            }
          }
        }
      }
      
      // Don't store in gtfsData.stopTimesByRoute - we only use scheduledTimesCache
      // This allows the large stopTimesData object to be garbage collected
    } catch (err) {
      console.warn(`[RT Recorder] Failed to load route ${routeId}:`, err);
    } finally {
      loadingRoutes.delete(routeId);
    }
  }
  
  // Process trip updates and record stop arrivals
  async function processTripUpdates(data) {
    if (!data || !data.entity) return;
    
    const now = Date.now();
    let newStopsRecorded = 0;
    
    // Phase 1: Identify new trips and queue routes for loading
    for (const entity of data.entity) {
      const tripUpdate = entity.tripUpdate || entity.trip_update;
      if (!tripUpdate) continue;
      
      const trip = tripUpdate.trip;
      const tripId = trip?.tripId || trip?.trip_id;
      const routeId = trip?.routeId || trip?.route_id;
      
      if (!tripId || !routeId) continue;
      
      // Check if this is a new trip
      if (!seenTripIds.has(tripId)) {
        seenTripIds.add(tripId);
        
        // Queue route for loading if not already loaded/loading/queued
        if (!scheduledTimesCache[tripId] && !loadingRoutes.has(routeId) && !pendingRoutesToLoad.has(routeId)) {
          pendingRoutesToLoad.add(routeId);
          totalRoutesQueued++;
        }
      }
    }
    
    // Phase 2: Load up to 30 routes from queue
    const routesToLoadNow = [...pendingRoutesToLoad].slice(0, 30);
    const loadPromises = routesToLoadNow.map(routeId => {
      pendingRoutesToLoad.delete(routeId);
      return loadAndExtractScheduledTimes(routeId);
    });
    await Promise.all(loadPromises);
    
    // Phase 3: Record stop arrivals with scheduled times
    for (const entity of data.entity) {
      const tripUpdate = entity.tripUpdate || entity.trip_update;
      if (!tripUpdate) continue;
      
      const trip = tripUpdate.trip;
      const tripId = trip?.tripId || trip?.trip_id;
      const routeId = trip?.routeId || trip?.route_id;
      const vehicleId = tripUpdate.vehicle?.id;
      const stopTimeUpdates = tripUpdate.stopTimeUpdate || tripUpdate.stop_time_update || [];
      
      if (!tripId) continue;
      
      // Get vehicle's current stop sequence from vehicle position feed
      let currentStopSeq = null;
      let vehicleFound = false;
      for (const [vId, marker] of markers) {
        const raw = marker._rtEntity;
        const vTripId = raw?.vehicle?.trip?.tripId || raw?.vehicle?.trip?.trip_id || raw?.trip?.tripId || raw?.trip?.trip_id;
        if (vTripId === tripId) {
          currentStopSeq = raw?.vehicle?.currentStopSequence || raw?.vehicle?.current_stop_sequence;
          vehicleFound = true;
          break;
        }
      }
      
      // Skip this trip if no matching vehicle found in vehiclePosition feed
      if (!vehicleFound) {
        continue;
      }
      
      // Initialize trip record if needed
      if (!recordedData[tripId]) {
        recordedData[tripId] = {
          rid: routeId,
          vid: vehicleId,
          stops: {}
        };
      }
      
      // Record all stop_time_updates up to and including current stop sequence
      for (const stu of stopTimeUpdates) {
        const stopSeq = stu.stopSequence || stu.stop_sequence;
        const stopId = stu.stopId || stu.stop_id;
        const arrivalTime = stu.arrival?.time || stu.departure?.time;
        
        if (!stopSeq || !stopId || !arrivalTime) continue;
        
        // Only record stops up to and including current stop
        if (currentStopSeq !== null && stopSeq <= currentStopSeq) {
          // Lookup scheduled times from cache
          const scheduled = scheduledTimesCache[tripId]?.[stopSeq];
          
          // Record or update this stop
          if (!recordedData[tripId].stops[stopSeq]) {
            newStopsRecorded++;
          }
          recordedData[tripId].stops[stopSeq] = {
            sid: stopId,
            seq: stopSeq,
            arr: arrivalTime,
            sch_arr: scheduled?.sch_arr || null,
            sch_dep: scheduled?.sch_dep || null
          };
        }
      }
    }
    
    console.log(`[RT Recorder] Processed ${data.entity.length} trip updates, recorded ${newStopsRecorded} new stops`);
    updateRecorderUI();
  }
  
  // Update recorder UI
  function updateRecorderUI() {
    // Update trip list
    const tripIds = Object.keys(recordedData).sort();
    tripListEl.innerHTML = '';
    
    if (tripIds.length === 0) {
      tripListEl.innerHTML = '<div style="padding:8px;color:#999;">No trips recorded yet</div>';
    } else {
      for (const tripId of tripIds) {
        const trip = recordedData[tripId];
        const route = gtfsData.routes[trip.rid];
        const routeDisplay = route 
          ? `${route.route_short_name || trip.rid}`
          : trip.rid;
        
        const div = document.createElement('div');
        div.className = 'trip-item';
        if (tripId === selectedTripId) div.classList.add('selected');
        div.textContent = `${tripId} (Route ${routeDisplay})`;
        div.addEventListener('click', () => selectTrip(tripId));
        tripListEl.appendChild(div);
      }
    }
    
    // Update trip details if a trip is selected
    if (selectedTripId && recordedData[selectedTripId]) {
      showTripDetails(selectedTripId);
    }
    
    // Update status
    const tripCount = tripIds.length;
    const totalStops = Object.values(recordedData).reduce((sum, trip) => sum + Object.keys(trip.stops).length, 0);
    const queuedTotal = totalRoutesQueued;
    const queuedRemaining = pendingRoutesToLoad.size;
    
    if (isRecording) {
      recorderStatus.innerHTML = `Recording: ${tripCount} trips, ${totalStops} stops recorded<br>Routes queued: ${queuedTotal} total, ${queuedRemaining} remaining`;
    } else {
      recorderStatus.textContent = `Not collecting (${tripCount} trips, ${totalStops} stops in memory)`;
    }
  }
  
  // Select a trip to view details
  function selectTrip(tripId) {
    selectedTripId = tripId;
    updateRecorderUI();
  }
  
  // Convert scheduled time string (HH:MM:SS) to epoch timestamp
  // Uses the actual arrival date as reference
  function scheduledTimeToEpoch(scheduledTimeStr, actualEpochSeconds) {
    if (!scheduledTimeStr || !actualEpochSeconds) return null;
    
    // Parse scheduled time "HH:MM:SS" (hours can be >= 24)
    const parts = scheduledTimeStr.split(':');
    if (parts.length !== 3) return null;
    
    let hours = parseInt(parts[0]);
    const minutes = parseInt(parts[1]);
    const seconds = parseInt(parts[2]);
    
    if (isNaN(hours) || isNaN(minutes) || isNaN(seconds)) return null;
    
    // Get date components in Toronto timezone
    const actualDate = new Date(actualEpochSeconds * 1000);
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: TORONTO_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
    
    const formatParts = formatter.formatToParts(actualDate);
    const year = parseInt(formatParts.find(p => p.type === 'year').value);
    const month = parseInt(formatParts.find(p => p.type === 'month').value) - 1; // JS months are 0-indexed
    const day = parseInt(formatParts.find(p => p.type === 'day').value);
    
    // Handle hours >= 24 (service day continues past midnight)
    let daysToAdd = 0;
    while (hours >= 24) {
      hours -= 24;
      daysToAdd++;
    }
    
    // Calculate Toronto's UTC offset on this date
    // Create a test date at noon UTC on the target day
    const testDate = new Date(Date.UTC(year, month, day, 12, 0, 0));
    const testParts = formatter.formatToParts(testDate);
    const torontoHour = parseInt(testParts.find(p => p.type === 'hour').value);
    let offsetHours = torontoHour - 12; // Difference between Toronto noon and UTC noon
    if (offsetHours > 12) offsetHours -= 24;
    if (offsetHours < -12) offsetHours += 24;
    
    // Create the scheduled time in UTC by subtracting Toronto's offset
    const scheduledUTC = Date.UTC(year, month, day + daysToAdd, hours - offsetHours, minutes, seconds);
    
    return Math.floor(scheduledUTC / 1000);
  }
  
  // Show details for selected trip
  function showTripDetails(tripId) {
    const trip = recordedData[tripId];
    if (!trip) {
      tripDetailsEl.innerHTML = '<div class="trip-details-empty">Trip not found</div>';
      return;
    }
    
    const route = gtfsData.routes[trip.rid];
    const routeDisplay = route 
      ? `${route.route_short_name || ''} – ${route.route_long_name || trip.rid}`
      : trip.rid;
    
    const stopSeqs = Object.keys(trip.stops).map(Number).sort((a, b) => a - b);
    
    let html = `<div style="margin-bottom:8px;font-weight:600;">Trip ${tripId}</div>`;
    html += `<div style="margin-bottom:8px;color:#666;">Route: ${escapeHtml(routeDisplay)}</div>`;
    html += `<div style="margin-bottom:8px;color:#666;">Actual Stops recorded: ${stopSeqs.length}</div>`;
    html += '<div style="margin-top:12px;">';
    
    for (const seq of stopSeqs) {
      const stop = trip.stops[seq];
      const stopData = gtfsData.stops[stop.sid];
      const stopName = stopData?.stop_name || stop.sid;
      
      let timeDisplay = '';
      
      // Check if we have actual RT arrival data
      if (stop.arr !== null) {
        const actualTime = new Date(stop.arr * 1000).toLocaleTimeString('en-US', {
          timeZone: TORONTO_TZ,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        });
        
        timeDisplay = `Actual: ${actualTime}`;
        
        // Show scheduled time with delay if available
        if (stop.sch_arr || stop.sch_dep) {
          const scheduledEpoch = scheduledTimeToEpoch(stop.sch_arr || stop.sch_dep, stop.arr);
          
          if (scheduledEpoch !== null) {
            const schTime = new Date(scheduledEpoch * 1000).toLocaleTimeString('en-US', {
              timeZone: TORONTO_TZ,
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit'
            });
            const delay = stop.arr - scheduledEpoch;
            const delayMin = Math.round(delay / 60);
            const delayText = delay > 0 ? `+${delayMin}m` : `${delayMin}m`;
            timeDisplay += ` | Scheduled: ${schTime} (${delayText})`;
          }
        }
      } else {
        // No RT data yet, show only scheduled time if available
        if (stop.sch_arr || stop.sch_dep) {
          // Use current time as reference for epoch conversion
          const scheduledEpoch = scheduledTimeToEpoch(stop.sch_arr || stop.sch_dep, Date.now() / 1000);
          
          if (scheduledEpoch !== null) {
            const schTime = new Date(scheduledEpoch * 1000).toLocaleTimeString('en-US', {
              timeZone: TORONTO_TZ,
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit'
            });
            timeDisplay = `Scheduled: ${schTime}`;
          }
        } else {
          timeDisplay = '<span style="color:#999;">No data</span>';
        }
      }
      
      html += `<div class="stop-record">Stop #${stop.seq} (${escapeHtml(stop.sid)}) <span style="color:#666;">${escapeHtml(stopName)}</span><br>${timeDisplay}</div>`;
    }
    
    html += '</div>';
    tripDetailsEl.innerHTML = html;
  }
  
  // Start recording
  function startRecording() {
    if (isRecording) return;
    
    isRecording = true;
    startRecordBtn.disabled = true;
    stopRecordBtn.disabled = false;
    
    // Fetch immediately
    fetchTripUpdates().then(async data => {
      if (data) await processTripUpdates(data);
    });
    
    // Then fetch every 60 seconds
    recordingIntervalId = setInterval(async () => {
      const data = await fetchTripUpdates();
      if (data) await processTripUpdates(data);
    }, TRIP_UPDATE_INTERVAL_MS);
    
    updateRecorderUI();
    console.log('[RT Recorder] Started collecting trip data');
  }
  
  // Stop recording
  function stopRecording() {
    if (!isRecording) return;
    
    isRecording = false;
    startRecordBtn.disabled = false;
    stopRecordBtn.disabled = true;
    
    if (recordingIntervalId) {
      clearInterval(recordingIntervalId);
      recordingIntervalId = null;
    }
    
    updateRecorderUI();
    console.log('[RT Recorder] Stopped collecting trip data');
  }
  
  // Download recorded data as JSON
  function downloadRecordedData() {
    const dataStr = JSON.stringify(recordedData, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `ttc-rt-data-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    console.log('[RT Recorder] Downloaded recorded data');
  }
  
  // Toggle recorder panel visibility
  const recorderPanel = document.getElementById('recorderPanel');
  const toggleRecorderBtn = document.getElementById('toggleRecorderBtn');
  const closeRecorderBtn = document.getElementById('closeRecorderBtn');
  
  function toggleRecorderPanel() {
    recorderPanel.classList.toggle('hidden');
  }
  
  // Event listeners
  startRecordBtn.addEventListener('click', startRecording);
  stopRecordBtn.addEventListener('click', stopRecording);
  downloadRecordBtn.addEventListener('click', downloadRecordedData);
  toggleRecorderBtn.addEventListener('click', toggleRecorderPanel);
  closeRecorderBtn.addEventListener('click', toggleRecorderPanel);
  
  // Initialize UI
  updateRecorderUI();
})();
