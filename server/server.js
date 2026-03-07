const express = require("express");
const cors = require("cors");
const GtfsRealtimeBindings = require("gtfs-realtime-bindings");

const app = express();
app.use(cors()); // allow your frontend to call this server

const PORT = process.env.PORT || 3000;

// Cache for GTFS-RT data (realtime vehicle positions)
let cachedFeed = null;
let lastFetch = 0;
const CACHE_TTL_MS = 10_000; // 10 seconds

// Retry configuration
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 500;

// Fetch GTFS-RT data with retry logic
async function fetchGtfsRtData() {
  let lastError;
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch("https://bustime.ttc.ca/gtfsrt/vehicles");
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

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await prewarmCache();
});