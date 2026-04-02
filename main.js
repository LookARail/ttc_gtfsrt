(function () {
  // --- Config ---
  const FEED_URL = (window.APP_CONFIG && window.APP_CONFIG.feedUrl) || ""; // Server endpoint that returns decoded GTFS-RT JSON (from config.json)
  const POLL_MS = 10_000;

  // GitHub repository for processed GTFS data
  // Update this with your GitHub username/repository
  const GITHUB_REPO = (window.APP_CONFIG && window.APP_CONFIG.githubRepo) || ""; // e.g., "username/gtfs-processed-data"
  const GITHUB_BRANCH = (window.APP_CONFIG && window.APP_CONFIG.githubBranch) || "main";
  const GTFS_DATA_BASE_URL = GITHUB_REPO ? `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/data` : "";

  // Time zone to use for displaying and interpreting scheduled times
  const TIME_ZONE = (window.APP_CONFIG && window.APP_CONFIG.timeZone) || "UTC";

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
  // Cache: vehicle_id -> { tripId, routeId, tripData, routeData }
  // Reused across RT feed updates so we don't re-link every vehicle every poll.
  
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
  
  // Check if arrival time is valid (numeric, not "skip" or other non-numeric values)
  function isValidArrivalTime(arr) {
    // TODO: Future enhancement - track trips/stops with skipped arrivals for statistics
    return typeof arr === 'number' && isFinite(arr) && arr !== null;
  }

  // Normalize delay: fix day-boundary issues where actual arrival is 24hrs relative to scheduled
  // If delay is between -22 to -26 hours, add 24 hours (likely day boundary data issue)
  function normalizeDelay(delaySeconds) {
    if (delaySeconds === null || delaySeconds === undefined) return delaySeconds;
    
    const HOUR_22_SECONDS = -22 * 3600; // -79,200
    const HOUR_26_SECONDS = -26 * 3600; // -93,600
    const DAY_SECONDS = 86400;
    
    // If delay is between -22 to -26 hours, assume day boundary crossing
    if (delaySeconds <= HOUR_22_SECONDS && delaySeconds >= HOUR_26_SECONDS) {
      return delaySeconds + DAY_SECONDS;
    }
    
    return delaySeconds;
  }

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
      if (!GTFS_DATA_BASE_URL) {
        console.error('[GTFS] githubRepo not configured in config.json — cannot load GTFS static files.');
        setStatus('Missing GTFS data configuration', 'error');
        return;
      }
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
  // Map init (default center from config or Toronto downtown)
  const map = L.map('map', {
    worldCopyJump: true
  }).setView([43.6532, -79.3832], 12);
  // If a config map center/zoom is provided, apply it
  if (window.APP_CONFIG && window.APP_CONFIG.map) {
    try {
      const c = window.APP_CONFIG.map.center || [43.6532, -79.3832];
      const z = window.APP_CONFIG.map.zoom || 12;
      map.setView(c, z);
    } catch (e) { /* ignore invalid config */ }
  }

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
    // Format using configured time zone without hard-coding offset
    return new Intl.DateTimeFormat(undefined, {
      timeZone: TIME_ZONE,
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      year: 'numeric', month: 'short', day: '2-digit'
    }).format(d);
  }

  function ageSeconds(epochSeconds) {
    if (!Number.isFinite(epochSeconds)) return undefined;
    return (Date.now() / 1000) - epochSeconds;
    // Positive: how many seconds ago this update was
  }

  // ============================================================================
  // BEARING COMPUTATION (for feeds that don't provide bearing)
  // ============================================================================
  
  // Cache of last seen position per vehicle: id -> { lat, lon, ts }
  const lastPositions = new Map();

  function toRadians(deg) { return deg * Math.PI / 180; }
  function toDegrees(rad) { return rad * 180 / Math.PI; }

  // Compute initial bearing (forward azimuth) from point A to B (degrees, 0..360)
  function computeBearing(lat1, lon1, lat2, lon2) {
    const φ1 = toRadians(lat1);
    const φ2 = toRadians(lat2);
    const Δλ = toRadians(lon2 - lon1);
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    const θ = Math.atan2(y, x);
    return (toDegrees(θ) + 360) % 360;
  }

  // Haversine distance in meters
  function distanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const φ1 = toRadians(lat1);
    const φ2 = toRadians(lat2);
    const Δφ = toRadians(lat2 - lat1);
    const Δλ = toRadians(lon2 - lon1);
    const a = Math.sin(Δφ/2)**2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2)**2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
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
          if (!GTFS_DATA_BASE_URL) {
            console.warn(`[GTFS] Skipping stop-times load for ${routeId}: GTFS_DATA_BASE_URL not configured`);
            continue;
          }
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

    const ts = toNumber(v?.vehicle?.timestamp || v?.timestamp);
    const speed = toNumber(pos.speed); // m/s if present

    // Try to get bearing from feed; compute from position if missing
    const rawBearing = toNumber(pos.bearing, null);
    let computedBearing = null;
    
    const prev = lastPositions.get(id);
    let dt = null;
    let dist = null;
    if (prev && Number.isFinite(prev.lat) && Number.isFinite(prev.lon) && Number.isFinite(ts)) {
      dt = ts - (prev.ts || 0);
      dist = distanceMeters(prev.lat, prev.lon, lat, lon);
      // Only compute if moved enough and time difference reasonable (avoid tiny jitter)
      // dt < 300s (5min), dist >= 5m
      if (dt > 0 && dt < 300 && dist >= 5) {
        computedBearing = computeBearing(prev.lat, prev.lon, lat, lon);
      }
    }
    
    const m = markers.get(id);
    // Get previously computed bearing (from last update where we actually computed)
    const prevComputedBearing = m ? m._lastComputedBearing : null;
    
    // Prefer feed bearing > computed bearing > previously computed bearing > 0
    const bearing = Number.isFinite(rawBearing)
      ? rawBearing
      : (computedBearing !== null ? computedBearing : (prevComputedBearing !== null ? prevComputedBearing : 0));

    // (no per-poll debug logging)

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
    // Store last computed bearing for fallback on future updates when distance < 5m
    marker._lastComputedBearing = computedBearing !== null ? computedBearing : prevComputedBearing;

    // Store last position for next bearing computation
    lastPositions.set(id, { lat, lon, ts });

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
        lastPositions.delete(id);
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
      if (!FEED_URL) {
        console.warn('[Feed] FEED_URL not configured in config.json — skipping vehicle fetch');
        setStatus('Feed URL missing', 'error');
        return;
      }
      const resp = await fetch(FEED_URL, { signal: controller.signal, cache: 'no-store' });
      clearTimeout(timeout); // Clear timeout on successful fetch
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      
      // Server returns decoded JSON from protobuf
      const data = await resp.json();
      const entities = Array.isArray(data?.entity) ? data.entity : (Array.isArray(data) ? data : []);

      // Build set of vehicle ids from feed, then process entities
      const seen = new Set();
      for (const e of entities) {
        try {
          const id = e?.vehicle?.vehicle?.id || e?.id || e?.vehicle?.id || e?.vehicle?.label;
          if (id) seen.add(String(id));
        } catch (err) {}
      }
      for (const e of entities) {
        // guard per-entity
        try {
          upsertMarker(e);
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
  
  const TRIP_UPDATE_URL = (window.APP_CONFIG && window.APP_CONFIG.tripUpdateUrl) || "";
  const TRIP_UPDATE_INTERVAL_MS = 60_000; // 60 seconds
  const RECORDING_DURATION_MS = 86400 * 1000; // 24 hours in milliseconds
  const TIMEZONE = (window.APP_CONFIG && window.APP_CONFIG.timeZone) || "UTC";
  const GITHUB_REPO_RECORDER = (window.APP_CONFIG && window.APP_CONFIG.githubRepo) || "";
  
  // Recording state
  let isRecording = false;
  let recordingIntervalId = null;
  let recordingStartTimeMs = null; // When recording started (used for 24-hour check)
  let recordedData = {}; // { tripId: { rid, vid, stops: { stopSeq: { sid, seq, arr, sch_arr, sch_dep } } } }
  let selectedTripId = null;
  
  // Metrics tracking
  let cyclesCompleted = 0;
  let latestFeedTripsCount = 0;
  let latestVehicleFoundCount = 0;
  let latestOrphanedCount = 0;
  let latestRoutesQueuedCount = 0;
  let prevFeedTripsCount = 0;
  let prevVehicleFoundCount = 0;
  let prevOrphanedCount = 0;
  let prevTripsWithArrivals = 0;
  let prevTripsWithoutArrivals = 0;
  let prevStopsWithArrival = 0;
  
  // Scheduled times cache and loading queue
  const seenTripIds = new Set(); // Track which trips we've already encountered
  let tripToRouteMap = {}; // Persistent map: tripId -> routeId (survives across feed cycles)
  const pendingTripsNeedingSchedules = new Set(); // Trip IDs that don't have cached scheduled times yet
  const tripsNotFoundInStopTimes = new Set(); // Trip IDs NOT found in their route's stop-times file (don't re-try)
  const scheduledTimesCache = {}; // { tripId: { stopSeq: { sch_arr, sch_dep } } }
  const loadingRoutes = new Set(); // Routes currently being loaded
  const loadedRoutes = new Set(); // Routes successfully loaded (allow re-queueing when new trips need them)
  let totalRoutesQueued = 0; // Total unique routes ever queued
  
  // DOM elements
  const startRecordBtn = document.getElementById('startRecordBtn');
  const stopRecordBtn = document.getElementById('stopRecordBtn');
  const downloadRecordBtn = document.getElementById('downloadRecordBtn');
  const recorderStatus = document.getElementById('recorderStatus');
  const tripListEl = document.getElementById('tripList');
  const tripDetailsEl = document.getElementById('tripDetails');
  
  // =========================================================================
  // TIMEZONE CONVERSION FUNCTIONS (from server)
  // =========================================================================
  
  // Convert UTC epoch seconds to a specific timezone's epoch seconds
  function convertToLocalEpoch(utcEpochSeconds, timezone) {
    const utcDate = new Date(utcEpochSeconds * 1000);
    const formatter = new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: timezone
    });
    const parts = formatter.formatToParts(utcDate);
    const dateObj = {};
    parts.forEach(({ type, value }) => {
      dateObj[type] = parseInt(value);
    });
    return Math.floor(
      Date.UTC(dateObj.year, dateObj.month - 1, dateObj.day, dateObj.hour, dateObj.minute, dateObj.second) / 1000
    );
  }
  
  // Get local midnight epoch for a timezone based on earliest arrival
  function getLocalMidnight(minArrEpochSeconds, timezone) {
    if (minArrEpochSeconds === Infinity) return null;
    const utcDate = new Date(minArrEpochSeconds * 1000);
    const formatter = new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: timezone
    });
    const parts = formatter.formatToParts(utcDate);
    const dateObj = {};
    parts.forEach(({ type, value }) => {
      dateObj[type] = parseInt(value);
    });
    return Math.floor(
      Date.UTC(dateObj.year, dateObj.month - 1, dateObj.day, 0, 0, 0) / 1000
    );
  }
  
  // Convert UTC timestamp (ms) to YYYY-MM-DD date string in specified timezone
  function getLocalDateString(utcEpochMs, timezone) {
    const utcDate = new Date(utcEpochMs);
    const formatter = new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: timezone
    });
    const parts = formatter.formatToParts(utcDate);
    const dateObj = {};
    parts.forEach(({ type, value }) => {
      dateObj[type] = parseInt(value);
    });
    return `${dateObj.year}-${String(dateObj.month).padStart(2, '0')}-${String(dateObj.day).padStart(2, '0')}`;
  }
  
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
      if (!GTFS_DATA_BASE_URL) {
        console.warn(`[RT Recorder] Cannot load scheduled times for route ${routeId}: GTFS_DATA_BASE_URL not configured`);
        loadingRoutes.delete(routeId);
        return;
      }
      const resp = await fetch(`${GTFS_DATA_BASE_URL}/${filename}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      
      const stopTimesData = await resp.json();
      
      // Extract into compact cache format
      let tripsExtracted = 0;
      
      if (!stopTimesData || typeof stopTimesData !== 'object') {
        console.warn(`[RT Recorder] WARNING: stopTimesData invalid for route ${routeId}:`, { type: typeof stopTimesData, stopTimesData });
      } else {
        for (const tripId in stopTimesData) {
          if (!scheduledTimesCache[tripId]) {
            scheduledTimesCache[tripId] = {};
          }
          for (const stop of stopTimesData[tripId]) {
            // Store ALL scheduled times (including "skip" and other special values)
            // Only store sch_dep if it's different from sch_arr (to reduce data size)
            const cacheEntry = {
              sch_arr: stop.arr
            };
            // Only include sch_dep if it exists and is different from sch_arr
            if (stop.dep && stop.dep !== stop.arr) {
              cacheEntry.sch_dep = stop.dep;
            }
            scheduledTimesCache[tripId][stop.seq] = cacheEntry;
          }
        tripsExtracted++;
      }
      }  // Close else block
      
      // Safe console.log that won't crash if stopTimesData is undefined
      let stopsCountAvg = 0;
      if (stopTimesData && typeof stopTimesData === 'object') {
        const keys = Object.keys(stopTimesData);
        if (keys.length > 0 && stopTimesData[keys[0]]) {
          stopsCountAvg = Object.keys(stopTimesData[keys[0]]).length;
        }
      }
      console.log(`[RT Recorder] ✓ Route ${routeId} loaded: ${tripsExtracted} trips, ${stopsCountAvg} stops avg`);
      
      // Pre-populate all scheduled stops for trips in recordedData that match this route
      if (!recordedData || typeof recordedData !== 'object') {
        console.warn(`[RT Recorder] WARNING: recordedData is invalid for route ${routeId}:`, { recordedData });
        return;  // Exit function early if recordedData is missing
      }
      
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
                const prepopStop = {
                  sid: stopData.sid,
                  seq: seq,
                  arr: null,  // No actual RT data yet
                  sch_arr: scheduled.sch_arr
                };
                // Only include sch_dep if it exists and is different from sch_arr
                if (scheduled.sch_dep) {
                  prepopStop.sch_dep = scheduled.sch_dep;
                }
                trip.stops[seq] = prepopStop;
              }
            } else {
              // Merge scheduled times into existing entry (in case RT data came first)
              if (!trip.stops[seq].sch_arr) trip.stops[seq].sch_arr = scheduled.sch_arr;
              if (scheduled.sch_dep && !trip.stops[seq].sch_dep) trip.stops[seq].sch_dep = scheduled.sch_dep;
            }
          }
        }
      }
      
      // Don't store in gtfsData.stopTimesByRoute - we only use scheduledTimesCache
      // This allows the large stopTimesData object to be garbage collected
      
      // Mark trips as no longer pending - two cases:
      // 1. Found in stop-times: remove from pending (scheduledTimesCache populated)
      // 2. NOT found in stop-times: move to "don't retry" set (skip on future cycles)
      for (const tripId of pendingTripsNeedingSchedules) {
        if (recordedData[tripId]?.rid === routeId) {
          if (scheduledTimesCache[tripId]) {
            // Trip found in stop-times - remove from pending
            pendingTripsNeedingSchedules.delete(tripId);
          } else if ((!stopTimesData || !stopTimesData[tripId])) {
            // Trip NOT found in stop-times - mark as "don't retry" and remove from pending
            pendingTripsNeedingSchedules.delete(tripId);
            tripsNotFoundInStopTimes.add(tripId);
          }
        }
      }
      
      // DIFFERENCE 3: Do not track loadedRoutes; allow routes to be re-queued like server does
      // (new trips may need the same route, so no blocking list)
    } catch (err) {
      console.warn(`[RT Recorder] Failed to load route ${routeId}:`, err);
    } finally {
      loadingRoutes.delete(routeId);
    }
  }
  
  // Process trip updates and record stop arrivals
  async function processTripUpdates(data) {
    if (!data || !data.entity) return;
    
    cyclesCompleted++;
    const now = Date.now();
    let newStopsRecorded = 0;
    
    // Build vehicle map from markers (avoid nested loops in phase 3)
    const vehicleMap = new Map(); // tripId -> { currentStopSeq, vehicleId }
    for (const [vehicleId, marker] of markers) {
      const raw = marker._rtEntity;
      const vTripId = raw?.vehicle?.trip?.tripId || raw?.vehicle?.trip?.trip_id || raw?.trip?.tripId || raw?.trip?.trip_id;
      if (vTripId) {
        const currentStopSeq = raw?.vehicle?.currentStopSequence || raw?.vehicle?.current_stop_sequence;
        vehicleMap.set(vTripId, { currentStopSeq, vehicleId });
      }
    }
    
    // Phase 1: Identify new trips and queue routes for loading
    let feedTripsCount = 0;
    let matchedTripCount = 0;
    
    // Update persistent trip->route mapping from this feed
    for (const entity of data.entity) {
      const tripUpdate = entity.tripUpdate || entity.trip_update;
      if (!tripUpdate) continue;
      
      feedTripsCount++;
      
      const trip = tripUpdate.trip;
      const tripId = trip?.tripId || trip?.trip_id;
      const routeId = trip?.routeId || trip?.route_id;
      
      if (!tripId || !routeId) continue;
      
      // Store in persistent map (survives across feed cycles)
      tripToRouteMap[tripId] = routeId;
      
      // Check if this vehicle has a matching vehicle position
      if (vehicleMap.has(tripId)) {
        matchedTripCount++;
      }
      
      // Check if this is a new trip (needs its schedules loaded)
      if (!seenTripIds.has(tripId)) {
        seenTripIds.add(tripId);
        // DIFFERENCE 1: Only queue trips that have a matching vehicle (like server does)
        if (vehicleMap.has(tripId) && !tripsNotFoundInStopTimes.has(tripId)) {
          pendingTripsNeedingSchedules.add(tripId);
        }
      }
    }
    
    // Update latest feed metrics
    latestFeedTripsCount = feedTripsCount;
    latestVehicleFoundCount = matchedTripCount;
    latestOrphanedCount = feedTripsCount - matchedTripCount;
    
    // Phase 2: Compute unique routes from pending trips
    // First, count ALL unique routes from pending trips (not capped)
    const allRoutesFromPending = new Set();
    for (const tripId of pendingTripsNeedingSchedules) {
      const routeId = tripToRouteMap[tripId];
      if (routeId) {
        allRoutesFromPending.add(routeId);
      }
    }
    
    // Display: total unique routes needed by pending trips
    latestRoutesQueuedCount = allRoutesFromPending.size;
    
    // Now select which routes to actually load this cycle (cap at 50)
    // DIFFERENCE 3: Do not re-queue routes already loaded (like server does)
    const routesToLoadNow = new Set();
    for (const tripId of pendingTripsNeedingSchedules) {
      const routeId = tripToRouteMap[tripId];
      if (routeId && !loadingRoutes.has(routeId) && !loadedRoutes.has(routeId)) {
        routesToLoadNow.add(routeId);
        totalRoutesQueued++;
        if (routesToLoadNow.size >= 50) break; // Cap at 50 routes per cycle
      }
    }
    
    // Phase 2b: Load up to 50 routes
    const loadPromises = [...routesToLoadNow].map(routeId => {
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
      const stopTimeUpdates = tripUpdate.stopTimeUpdate || tripUpdate.stop_time_update || [];
      
      if (!tripId || !routeId) continue;
      
      // Lookup vehicle from pre-built map (no nested loop)
      const vehicleInfo = vehicleMap.get(tripId);
      if (!vehicleInfo) {
        // Skip this trip if no matching vehicle found
        continue;
      }
      
      const { currentStopSeq, vehicleId } = vehicleInfo;
      
      // Initialize trip record if needed
      if (!recordedData[tripId]) {
        recordedData[tripId] = {
          rid: routeId,
          vid: vehicleId,
          stops: {}
        };
        
        // Eager pre-population: if this route's schedules are already loaded, populate all stops now
        if (scheduledTimesCache[tripId]) {
          for (const stopSeqStr in scheduledTimesCache[tripId]) {
            const seq = parseInt(stopSeqStr);
            const scheduled = scheduledTimesCache[tripId][seq];
            
            // Pre-populate with scheduled time but no actual arrival yet
            recordedData[tripId].stops[seq] = {
              sid: null,  // Will be populated when we see the actual arrival
              seq: seq,
              arr: null,  // No actual RT data yet
              sch_arr: scheduled.sch_arr
            };
            if (scheduled.sch_dep) {
              recordedData[tripId].stops[seq].sch_dep = scheduled.sch_dep;
            }
          }
        }
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
          
          // If stop already exists (from pre-population), merge data; otherwise create new
          const existing = recordedData[tripId].stops[stopSeq];
          recordedData[tripId].stops[stopSeq] = {
            sid: stopId,
            seq: stopSeq,
            arr: typeof arrivalTime === 'string' ? parseInt(arrivalTime) : arrivalTime,
            sch_arr: existing?.sch_arr ?? (scheduled?.sch_arr || null)
          };
          
          // Only include sch_dep if it exists and is different from sch_arr
          if (existing?.sch_dep) {
            recordedData[tripId].stops[stopSeq].sch_dep = existing.sch_dep;
          } else if (scheduled?.sch_dep) {
            recordedData[tripId].stops[stopSeq].sch_dep = scheduled.sch_dep;
          }
        }
      }
    }
    
    console.log(`[RT Recorder] Cycle ${cyclesCompleted}: Feed ${feedTripsCount} trips, ${matchedTripCount} matched, ${latestOrphanedCount} orphaned, +${newStopsRecorded} stops`);
    updateRecorderUI();
    
    // Save current cycle metrics for next cycle's delta calculation
    // Need to recalculate to get current values for saving as prev
    const tripIds = Object.keys(recordedData);
    let currentTripsWithArrivals = 0;
    let currentStopsWithArrival = 0;
    for (const tripId in recordedData) {
      const trip = recordedData[tripId];
      const hasArrival = Object.values(trip.stops).some(stop => isValidArrivalTime(stop.arr));
      if (hasArrival) currentTripsWithArrivals++;
      
      for (const stop of Object.values(trip.stops)) {
        if (isValidArrivalTime(stop.arr) && (stop.sch_arr || stop.sch_dep)) {
          currentStopsWithArrival++;
        }
      }
    }
    prevFeedTripsCount = latestFeedTripsCount;
    prevVehicleFoundCount = latestVehicleFoundCount;
    prevTripsWithArrivals = currentTripsWithArrivals;
    prevStopsWithArrival = currentStopsWithArrival;
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
    
    // Calculate cumulative metrics
    const tripCount = tripIds.length;
    const totalStops = Object.values(recordedData).reduce((sum, trip) => sum + Object.keys(trip.stops).length, 0);
    
    // Count trips with at least one arrival vs no arrivals
    let tripsWithArrivals = 0;
    let tripsWithoutArrivals = 0;
    for (const tripId in recordedData) {
      const trip = recordedData[tripId];
      const hasArrival = Object.values(trip.stops).some(stop => isValidArrivalTime(stop.arr));
      if (hasArrival) {
        tripsWithArrivals++;
      } else {
        tripsWithoutArrivals++;
      }
    }
    
    // Count stops with both actual and scheduled times
    let stopsWithArrival = 0;
    for (const tripId in recordedData) {
      const trip = recordedData[tripId];
      for (const stop of Object.values(trip.stops)) {
        if (isValidArrivalTime(stop.arr) && (stop.sch_arr || stop.sch_dep)) {
          stopsWithArrival++;
        }
      }
    }
    
    const arrivalCompletionPercent = totalStops > 0 ? Math.round((stopsWithArrival / totalStops) * 100) : 0;
    
    // Calculate deltas
    const feedTripsDelta = latestFeedTripsCount - prevFeedTripsCount;
    const vehicleFoundDelta = latestVehicleFoundCount - prevVehicleFoundCount;
    const tripsDelta = tripsWithArrivals - prevTripsWithArrivals;
    const stopsWithArrivalDelta = stopsWithArrival - prevStopsWithArrival;
    
    if (isRecording) {
      // Build metrics display matching the server dashboard
      let metricsHtml = '<div style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; font-size: 12px; margin-bottom: 12px;">';
      
      metricsHtml += `<div><div style="color: #0066cc; font-weight: bold; font-size: 16px;">${cyclesCompleted}</div><div style="color: #666; font-size: 11px;">CYCLES COMPLETED</div></div>`;
      metricsHtml += `<div><div style="color: #0066cc; font-weight: bold; font-size: 16px;">${latestFeedTripsCount} <span style="font-size: 12px; color: #00aa00;">(+${feedTripsDelta})</span></div><div style="color: #666; font-size: 11px;">LATEST: FEED TRIPS</div></div>`;
      metricsHtml += `<div><div style="color: #0066cc; font-weight: bold; font-size: 16px;">${latestVehicleFoundCount} <span style="font-size: 12px; color: #00aa00;">(+${vehicleFoundDelta})</span></div><div style="color: #666; font-size: 11px;">LATEST: VEHICLE FOUND</div></div>`;
      metricsHtml += `<div><div style="color: #ff6600; font-weight: bold; font-size: 16px;">${latestRoutesQueuedCount} | ${pendingTripsNeedingSchedules.size}📋</div><div style="color: #666; font-size: 11px;">ROUTES QUEUED | PENDING TRIPS</div></div>`;
      metricsHtml += `<div><div style="color: #cc0000; font-weight: bold; font-size: 16px;">${latestOrphanedCount}</div><div style="color: #666; font-size: 11px;">LATEST: ORPHANED</div></div>`;
      
      metricsHtml += `<div><div style="color: #00aa00; font-weight: bold; font-size: 16px;">${tripsWithArrivals} <span style="font-size: 12px; color: #00aa00;">(+${tripsDelta})</span></div><div style="color: #666; font-size: 11px;">LATEST: W/ ≥1 ARRIVAL</div></div>`;
      metricsHtml += `<div><div style="color: #cc0000; font-weight: bold; font-size: 16px;">${tripsWithoutArrivals}</div><div style="color: #666; font-size: 11px;">LATEST: NO ARRIVALS</div></div>`;
      metricsHtml += `<div><div style="color: #ff9900; font-weight: bold; font-size: 16px;">${totalStops}</div><div style="color: #666; font-size: 11px;">TOTAL STOPS</div></div>`;
      metricsHtml += `<div><div style="color: #0066cc; font-weight: bold; font-size: 16px;">${stopsWithArrival} <span style="font-size: 12px; color: #00aa00;">(+${stopsWithArrivalDelta})</span></div><div style="color: #666; font-size: 11px;">STOPS W/ ARRIVAL</div></div>`;
      metricsHtml += `<div><div style="color: #0066cc; font-weight: bold; font-size: 16px;">${arrivalCompletionPercent}%</div><div style="color: #666; font-size: 11px;">% COMPLETION</div></div>`;
      
      metricsHtml += '</div>';
      
      recorderStatus.innerHTML = metricsHtml;
    } else {
      recorderStatus.textContent = `Not collecting (${tripCount} trips, ${totalStops} stops, ${stopsWithArrival}/${totalStops} with arrival)`;
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
      timeZone: TIME_ZONE,
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
    const stopsWithActualArrivals = stopSeqs.filter(seq => isValidArrivalTime(trip.stops[seq].arr)).length;
    
    let html = `<div style="margin-bottom:8px;font-weight:600;">Trip ${tripId}</div>`;
    html += `<div style="margin-bottom:8px;color:#666;">Route: ${escapeHtml(routeDisplay)}</div>`;
    html += `<div style="margin-bottom:8px;color:#666;">Stops: ${stopSeqs.length} total (${stopsWithActualArrivals} with actual arrivals)</div>`;
    html += '<div style="margin-top:12px;">';
    
    for (const seq of stopSeqs) {
      const stop = trip.stops[seq];
      const stopData = gtfsData.stops[stop.sid];
      const stopName = stopData?.stop_name || stop.sid || 'Unknown Stop';
      
      let timeDisplay = '';
      let bgColor = '';
      
      // Check if we have actual RT arrival data
      if (isValidArrivalTime(stop.arr)) {
        const actualTime = new Date(stop.arr * 1000).toLocaleTimeString('en-US', {
          timeZone: TIME_ZONE,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        });
        
        timeDisplay = `Actual: ${actualTime}`;
        
        // Show scheduled time with delay if available (still HH:MM:SS format until export)
        if (stop.sch_arr) {
          const schStr = typeof stop.sch_arr === 'string' ? stop.sch_arr : 'pending';
          if (schStr !== 'pending') {
            let delay = stop.arr - convertToLocalEpoch(stop.arr, TIMEZONE);
            // Delay calculation: we need to estimate it from the HH:MM:SS
            // For now, just show the times
            timeDisplay += ` | Scheduled: ${schStr}`;
          }
        }
        bgColor = 'background-color: #f0f8ff;';
      } else {
        // No RT data yet, show only scheduled time if available
        if (stop.sch_arr) {
          const schStr = typeof stop.sch_arr === 'string' ? stop.sch_arr : 'pending';
          timeDisplay = `Scheduled: ${schStr}`;
          bgColor = 'background-color: #fff9e6;';  // Light yellow for scheduled-only
        } else {
          timeDisplay = '<span style="color:#999;">No data</span>';
        }
      }
      
      html += `<div class="stop-record" style="${bgColor}">Stop #${stop.seq} (${escapeHtml(stop.sid || 'TBD')}) <span style="color:#666;">${escapeHtml(stopName)}</span><br>${timeDisplay}</div>`;
    }
    
    html += '</div>';
    tripDetailsEl.innerHTML = html;
  }
  
  // Start recording
  function startRecording() {
    if (isRecording) return;
    
    isRecording = true;
    recordingStartTimeMs = Date.now();
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
      
      // Check if 24 hours have elapsed
      checkAndExport24Hours();
    }, TRIP_UPDATE_INTERVAL_MS);
    
    updateRecorderUI();
    console.log('[RT Recorder] Started collecting trip data');
  }
  
  // Stop recording and clear data
  function stopRecording() {
    if (!isRecording) return;
    
    isRecording = false;
    recordingStartTimeMs = null;
    startRecordBtn.disabled = false;
    stopRecordBtn.disabled = true;
    
    if (recordingIntervalId) {
      clearInterval(recordingIntervalId);
      recordingIntervalId = null;
    }
    
    // Clear all recorded data
    recordedData = {};
    seenTripIds.clear();
    tripToRouteMap = {};
    pendingTripsNeedingSchedules.clear();
    tripsNotFoundInStopTimes.clear();
    loadingRoutes.clear();
    // DIFFERENCE 3: loadedRoutes no longer used
    cyclesCompleted = 0;
    latestFeedTripsCount = 0;
    latestVehicleFoundCount = 0;
    latestOrphanedCount = 0;
    prevFeedTripsCount = 0;
    prevVehicleFoundCount = 0;
    prevTripsWithArrivals = 0;
    prevStopsWithArrival = 0;
    selectedTripId = null;
    
    updateRecorderUI();
    console.log('[RT Recorder] Stopped collecting trip data and cleared all data');
  }
  
  // Download recorded data as JSON with timezone conversion
  async function downloadRecordedData() {
    try {
      // Step 0: Load any missing scheduled times before export
      const tripsWithoutSchedule = [];
      const routesToComplete = new Set();
      
      for (const [tripId, trip] of Object.entries(recordedData)) {
        const stops = Object.values(trip.stops);
        if (stops.length > 0 && stops.every(stop => !stop.sch_arr && !stop.sch_dep)) {
          tripsWithoutSchedule.push(tripId);
          if (trip.rid) {
            routesToComplete.add(trip.rid);
          }
        }
      }
      
      // Load missing routes to complete scheduled data
      if (routesToComplete.size > 0) {
        console.log(`[RT Recorder] Completing scheduled data for ${tripsWithoutSchedule.length} trips from ${routesToComplete.size} routes before export...`);
        
        for (const routeId of routesToComplete) {
          if (!gtfsData.metadata || !gtfsData.metadata.stop_times_files || !gtfsData.metadata.stop_times_files[routeId]) {
            continue;
          }
          
          const filename = gtfsData.metadata.stop_times_files[routeId];
          try {
            const resp = await fetch(`${GTFS_DATA_BASE_URL}/${filename}`);
            if (!resp.ok) continue;
            
            const stopTimesData = await resp.json();
            
            // Apply scheduled times to matching trips
            for (const tripId of tripsWithoutSchedule) {
              const trip = recordedData[tripId];
              if (trip && trip.rid === routeId && stopTimesData[tripId]) {
                for (const [stopSeqStr, stop] of Object.entries(trip.stops)) {
                  const seq = parseInt(stopSeqStr);
                  const stopTimesForTrip = stopTimesData[tripId];
                  
                  if (Array.isArray(stopTimesForTrip)) {
                    const schedStop = stopTimesForTrip.find(s => s.seq === seq);
                    if (schedStop) {
                      const arr = schedStop.arr || null;
                      const dep = schedStop.dep || null;
                      stop.sch_arr = arr || dep;
                      // Only set sch_dep if it exists and is different from sch_arr
                      if (dep && dep !== (arr || dep)) {
                        stop.sch_dep = dep;
                      }
                    }
                  }
                }
              }
            }
          } catch (err) {
            console.warn(`[RT Recorder] Failed to load route ${routeId} for completion:`, err.message);
          }
        }
        
        console.log(`[RT Recorder] ✓ Completed scheduled data from ${routesToComplete.size} route files`);
      }
      
      // Step 1: Find earliest arrival to determine local midnight for timezone
      let minArr = Infinity;
      for (const tripId in recordedData) {
        const stops = Object.values(recordedData[tripId].stops);
        for (const stop of stops) {
          if (stop.arr !== null && typeof stop.arr === 'number') {
            const t = Number(stop.arr);
            if (t < minArr) {
              minArr = t;
            }
          }
        }
      }
      
      // Step 2: Calculate local midnight from earliest arrival
      const localMidnight = getLocalMidnight(minArr, TIMEZONE);
      
      // Step 3: Create shallow copy of recorded data for export (preserve original)
      const exportedRecordedData = {};
      for (const tripId in recordedData) {
        const trip = recordedData[tripId];
        exportedRecordedData[tripId] = {
          rid: trip.rid,
          vid: trip.vid,
          stops: {}
        };
        for (const stopSeq in trip.stops) {
          exportedRecordedData[tripId].stops[stopSeq] = { ...trip.stops[stopSeq] };
        }
      }
      
      // Step 4: Convert all times to local timezone epoch
      console.log(`[RT Recorder] Converting times to ${TIMEZONE} timezone...`);
      for (const tripId in exportedRecordedData) {
        const stops = Object.values(exportedRecordedData[tripId].stops);
        
        for (const stop of stops) {
          // Convert arr from UTC epoch to local timezone epoch (handle both string and number)
          if (stop.arr !== null && stop.arr !== undefined) {
            const arrNum = typeof stop.arr === 'string' ? parseInt(stop.arr) : stop.arr;
            if (Number.isFinite(arrNum)) {
              stop.arr = convertToLocalEpoch(arrNum, TIMEZONE);
            }
          }
          
          // Convert sch_arr from HH:MM:SS string to local timezone epoch
          if (stop.sch_arr && typeof stop.sch_arr === 'string' && localMidnight !== null) {
            const p = stop.sch_arr.split(':').map(Number);
            const seconds = p[0] * 3600 + p[1] * 60 + p[2];
            stop.sch_arr = localMidnight + seconds;
          }
          
          // Convert sch_dep from HH:MM:SS string to local timezone epoch (if exists)
          if (stop.sch_dep && typeof stop.sch_dep === 'string' && localMidnight !== null) {
            const p = stop.sch_dep.split(':').map(Number);
            const seconds = p[0] * 3600 + p[1] * 60 + p[2];
            stop.sch_dep = localMidnight + seconds;
          }
          
          // Handle next-day scheduled times (if arr - sch_arr > 12 hours, increment by 24 hours)
          if (stop.arr !== null && stop.sch_arr && stop.arr - stop.sch_arr > 43200) {
            stop.sch_arr += 86400;
          }
          if (stop.arr !== null && stop.sch_dep && stop.arr - stop.sch_dep > 43200) {
            stop.sch_dep += 86400;
          }
          
          // Remove sch_dep if it equals sch_arr (they should differ in export)
          if (stop.sch_dep && stop.sch_arr && stop.sch_dep === stop.sch_arr) {
            delete stop.sch_dep;
          }
        }
      }
      
      // Step 5: Convert exportedAt to local timezone epoch
      const exportedAtUTC = new Date(Date.now());
      const formatterExported = new Intl.DateTimeFormat('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: TIMEZONE
      });
      const partsExported = formatterExported.formatToParts(exportedAtUTC);
      const dateObjExported = {};
      partsExported.forEach(({ type, value }) => {
        dateObjExported[type] = parseInt(value);
      });
      const exportedAtLocal = Math.floor(
        Date.UTC(dateObjExported.year, dateObjExported.month - 1, dateObjExported.day, dateObjExported.hour, dateObjExported.minute, dateObjExported.second) / 1000
      );
      
      // Step 6: Export direct trips (no wrapper), with metadata on the side
      // Note: Exported format matches merged JSON for merge-script compatibility
      const exportedData = exportedRecordedData;
      const exportFilename = getLocalDateString(Date.now(), TIMEZONE);
      
      console.log(`[RT Recorder] Exported ${Object.keys(exportedData).length} trips, ${Object.values(exportedData).reduce((sum, trip) => sum + Object.keys(trip.stops).length, 0)} stops (${TIMEZONE} time)`);
      
      // Step 7: Download as JSON
      const dataStr = JSON.stringify(exportedData, null, 2);
      const blob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      
      const a = document.createElement('a');
      a.href = url;
      a.download = `${exportFilename}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      console.log('[RT Recorder] Downloaded recorded data');
    } catch (err) {
      console.error('[RT Recorder] Error during export:', err);
      alert('Error exporting data: ' + err.message);
    }
  }
  
  // Check if 24 hours have elapsed and auto-export if needed
  function checkAndExport24Hours() {
    if (!isRecording || !recordingStartTimeMs) return;
    
    const elapsedMs = Date.now() - recordingStartTimeMs;
    if (elapsedMs >= RECORDING_DURATION_MS) {
      console.log('[RT Recorder] 24 hours elapsed, triggering auto-export...');
      downloadRecordedData();
      // Note: Auto-export does not clear data; use manual stop/clear if desired
    }
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
  
  // View Recordings button
  const viewRecordingsBtn = document.getElementById('viewRecordingsBtn');
  if (viewRecordingsBtn) {
    viewRecordingsBtn.addEventListener('click', () => {
      if (typeof RTRecordingViewer !== 'undefined') {
        RTRecordingViewer.open();
      } else {
        console.error('RTRecordingViewer not loaded');
      }
    });
  }
  
  // Initialize UI
  updateRecorderUI();
  
  // ============================================================================
  // EXPOSE VARIABLES FOR DEBUG (Debug.js access)
  // ============================================================================
  window._TTC_DEBUG = {
    gtfsData,
    activeFilter,
    recordedData,
    isValidArrivalTime
  };
})();
