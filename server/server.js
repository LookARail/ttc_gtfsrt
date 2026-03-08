const express = require("express");
const cors = require("cors");
const GtfsRealtimeBindings = require("gtfs-realtime-bindings");

const app = express();
app.use(cors()); // allow your frontend to call this server
app.use(express.json()); // parse JSON request bodies

const PORT = process.env.PORT || 3000;
const GITHUB_REPO = process.env.GITHUB_REPO;

// Validate required environment variables
if (!GITHUB_REPO) {
  console.warn("⚠️  GITHUB_REPO environment variable not set!");
  console.warn("   Set it to 'username/GTFSRT' in Render Dashboard → Environment");
  console.warn("   Trip recording will work but scheduled times won't load.");
}

// Cache for GTFS-RT data (realtime vehicle positions)
let cachedFeed = null;
let lastFetch = 0;
const CACHE_TTL_MS = 10_000; // 10 seconds

// Cache for GTFS-RT trip updates
let cachedTripUpdates = null;
let lastTripUpdatesFetch = 0;
const TRIP_UPDATES_CACHE_TTL_MS = 60_000; // 60 seconds

// RT Trip Recording storage
let recordedData = {}; // { tripId: { rid, vid, stops: { stopSeq: { sid, seq, arr, sch_arr, sch_dep } } } }
let scheduledTimesCache = {}; // { tripId: { stopSeq: { sch_arr, sch_dep } } }
let seenTripIds = new Set();
let pendingRoutesToLoad = new Set();
let loadingRoutes = new Set();

// Retry configuration
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 500;

// Fetch GTFS-RT data with retry logic
async function fetchGtfsRtData() {
  let lastError;
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Add 5-second timeout to fetch
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch("https://bustime.ttc.ca/gtfsrt/vehicles", {
        signal: controller.signal
      });
      clearTimeout(timeout);
      
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      
      const buffer = await response.arrayBuffer();
      const uint8Array = new Uint8Array(buffer);
      const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(uint8Array);
      
      return feed;
    } catch (err) {
      lastError = err;
      console.warn(`Attempt ${attempt}/${MAX_RETRIES} failed:`, err.message);
      
      if (attempt < MAX_RETRIES) {
        // Exponential backoff: 500ms, 1000ms, 2000ms
        const delayMs = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        console.log(`Retrying in ${delayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  
  throw lastError;
}

// Fetch GTFS-RT trip updates with retry logic
async function fetchTripUpdates() {
  let lastError;
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Add 5-second timeout to fetch
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch("https://bustime.ttc.ca/gtfsrt/trips", {
        signal: controller.signal
      });
      clearTimeout(timeout);
      
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      
      const buffer = await response.arrayBuffer();
      const uint8Array = new Uint8Array(buffer);
      const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(uint8Array);
      
      return feed;
    } catch (err) {
      lastError = err;
      console.warn(`Trip updates attempt ${attempt}/${MAX_RETRIES} failed:`, err.message);
      
      if (attempt < MAX_RETRIES) {
        // Exponential backoff: 500ms, 1000ms, 2000ms
        const delayMs = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        console.log(`Retrying in ${delayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  
  throw lastError;
}

// Load and extract scheduled times for a route
async function loadAndExtractScheduledTimes(routeId) {
  if (loadingRoutes.has(routeId)) return;
  
  if (!GITHUB_REPO) {
    console.warn(`[RT Recorder] Cannot load route ${routeId}: GITHUB_REPO not set`);
    pendingRoutesToLoad.delete(routeId);
    return;
  }
  
  loadingRoutes.add(routeId);
  console.log(`[RT Recorder] Loading route ${routeId}...`);
  
  try {
    const response = await fetch(`https://raw.githubusercontent.com/${GITHUB_REPO}/main/data/stop_times_${routeId}.json`);
    if (!response.ok) {
      console.warn(`[RT Recorder] Failed to load route ${routeId}: HTTP ${response.status}`);
      pendingRoutesToLoad.delete(routeId);
      loadingRoutes.delete(routeId);
      return;
    }
    
    const stopTimesData = await response.json();
    
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
    
    console.log(`[RT Recorder] ✓ Route ${routeId} loaded: ${tripsExtracted} trips`);
    
    // Pre-populate all scheduled stops for trips in recordedData that match this route
    for (const tripId in recordedData) {
      const trip = recordedData[tripId];
      if (trip.rid === routeId && scheduledTimesCache[tripId]) {
        for (const stopSeq in scheduledTimesCache[tripId]) {
          const seq = parseInt(stopSeq);
          const scheduled = scheduledTimesCache[tripId][seq];
          
          if (!trip.stops[seq]) {
            const stopData = stopTimesData[tripId]?.find(s => s.seq === seq);
            if (stopData) {
              trip.stops[seq] = {
                sid: stopData.sid,
                seq: seq,
                arr: null,
                sch_arr: scheduled.sch_arr,
                sch_dep: scheduled.sch_dep
              };
            }
          } else {
            if (!trip.stops[seq].sch_arr) trip.stops[seq].sch_arr = scheduled.sch_arr;
            if (!trip.stops[seq].sch_dep) trip.stops[seq].sch_dep = scheduled.sch_dep;
          }
        }
      }
    }
    
    pendingRoutesToLoad.delete(routeId);
    loadingRoutes.delete(routeId);
  } catch (err) {
    console.error(`[RT Recorder] Error loading route ${routeId}:`, err.message);
    pendingRoutesToLoad.delete(routeId);
    loadingRoutes.delete(routeId);
  }
}

// Process trip updates and record stop arrivals
async function processTripUpdates(tripUpdatesFeed) {
  if (!tripUpdatesFeed || !tripUpdatesFeed.entity) return;
  
  // Phase 1: Identify new trips and queue routes for loading
  for (const entity of tripUpdatesFeed.entity) {
    if (!entity.tripUpdate) continue;
    
    const tripId = entity.tripUpdate.trip?.tripId;
    const routeId = entity.tripUpdate.trip?.routeId;
    const vehicleId = entity.tripUpdate.vehicle?.id;
    
    if (!tripId || !routeId) continue;
    
    // Track new trips
    if (!seenTripIds.has(tripId)) {
      seenTripIds.add(tripId);
      if (!scheduledTimesCache[tripId] && !pendingRoutesToLoad.has(routeId) && !loadingRoutes.has(routeId)) {
        pendingRoutesToLoad.add(routeId);
      }
    }
  }
  
  // Phase 2: Load up to 30 routes per cycle
  const routesToLoadNow = Array.from(pendingRoutesToLoad).slice(0, 30);
  if (routesToLoadNow.length > 0) {
    console.log(`[RT Recorder] Loading ${routesToLoadNow.length} routes...`);
    await Promise.all(routesToLoadNow.map(rid => loadAndExtractScheduledTimes(rid)));
  }
  
  // Phase 3: Record stops with scheduled times from cache
  for (const entity of tripUpdatesFeed.entity) {
    if (!entity.tripUpdate) continue;
    
    const tripId = entity.tripUpdate.trip?.tripId;
    const routeId = entity.tripUpdate.trip?.routeId;
    const vehicleId = entity.tripUpdate.vehicle?.id;
    
    if (!tripId || !routeId) continue;
    
    // Initialize trip record if needed
    if (!recordedData[tripId]) {
      recordedData[tripId] = {
        rid: routeId,
        vid: vehicleId || null,
        stops: {}
      };
    }
    
    // Record stop arrivals
    for (const stu of entity.tripUpdate.stopTimeUpdate || []) {
      const stopSeq = stu.stopSequence;
      const stopId = stu.stopId;
      const arrivalTime = stu.arrival?.time || stu.departure?.time;
      
      if (!stopSeq || !arrivalTime) continue;
      
      if (!recordedData[tripId].stops[stopSeq]) {
        const scheduled = scheduledTimesCache[tripId]?.[stopSeq];
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
}

app.get("/vehicles", async (req, res) => {
  try {
    const now = Date.now();
    
    // Return cached data if still fresh
    if (cachedFeed && (now - lastFetch) < CACHE_TTL_MS) {
      res.setHeader("Content-Type", "application/json");
      return res.json(cachedFeed);
    }
    
    // Fetch fresh data from TTC with retry logic
    cachedFeed = await fetchGtfsRtData();
    lastFetch = now;
    
    res.setHeader("Content-Type", "application/json");
    res.json(cachedFeed);
  } catch (err) {
    console.error("Failed to fetch GTFS-RT data:", err);
    res.status(500).send("Error fetching TTC feed");
  }
});

app.get("/trip-updates", async (req, res) => {
  try {
    const now = Date.now();
    
    // Return cached data if still fresh
    if (cachedTripUpdates && (now - lastTripUpdatesFetch) < TRIP_UPDATES_CACHE_TTL_MS) {
      res.setHeader("Content-Type", "application/json");
      return res.json(cachedTripUpdates);
    }
    
    // Fetch fresh data from TTC with retry logic
    cachedTripUpdates = await fetchTripUpdates();
    lastTripUpdatesFetch = now;
    
    // Process for recording (non-blocking)
    processTripUpdates(cachedTripUpdates).catch(err => {
      console.error("[RT Recorder] Error processing trip updates:", err);
    });
    
    res.setHeader("Content-Type", "application/json");
    res.json(cachedTripUpdates);
  } catch (err) {
    console.error("Failed to fetch GTFS-RT trip updates:", err);
    res.status(500).send("Error fetching TTC trip updates");
  }
});

// Export recorded trip data
app.get("/export-trip-data", (req, res) => {
  const exportData = {
    recordedData,
    scheduledTimesCache,
    exportedAt: Date.now(),
    stats: {
      totalTrips: Object.keys(recordedData).length,
      totalStops: Object.values(recordedData).reduce((sum, trip) => sum + Object.keys(trip.stops).length, 0),
      seenTrips: seenTripIds.size,
      cachedRoutes: new Set(Object.values(recordedData).map(t => t.rid)).size
    }
  };
  
  console.log(`[RT Recorder] Exported ${exportData.stats.totalTrips} trips, ${exportData.stats.totalStops} stops`);
  res.json(exportData);
});

// Clear recorded trip data
app.post("/clear-trip-data", (req, res) => {
  const stats = {
    tripsCleared: Object.keys(recordedData).length,
    stopsCleared: Object.values(recordedData).reduce((sum, trip) => sum + Object.keys(trip.stops).length, 0)
  };
  
  recordedData = {};
  scheduledTimesCache = {};
  seenTripIds.clear();
  pendingRoutesToLoad.clear();
  loadingRoutes.clear();
  
  // Force garbage collection if available
  if (global.gc) {
    global.gc();
    console.log("[RT Recorder] Garbage collection triggered");
  }
  
  console.log(`[RT Recorder] Cleared ${stats.tripsCleared} trips, ${stats.stopsCleared} stops`);
  res.json({
    status: 'cleared',
    timestamp: Date.now(),
    ...stats
  });
});

// Pre-warm GTFS-RT cache on startup
async function prewarmCache() {
  try {
    console.log("Pre-warming GTFS-RT cache...");
    cachedFeed = await fetchGtfsRtData();
    lastFetch = Date.now();
    console.log("GTFS-RT cache pre-warmed successfully");
  } catch (err) {
    console.error("Failed to pre-warm GTFS-RT cache:", err);
  }
}

async function main() {
  // Pre-warm cache BEFORE starting server
  await prewarmCache();
  
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log("[RT Recorder] Starting background trip recording...");
  });
  
  // Background trip recording - fetch and process every 60 seconds
  setInterval(async () => {
    try {
      const tripUpdates = await fetchTripUpdates();
      await processTripUpdates(tripUpdates);
    } catch (err) {
      console.error("[RT Recorder] Background processing error:", err.message);
    }
  }, 60_000); // 60 seconds
}

main().catch(err => {
  console.error("Failed to start server:", err);
  process.exit(1);
});