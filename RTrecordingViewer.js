// RT Recording Viewer
// Opens in a new popup window to analyze recorded trip data

(function() {
  'use strict';

  // GitHub configuration - can be overridden by runtime config
  const GITHUB_REPO = (window.APP_CONFIG && window.APP_CONFIG.githubRepo) || "";
  const GITHUB_BRANCH = (window.APP_CONFIG && window.APP_CONFIG.githubBranch) || "main";
  const GITHUB_RAW_BASE = GITHUB_REPO ? `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}` : "";

  const TIME_ZONE = (window.APP_CONFIG && window.APP_CONFIG.timeZone) || 'UTC';
  const MAP_CONFIG = (window.APP_CONFIG && window.APP_CONFIG.map) || { center: [43.65, -79.38], zoom: 11 };
  let TOP_N_ROUTES = 10; // Customizable via UI - this is the source of truth
  let viewerWindow = null;
  let currentData = null;
  let stopsData = null;
  let routesData = null;
  let selectedRouteIds = new Set();
  let timeFilterStart = null;
  let timeFilterEnd = null;
  let timeFilterBaseDay = null; // epoch seconds of base day used for extended time display
  let timeFilterStartEpoch = null; // computed epoch start after applying base day
  let timeFilterEndEpoch = null;
  let processedData = {
    tripSummaries: [],
    stopDeltas: [],
    stopDeltasByTrip: {},
    routeStats: {},
    stopStats: {},
    routeAggregations: [],
    stopAggregations: [],
    tripsByRoute: {},       // routeId -> [tripSummaries]
    tripsByShape: {}        // shapeId -> [tripSummaries]
  };

  // ============================================================================
  // CHART INSTANCES (initialized once)
  // ============================================================================

  let routeChart = null;
  let busiestRoutesChart = null;
  let stopChart = null;
  let hourlyDelayChart = null;
  let heatmapLayer = null;
  let leafletMap = null;
  let mapInitialized = false;
  let cachedHeatmapPoints = null;
  let segmentsCache = {}; // Global cache for segments: key = "fromStopId_toStopId" -> Segment object

  // ============================================================================
  // TIMEZONE & FORMATTING UTILITIES
  // ============================================================================

  // Note: scheduledTimeToEpoch is no longer needed.
  // Both arr and sch_arr are now in epoch seconds (Toronto timezone).

  function formatDuration(seconds) {
    if (seconds === null || seconds === undefined) return 'N/A';
    
    const absSeconds = Math.abs(seconds);
    const hrs = Math.floor(absSeconds / 3600);
    const mins = Math.floor((absSeconds % 3600) / 60);
    const secs = Math.floor(absSeconds % 60);
    
    const sign = seconds >= 0 ? '+' : '-';
    return `${sign}${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  // Convert epoch seconds to extended HH:MM:SS where hours may be >= 24 using baseDay
  function convertEpochToExtendedTime(epochSeconds, baseDay) {
    if (epochSeconds == null || baseDay == null) return '';
    const delta = Math.max(0, Math.floor(epochSeconds - baseDay));
    const hrs = Math.floor(delta / 3600);
    const mins = Math.floor((delta % 3600) / 60);
    const secs = Math.floor(delta % 60);
    return `${String(hrs).padStart(2,'0')}:${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
  }

  // Format epoch seconds as either HH:MM:SS (hours possibly >=24) or D+HH:MM:SS when crossing days
  function formatEpochWithDayPrefix(epochSeconds, baseDay) {
    if (epochSeconds == null || baseDay == null) return '';
    const delta = Math.max(0, Math.floor(epochSeconds - baseDay));
    const days = Math.floor(delta / 86400);
    const rem = delta % 86400;
    const hrs = Math.floor(rem / 3600);
    const mins = Math.floor((rem % 3600) / 60);
    const secs = Math.floor(rem % 60);
    const timeStr = `${String(hrs).padStart(2,'0')}:${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
    if (days > 0) return `${days}+${timeStr}`;
    return timeStr;
  }

  // Check if arrival time is valid (numeric, not "skip" or other non-numeric values)
  function isValidArrivalTime(arr) {
    // TODO: Future enhancement - track skipped stops for statistics
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

  // Normalize data structure: handle both old (wrapped) and new (direct) formats
  function normalizeRecordedData(data) {
    // If data already has recordedData property, it's old format
    if (data.recordedData) {
      return {
        recordedData: data.recordedData,
        scheduledTimesCache: data.scheduledTimesCache || {},
        source: data.source,
        date: data.date
      };
    }
    // If data is an object with trip keys (starts with numbers/strings), assume new format (direct trips)
    // Check if the object looks like trip data: has properties that look like trip IDs with 'rid' and 'stops'
    const keys = Object.keys(data);
    if (keys.length > 0 && keys.some(k => data[k] && data[k].rid && data[k].stops)) {
      console.log('[Viewer] Detected new JSON format (direct trips, no wrapper)');
      return {
        recordedData: data,
        scheduledTimesCache: {},
        source: data.source || 'unknown',
        date: data.date || 'unknown'
      };
    }
    // Otherwise, assume it's old format with recordedData
    return {
      recordedData: data.recordedData || {},
      scheduledTimesCache: data.scheduledTimesCache || {},
      source: data.source,
      date: data.date
    };
  }

  // Parse extended time string HH:MM or HH:MM:SS (hours may be >=24) to seconds offset
  function parseExtendedTimeToOffset(s) {
    if (!s || typeof s !== 'string') return null;
    const parts = s.trim().split(':').map(p => Number(p));
    if (parts.length < 2) return null;
    const hrs = Number.isFinite(parts[0]) ? parts[0] : null;
    const mins = Number.isFinite(parts[1]) ? parts[1] : 0;
    const secs = parts.length >= 3 && Number.isFinite(parts[2]) ? parts[2] : 0;
    if (hrs === null || isNaN(hrs) || isNaN(mins) || isNaN(secs)) return null;
    return Math.floor(hrs) * 3600 + Math.floor(mins) * 60 + Math.floor(secs);
  }

  // Time slider helper functions (30-minute increments)
  const TIME_SLOT_SECONDS = 30 * 60; // 30 minutes in seconds

  function secondsToSliderValue(seconds, baseDay) {
    if (seconds === null || seconds === undefined || baseDay === null || baseDay === undefined) return 0;
    const offsetSeconds = Math.max(0, Math.floor(seconds - baseDay));
    return Math.floor(offsetSeconds / TIME_SLOT_SECONDS);
  }

  function sliderValueToSeconds(sliderValue, baseDay) {
    if (baseDay === null || baseDay === undefined) return null;
    return baseDay + (Math.floor(sliderValue) * TIME_SLOT_SECONDS);
  }

  function secondsToDisplayTime(seconds, baseDay) {
    if (seconds === null || baseDay === null) return '--:--';
    const offsetSeconds = Math.max(0, Math.floor(seconds - baseDay));
    const hours = Math.floor(offsetSeconds / 3600);
    const minutes = Math.floor((offsetSeconds % 3600) / 60);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }

  // ============================================================================
  // DATA LOADING
  // ============================================================================

  async function loadStopsData() {
    if (stopsData) return stopsData;
    if (!GITHUB_RAW_BASE) {
      console.warn('[Viewer] githubRepo not configured — skipping stops data load');
      return {};
    }

    try {
      const response = await fetch(`${GITHUB_RAW_BASE}/data/stops.json`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      stopsData = await response.json();
      return stopsData;
    } catch (err) {
      console.error('Failed to load stops data from GitHub:', err);
      return {};
    }
  }

  async function loadRoutesData() {
    if (routesData) return routesData;
    if (!GITHUB_RAW_BASE) {
      console.warn('[Viewer] githubRepo not configured — skipping routes data load');
      return {};
    }

    try {
      const response = await fetch(`${GITHUB_RAW_BASE}/data/routes.json`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      routesData = await response.json();
      return routesData;
    } catch (err) {
      console.error('Failed to load routes data from GitHub:', err);
      return {};
    }
  }

  async function scanAvailableRecordings() {
    if (!GITHUB_RAW_BASE) {
      console.warn('[Viewer] githubRepo not configured — skipping scan for GitHub recordings');
      return [];
    }
    const available = [];
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1); // Start from tomorrow
    
    // Scan in batches of 10, going backwards from tomorrow
    for (let batchStart = 0; batchStart < 60; batchStart += 10) {
      const batchPromises = [];
      const batchDates = [];
      
      for (let i = 0; i < 10; i++) {
        const dayOffset = batchStart + i;
        const date = new Date(tomorrow);
        date.setDate(date.getDate() - dayOffset);
        const dateStr = date.toISOString().split('T')[0];
        
        batchDates.push(dateStr);
        batchPromises.push(
          fetch(`${GITHUB_RAW_BASE}/recordedRTData/${dateStr}.json`, { method: 'HEAD' })
            .then(resp => resp.ok ? dateStr : null)
            .catch(() => null)
        );
      }
      
      const results = await Promise.all(batchPromises);
      const foundInBatch = results.filter(r => r !== null);
      available.push(...foundInBatch);
      
      // Stop if entire batch is empty
      if (foundInBatch.length === 0) {
        console.log(`[Viewer] No recordings found in batch ${batchStart}-${batchStart + 9}, stopping scan`);
        break;
      }
    }
    
    return available.sort().reverse(); // Newest first
  }

  // NOTE: in-memory "Current Recording" support removed; use GitHub or file sources.

  async function loadFromGitHub(dateStr) {
    if (!GITHUB_RAW_BASE) {
      throw new Error('No GitHub repo configured (githubRepo missing in config.json). Cannot load recordings from GitHub.');
    }

    const response = await fetch(`${GITHUB_RAW_BASE}/recordedRTData/${dateStr}.json`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    const normalized = normalizeRecordedData(data);
    return {
      ...normalized,
      source: 'github',
      date: dateStr
    };
  }

  async function loadFromFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = JSON.parse(e.target.result);
          // Handle both old format (wrapped in recordedData) and new format (direct trips)
          const normalized = normalizeRecordedData(data);
          if (!normalized.recordedData || Object.keys(normalized.recordedData).length === 0) {
            reject(new Error('Invalid file format: no recordedData or trip records found'));
            return;
          }
          resolve({
            ...normalized,
            source: 'file',
            filename: file.name
          });
        } catch (err) {
          reject(new Error('Invalid JSON file'));
        }
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsText(file);
    });
  }

  // ============================================================================
  // DATA PROCESSING
  // ============================================================================

  function processData(data) {
    console.log('[Viewer] processData called with:', { data, dataKeys: data ? Object.keys(data) : 'data is null/undefined' });
    
    if (!data || typeof data !== 'object') {
      console.error('[Viewer] ERROR: processData received invalid data:', { type: typeof data, value: data });
      throw new Error('Invalid data object passed to processData');
    }
    
    // Normalize the data structure to handle both old and new formats
    const normalized = normalizeRecordedData(data);
    const recordedData = normalized.recordedData;
    const scheduledTimesCache = normalized.scheduledTimesCache || {};
    
    if (!recordedData || typeof recordedData !== 'object' || Object.keys(recordedData).length === 0) {
      console.error('[Viewer] ERROR: recordedData is missing or empty:', { recordedData, dataKeys: Object.keys(data).slice(0, 10) });
      throw new Error('Missing recordedData in data object');
    }
    
    console.log('[Viewer] Processing data:', {
      tripCount: Object.keys(recordedData).length,
      hasCacheData: Object.keys(scheduledTimesCache).length > 0
    });
    
    const tripSummaries = [];
    const stopDeltas = []; // Keep flat array for backward compatibility
    const stopDeltasByTrip = {}; // tripId -> [stopDeltas]
    const routeStats = {}; // routeId -> { delaySum, delayCount, tripHours, tripCount, delays }
    const stopStats = {}; // stopId -> { incDelaySum, incDelayCount, recordCount, delays }
    let debugSampleShown = false;
    
    // FIRST PASS: Process each trip, build stopDeltasByTrip and collect raw data
    for (const tripId in recordedData) {
      const trip = recordedData[tripId];
      let maxDelay = null;
      const tripStopDeltas = []; // Store stops for this trip to compute incremental delays
      let firstRecordedTime = null;
      let lastRecordedTime = null;
      
      // Process each stop in the trip
      for (const stopSeq in trip.stops) {
        const stop = trip.stops[stopSeq];
        
        // Skip if no valid actual arrival time (including arr="skip")
        if (!isValidArrivalTime(stop.arr)) {
          // TODO: Future - track trips with skipped stops for statistics
          continue;
        }
        
        // Get scheduled arrival time (already in epoch seconds)
        const scheduledEpoch = stop.sch_arr || stop.sch_dep;
        // Also capture recorded (actual) times for this trip
        // At this point, stop.arr is guaranteed to be valid by isValidArrivalTime() check
        const actualEpoch = stop.arr;
        if (actualEpoch) {
          if (firstRecordedTime === null || actualEpoch < firstRecordedTime) firstRecordedTime = actualEpoch;
          if (lastRecordedTime === null || actualEpoch > lastRecordedTime) lastRecordedTime = actualEpoch;
        }
        if (!scheduledEpoch) {
          const stopDelta = {
            tripId,
            routeId: trip.rid,
            stopId: stop.sid,
            stopSeq: stop.seq,
            delta: null, // No scheduled data
            incrementalDelay: null,
            scheduledEpoch: null
          };
          stopDeltas.push(stopDelta);
          tripStopDeltas.push(stopDelta);
          continue;
        }
        
        // Debug first few conversions
        if (!debugSampleShown) {
          console.log('[Viewer] Sample stop delta calculation:', {
            tripId,
            routeId: trip.rid,
            stopSeq,
            actualArrival: stop.arr,
            actualArrivalValid: isValidArrivalTime(stop.arr),
            scheduledArrival: scheduledEpoch
          });
          debugSampleShown = true;
        }
        
        // Calculate delta (positive = late, negative = early)
        let delta = stop.arr - scheduledEpoch;
        delta = normalizeDelay(delta);
        
        const stopDelta = {
          tripId,
          routeId: trip.rid,
          stopId: stop.sid,
          stopSeq: stop.seq,
          delta,
          incrementalDelay: null, // Will be computed after all stops are processed
          scheduledEpoch: scheduledEpoch,
          actualEpoch: stop.arr  // Add actual arrival time for speed calculations
        };
        stopDeltas.push(stopDelta);
        tripStopDeltas.push(stopDelta);
        
        // Track max delay for this trip
        if (maxDelay === null || delta > maxDelay) {
          maxDelay = delta;
        }
      }
      
      // Compute incremental delays for this trip
      // Sort tripStopDeltas by stopSeq to ensure proper order
      tripStopDeltas.sort((a, b) => {
        const seqA = parseInt(a.stopSeq) || 0;
        const seqB = parseInt(b.stopSeq) || 0;
        return seqA - seqB;
      });
      
      let previousValidDelta = null;
      for (const stopDelta of tripStopDeltas) {
        if (stopDelta.delta !== null) {
          // Found a valid delta
          if (previousValidDelta !== null) {
            stopDelta.incrementalDelay = stopDelta.delta - previousValidDelta;
          } else {
            stopDelta.incrementalDelay = stopDelta.delta;
          }
          previousValidDelta = stopDelta.delta;
        } else {
          // No valid delta at this stop
          stopDelta.incrementalDelay = null;
        }
      }
      
      // Store tripStopDeltas in the nested structure for O(1) lookup
      stopDeltasByTrip[tripId] = tripStopDeltas;
      
      // Calculate scheduled duration for this trip
      let scheduledDuration = null;
      let firstScheduledTime = null;
      let lastScheduledTime = null;
      
      // Get stops sorted by sequence
      if (!trip.stops || typeof trip.stops !== 'object') {
        console.warn(`[Viewer] WARNING: trip.stops is invalid for tripId ${tripId}:`, { stops: trip.stops });
        continue;  // Skip this trip if stops data is missing
      }
      
      const sortedStopSeqs = Object.keys(trip.stops).sort((a, b) => {
        const seqA = parseInt(trip.stops[a].seq) || 0;
        const seqB = parseInt(trip.stops[b].seq) || 0;
        return seqA - seqB;
      });
      
      if (sortedStopSeqs.length > 0) {
        // Get first stop's scheduled time (prefer departure, fallback to arrival)
        const firstStop = trip.stops[sortedStopSeqs[0]];
        firstScheduledTime = firstStop.sch_dep || firstStop.sch_arr;
        
        // Get last stop's scheduled time (prefer arrival, fallback to departure)
        const lastStop = trip.stops[sortedStopSeqs[sortedStopSeqs.length - 1]];
        lastScheduledTime = lastStop.sch_arr || lastStop.sch_dep;
        
        if (firstScheduledTime && lastScheduledTime) {
          // Both times are already in epoch seconds (Toronto timezone)
          scheduledDuration = lastScheduledTime - firstScheduledTime;
          // Ensure non-negative duration
          if (scheduledDuration < 0) {
            // This might happen if there's wrapping issues, add 24 hours
            scheduledDuration += 86400;
          }
        }
      }
      
      // Record trip summary (include recorded time range)
      tripSummaries.push({
        tripId,
        routeId: trip.rid,
        vehicleId: trip.vid,
        maxDelay: maxDelay !== null ? maxDelay : null,
        stopCount: Object.keys(trip.stops).length,
        scheduledDuration,
        firstScheduledTime,
        lastScheduledTime,
        firstRecordedTime,
        lastRecordedTime
      });
    }
    
    // SECOND PASS: Pre-compute route and stop statistics for faster aggregation
    for (const stopDelta of stopDeltas) {
      // Accumulate route-level stats
      if (!routeStats[stopDelta.routeId]) {
        routeStats[stopDelta.routeId] = {
          delaySum: 0,
          delayCount: 0,
          tripHours: 0,
          tripCount: 0,
          delays: []
        };
      }
      
      if (stopDelta.delta !== null) {
        routeStats[stopDelta.routeId].delaySum += stopDelta.delta;
        routeStats[stopDelta.routeId].delayCount++;
        routeStats[stopDelta.routeId].delays.push(stopDelta.delta);
      }
      
      // Accumulate stop-level stats
      if (!stopStats[stopDelta.stopId]) {
        stopStats[stopDelta.stopId] = {
          incDelaySum: 0,
          incDelayCount: 0,
          recordCount: 0,
          delays: []
        };
      }
      
      stopStats[stopDelta.stopId].recordCount++;
      if (stopDelta.incrementalDelay !== null) {
        stopStats[stopDelta.stopId].incDelaySum += stopDelta.incrementalDelay;
        stopStats[stopDelta.stopId].incDelayCount++;
        stopStats[stopDelta.stopId].delays.push(stopDelta.incrementalDelay);
      }
    }
    
    // Finalize route stats by adding trip info
    for (const trip of tripSummaries) {
      if (trip.scheduledDuration !== null && routeStats[trip.routeId]) {
        routeStats[trip.routeId].tripHours += trip.scheduledDuration / 3600;
        routeStats[trip.routeId].tripCount++;
      }
    }
    
    console.log('[Viewer] Processing complete:', {
      tripSummaries: tripSummaries.length,
      stopDeltas: stopDeltas.length,
      deltasWithValues: stopDeltas.filter(d => d.delta !== null).length,
      deltasWithIncrementalDelay: stopDeltas.filter(d => d.incrementalDelay !== null).length,
      tripsWithMaxDelay: tripSummaries.filter(t => t.maxDelay !== null).length,
      preComputedRoutes: Object.keys(routeStats).length,
      preComputedStops: Object.keys(stopStats).length,
      sampleTripsWithDelay: tripSummaries.filter(t => t.maxDelay !== null).slice(0, 3).map(t => ({ 
        routeId: t.routeId, 
        maxDelay: t.maxDelay 
      })),
      sampleTripsWithoutDelay: tripSummaries.filter(t => t.maxDelay === null).slice(0, 3).map(t => ({ 
        routeId: t.routeId, 
        stopCount: t.stopCount 
      }))
    });
    
    return { tripSummaries, stopDeltas, stopDeltasByTrip, routeStats, stopStats };
  }

  /**
   * Build trip index maps for efficient lookups during visualization
   * Builds tripsByRoute and tripsByShape indices from tripSummaries
   */
  function buildTripIndexMaps(tripSummaries, gtfsData) {
    const tripsByRoute = {};
    const tripsByShape = {};

    console.log('[Viewer] Building trip index maps for visualization...');

    for (const trip of tripSummaries) {
      // Index by route
      if (!tripsByRoute[trip.routeId]) {
        tripsByRoute[trip.routeId] = [];
      }
      tripsByRoute[trip.routeId].push(trip);

      // Index by shape (from GTFS data)
      const gtfsTrip = gtfsData.trips && gtfsData.trips[trip.tripId];
      if (gtfsTrip && gtfsTrip.shape_id) {
        if (!tripsByShape[gtfsTrip.shape_id]) {
          tripsByShape[gtfsTrip.shape_id] = [];
        }
        tripsByShape[gtfsTrip.shape_id].push(trip);
      }
    }

    console.log('[Viewer] Trip index maps built:', {
      routeCount: Object.keys(tripsByRoute).length,
      shapeCount: Object.keys(tripsByShape).length,
      totalRouteTrips: Object.values(tripsByRoute).reduce((sum, trips) => sum + trips.length, 0),
      totalShapeTrips: Object.values(tripsByShape).reduce((sum, trips) => sum + trips.length, 0)
    });

    return { tripsByRoute, tripsByShape };
  }

  function aggregateByRoute(tripSummaries, selectedRoutes) {
    console.log('[Viewer] Aggregating by route:', {
      totalTrips: tripSummaries.length,
      selectedRoutes: Array.from(selectedRoutes),
      filterActive: selectedRoutes.size > 0,
      sampleTripRouteIds: tripSummaries.slice(0, 5).map(t => ({ id: t.routeId, type: typeof t.routeId })),
      selectedRouteTypes: Array.from(selectedRoutes).slice(0, 5).map(r => ({ id: r, type: typeof r }))
    });
    
    const routeMap = {};
    
    for (const trip of tripSummaries) {
      if (selectedRoutes.size > 0 && !selectedRoutes.has(trip.routeId)) continue;
      if (trip.maxDelay === null) continue;
      
      if (!routeMap[trip.routeId]) {
        routeMap[trip.routeId] = {
          routeId: trip.routeId,
          delays: [],
          tripCount: 0
        };
      }
      
      routeMap[trip.routeId].delays.push(trip.maxDelay);
      routeMap[trip.routeId].tripCount++;
    }
    
    // Calculate averages
    const aggregations = [];
    console.log('[Viewer] About to iterate routeMap:', { routeMapType: typeof routeMap, routeMapKeys: routeMap ? Object.keys(routeMap) : 'N/A' });
    for (const routeId in routeMap) {
      const route = routeMap[routeId];
      const avgDelay = route.delays.reduce((sum, d) => sum + d, 0) / route.delays.length;
      
      aggregations.push({
        routeId,
        avgDelay,
        tripCount: route.tripCount
      });
    }
    
    // Sort by avgDelay descending, take top 10
    aggregations.sort((a, b) => b.avgDelay - a.avgDelay);
    const topRoutes = aggregations.slice(0, 10);
    
    console.log('[Viewer] Route aggregation result:', {
      totalRoutes: aggregations.length,
      top10: topRoutes.map(r => ({ route: r.routeId, avgDelay: r.avgDelay, trips: r.tripCount }))
    });
    
    return topRoutes;
  }

  function aggregateByStop(stopDeltas, selectedRoutes, stopsData) {
    console.log('[Viewer] Aggregating by stop:', {
      totalStopDeltas: stopDeltas.length,
      selectedRoutes: Array.from(selectedRoutes),
      stopsDataLoaded: stopsData && Object.keys(stopsData).length > 0
    });
    
    const stopMap = {};
    
    for (const stop of stopDeltas) {
      if (selectedRoutes.size > 0 && !selectedRoutes.has(stop.routeId)) continue;
      if (stop.incrementalDelay === null) continue;
      
      if (!stopMap[stop.stopId]) {
        stopMap[stop.stopId] = {
          stopId: stop.stopId,
          stopName: stopsData[stop.stopId]?.stop_name || stop.stopId,
          incrementalDelays: []
        };
      }
      
      stopMap[stop.stopId].incrementalDelays.push(stop.incrementalDelay);
    }
    
    // Calculate averages
    const aggregations = [];
    console.log('[Viewer] About to iterate stopMap:', { stopMapType: typeof stopMap, stopMapKeys: stopMap ? Object.keys(stopMap) : 'N/A' });
    for (const stopId in stopMap) {
      const stop = stopMap[stopId];
      const avgIncrementalDelay = stop.incrementalDelays.reduce((sum, d) => sum + d, 0) / stop.incrementalDelays.length;
      
      aggregations.push({
        stopId,
        stopName: stop.stopName,
        avgIncrementalDelay,
        recordCount: stop.incrementalDelays.length
      });
    }
    
    // Sort by avgIncrementalDelay descending, take top 20
    aggregations.sort((a, b) => b.avgIncrementalDelay - a.avgIncrementalDelay);
    const topStops = aggregations.slice(0, 20);
    
    console.log('[Viewer] Stop aggregation result:', {
      totalStops: aggregations.length,
      top20Count: topStops.length
    });
    
    return topStops;
  }

  function aggregateByBusiestRoutes(tripSummaries, selectedRoutes, routeStats) {
    console.log('[Viewer] Aggregating busiest routes by average max delay:', {
      totalTrips: tripSummaries.length,
      selectedRoutes: Array.from(selectedRoutes)
    });
    
    // Build route map with trip max delays (same method as aggregateByRoute)
    const routeMap = {};
    for (const trip of tripSummaries) {
      if (selectedRoutes.size > 0 && !selectedRoutes.has(trip.routeId)) continue;
      if (trip.maxDelay === null) continue;
      
      if (!routeMap[trip.routeId]) {
        routeMap[trip.routeId] = {
          routeId: trip.routeId,
          maxDelays: [],
          tripCount: 0,
          tripHours: routeStats[trip.routeId]?.tripHours || 0
        };
      }
      
      routeMap[trip.routeId].maxDelays.push(trip.maxDelay);
      routeMap[trip.routeId].tripCount++;
    }
    
    // Calculate average of max delays per route
    const aggregations = [];
    for (const routeId in routeMap) {
      const route = routeMap[routeId];
      const avgDelay = route.maxDelays.length > 0 
        ? route.maxDelays.reduce((sum, d) => sum + d, 0) / route.maxDelays.length 
        : 0;
      
      aggregations.push({
        routeId,
        tripHours: route.tripHours,
        tripCount: route.tripCount,
        avgDelay
      });
    }
    
    // Sort by tripHours descending (busiest = most trip-hours), take top 10
    aggregations.sort((a, b) => b.tripHours - a.tripHours);
    const topRoutes = aggregations.slice(0, 10);
    
    console.log('[Viewer] Busiest routes aggregation result:', {
      totalRoutes: aggregations.length,
      top10Count: topRoutes.length,
      top10: topRoutes.map(r => ({ 
        route: r.routeId, 
        tripHours: r.tripHours.toFixed(2), 
        avgMaxDelay: r.avgDelay.toFixed(0) 
      }))
    });
    
    return topRoutes;
  }

  function aggregateHourlyDelayByRoute(stopDeltas, selectedRoutes, routeStats, timeFilterStartEpoch, timeFilterEndEpoch) {
    console.log('[Viewer] Aggregating hourly delay:', {
      totalStopDeltas: stopDeltas.length,
      selectedRoutes: Array.from(selectedRoutes),
      timeRange: { start: timeFilterStartEpoch, end: timeFilterEndEpoch }
    });
    
    // If no time range, return empty
    if (timeFilterStartEpoch === null || timeFilterEndEpoch === null) {
      console.log('[Viewer] No time filter active, skipping hourly aggregation');
      return { series: [], hourLabels: [] };
    }
    
    // Round start down to nearest hour, end up to nearest hour
    const hourStart = Math.floor(timeFilterStartEpoch / 3600) * 3600;
    const hourEnd = Math.ceil(timeFilterEndEpoch / 3600) * 3600;
    const hourCount = Math.max(1, (hourEnd - hourStart) / 3600);
    
    console.log('[Viewer] Hourly aggregation boundaries:', {
      hourStart,
      hourEnd,
      hourCount,
      startEpoch: timeFilterStartEpoch,
      endEpoch: timeFilterEndEpoch
    });
    
    // Get top N routes by trip-hours (same definition as busiest routes)
    const topRoutes = [];
    console.log('[Viewer] About to iterate routeStats for hourly:', { routeStatsType: typeof routeStats, routeStatsKeys: routeStats ? Object.keys(routeStats).length : 'N/A' });
    for (const routeId in routeStats) {
      if (selectedRoutes.size > 0 && !selectedRoutes.has(routeId)) continue;
      const stats = routeStats[routeId];
      if (stats.tripCount > 0) {
        topRoutes.push({
          routeId,
          tripHours: stats.tripHours
        });
      }
    }
    topRoutes.sort((a, b) => b.tripHours - a.tripHours);
    const selectedTopRoutes = topRoutes.slice(0, TOP_N_ROUTES);
    
    console.log('[Viewer] Top routes for hourly chart:', {
      totalRoutes: topRoutes.length,
      selectedCount: selectedTopRoutes.length,
      selected: selectedTopRoutes.map(r => ({ routeId: r.routeId, tripHours: r.tripHours.toFixed(2) }))
    });
    
    // Create bin structure: routeId -> array of hourly buckets
    const bins = {};
    for (const route of selectedTopRoutes) {
      bins[route.routeId] = Array(Math.ceil(hourCount)).fill(null).map(() => ({ sum: 0, count: 0 }));
    }
    
    // Bin all stops by route and hour
    for (const stop of stopDeltas) {
      if (stop.incrementalDelay === null || stop.scheduledEpoch === null) continue;
      if (!bins[stop.routeId]) continue; // Not in top N routes
      
      const hourIndex = Math.floor((stop.scheduledEpoch - hourStart) / 3600);
      if (hourIndex < 0 || hourIndex >= bins[stop.routeId].length) continue; // Outside time range
      
      bins[stop.routeId][hourIndex].sum += stop.incrementalDelay;
      bins[stop.routeId][hourIndex].count++;
    }
    
    // Compute averages and prepare series data
    const series = [];
    const hourStartTimes = [];
    
    // Generate actual epoch times for each hour
    for (let i = 0; i < Math.ceil(hourCount); i++) {
      hourStartTimes.push(hourStart + i * 3600);
    }
    
    // Build series for each selected top route
    for (const route of selectedTopRoutes) {
      const data = bins[route.routeId].map(bucket => {
        if (bucket.count === 0) return null; // Gap for empty buckets
        return bucket.sum / bucket.count;
      });
      
      const routeName = routesData && routesData[route.routeId] ? routesData[route.routeId].route_long_name : null;
      const label = routeName ? `${route.routeId} - ${routeName}` : route.routeId;
      
      series.push({
        label,
        data,
        borderColor: null, // Will be assigned in updateHourlyDelayChart
        backgroundColor: null,
        tension: 0.1,
        fill: false,
        pointRadius: 4,
        pointHoverRadius: 6
      });
    }
    
    console.log('[Viewer] Hourly aggregation complete:', {
      hourCount: Math.ceil(hourCount),
      seriesCount: series.length,
      seriesLabels: series.map(s => s.label)
    });
    
    return { series, hourStartTimes };
  }

  // ============================================================================
  // UI RENDERING
  // ============================================================================

  function openViewer() {
    if (viewerWindow && !viewerWindow.closed) {
      viewerWindow.focus();
      return;
    }
    
    viewerWindow = window.open('RTrecordingViewer.html', 'RTViewer', 'width=1400,height=900,resizable=yes,scrollbars=yes');
    if (!viewerWindow) {
      alert('Failed to open viewer window. Please allow popups for this site.');
      return;
    }
    
    // Wait for window to fully load; no in-memory injection performed
    const checkLoad = setInterval(() => {
      if (viewerWindow.document.readyState === 'complete') {
        clearInterval(checkLoad);
        // Intentionally not injecting parent in-memory recording data (feature removed)
      }
    }, 100);
  }

  function initializeViewer(win) {
    const doc = win.document;
    
    // Initialize charts once (empty data)
    const chartsReady = initializeCharts(doc);
    if (!chartsReady) {
      console.error('[Viewer] Failed to initialize charts');
      // Continue anyway so user can see the error message
    }
    
    // Note: Map is initialized lazily when user first switches to Map View tab
    
    // Get elements
    const dataSourceSelect = doc.getElementById('dataSource');
    const githubDateContainer = doc.getElementById('githubDateSelect');
    const githubDateSelect = doc.getElementById('githubDate');
    const fileUploadContainer = doc.getElementById('fileUpload');
    const fileInput = doc.getElementById('fileInput');
    const loadDataBtn = doc.getElementById('loadDataBtn');
    const loadError = doc.getElementById('loadError');
    const statusBadge = doc.getElementById('statusBadge');
    const viewerContent = doc.getElementById('viewerContent');
    const filterSection = doc.getElementById('filterSection');
    const loadingIndicator = doc.getElementById('loadingIndicator');
    const routeFilter = doc.getElementById('routeFilter');
    const selectAllBtn = doc.getElementById('selectAllRoutes');
    const deselectAllBtn = doc.getElementById('deselectAllRoutes');
    const applyFilterBtn = doc.getElementById('applyFilter');
    const topNRoutesInput = doc.getElementById('topNRoutes');
    
    // Initialize HTML input to match TOP_N_ROUTES constant (constant is source of truth)
    if (topNRoutesInput) {
      topNRoutesInput.value = TOP_N_ROUTES;
      console.log('[Viewer] Top N Routes input initialized to constant:', TOP_N_ROUTES);
    }
    
    // Data source selection (memory option removed)
    dataSourceSelect.addEventListener('change', async (e) => {
      const source = e.target.value;

      githubDateContainer.style.display = 'none';
      fileUploadContainer.style.display = 'none';
      loadDataBtn.disabled = true;
      loadError.style.display = 'none';

      if (source === 'github') {
        githubDateContainer.style.display = 'block';
        githubDateSelect.innerHTML = '<option value="">-- Loading... --</option>';

        try {
          const dates = await scanAvailableRecordings();
          if (dates.length === 0) {
            githubDateSelect.innerHTML = '<option value="">-- No recordings found --</option>';
          } else {
            githubDateSelect.innerHTML = '<option value="">-- Select date --</option>';
            dates.forEach(date => {
              const option = doc.createElement('option');
              option.value = date;
              option.textContent = date;
              githubDateSelect.appendChild(option);
            });
          }
        } catch (err) {
          githubDateSelect.innerHTML = '<option value="">-- Error loading dates --</option>';
          showError(loadError, `Failed to scan recordings: ${err.message}`);
        }
      } else if (source === 'file') {
        fileUploadContainer.style.display = 'block';
      }
    });
    
    githubDateSelect.addEventListener('change', (e) => {
      loadDataBtn.disabled = !e.target.value;
    });
    
    fileInput.addEventListener('change', (e) => {
      loadDataBtn.disabled = !e.target.files || e.target.files.length === 0;
    });
    
    // Load data button
    loadDataBtn.addEventListener('click', async () => {
      const source = dataSourceSelect.value;
      loadError.style.display = 'none';
      loadingIndicator.style.display = 'block';
      viewerContent.style.display = 'none';
      
      try {
        let data;
        
        if (source === 'github') {
          const date = githubDateSelect.value;
          data = await loadFromGitHub(date);
          updateStatusBadge(statusBadge, `Loaded from GitHub: ${date}`, 'info');
        } else if (source === 'file') {
          const file = fileInput.files[0];
          data = await loadFromFile(file);
          updateStatusBadge(statusBadge, `Loaded from file: ${file.name}`, 'info');
        } else {
          throw new Error('No data source selected');
        }
        
        currentData = data;
        
        // Load stops and routes data, then process
        await Promise.all([loadStopsData(), loadRoutesData()]);
        const processed = processData(data);
        processedData.tripSummaries = processed.tripSummaries;
        processedData.stopDeltas = processed.stopDeltas;
        processedData.stopDeltasByTrip = processed.stopDeltasByTrip;
        processedData.routeStats = processed.routeStats;
        processedData.stopStats = processed.stopStats;
        
        // Load GTFS data required for building trip index maps
        let gtfsDataForIndexing = {
          trips: {},
          shapes: {},
          stops: {},
          routes: {},
          shapeRouteMap: {},
          stopTimes: {}
        };
        
        try {
          // Load GTFS trips if not already cached
          if (!window.gtfsTrips) {
            const response = await fetch(`${GITHUB_RAW_BASE}/data/trips.json`);
            if (response.ok) {
              window.gtfsTrips = await response.json();
              console.log(`[Viewer] Loaded ${Object.keys(window.gtfsTrips).length} trips for indexing`);
            }
          }
          gtfsDataForIndexing.trips = window.gtfsTrips || {};
          
          // Build trip index maps (tripsByRoute, tripsByShape) for visualization
          const indexMaps = buildTripIndexMaps(processed.tripSummaries, gtfsDataForIndexing);
          processedData.tripsByRoute = indexMaps.tripsByRoute;
          processedData.tripsByShape = indexMaps.tripsByShape;
        } catch (err) {
          console.warn('[Viewer] Could not build trip index maps:', err);
        }
        
        // Initialize route filter
        initializeRouteFilter(doc, processed.tripSummaries);
        initializeRouteFilter(doc, processed.tripSummaries);
        
        // Initialize Top N Routes textbox to match TOP_N_ROUTES constant
        const topNRoutesInput = doc.getElementById('topNRoutes');
        if (topNRoutesInput) {
          topNRoutesInput.value = TOP_N_ROUTES;
          console.log('[Viewer] Top N Routes textbox set to constant:', TOP_N_ROUTES);
        }
        
        // Setup tab switching
        setupTabSwitching(doc);
        
        // Setup OTP tab responsive height
        setupOtpTabResizeListener(doc);
        
        // Initialize map eagerly ONLY if the map tab is currently active
        // Otherwise, map will be initialized lazily when user clicks the Map tab
        const mapTab = doc.querySelector('.tab[data-tab="map"]');
        const isMapTabActive = mapTab && mapTab.classList.contains('active');
        
        if (isMapTabActive) {
          if (!mapInitialized) {
            const mapReady = initializeMap(doc);
            if (mapReady) {
              mapInitialized = true;
              console.log('[Viewer] Map initialized during data load (Map tab was active)');
            } else {
              console.warn('[Viewer] Failed to initialize map during data load');
            }
          } else {
            // Map already initialized and user is still on the map tab
            // Clear cached visualization data to force a fresh render
            cachedHeatmapPoints = null;
            if (window.subshapesLayer && leafletMap && leafletMap.hasLayer(window.subshapesLayer)) {
              leafletMap.removeLayer(window.subshapesLayer);
              console.log('[Viewer] Cleared stale map visualization for refresh');
            }
          }
        } else {
          console.log('[Viewer] Map initialization deferred (user is not on Map tab)');
        }
        
        // Update time filter range (initially all routes are selected)
        updateTimeFilterRangeFromRouteSelection(doc);
        
        // Render charts with all routes selected (AWAIT to ensure visualization completes)
        try {
          await renderCharts(doc);
          console.log('[Viewer] Initial chart rendering and visualization complete');
        } catch (err) {
          console.error('[Viewer] Error during initial chart rendering:', err);
        }
        
        loadingIndicator.style.display = 'none';
        filterSection.style.display = 'block';
        viewerContent.style.display = 'block';
      } catch (err) {
        loadingIndicator.style.display = 'none';
        showError(loadError, err.message);
      }
    });
    
    // Filter controls
    selectAllBtn.addEventListener('click', () => {
      const checkboxes = doc.querySelectorAll('.route-filter input[type="checkbox"]');
      checkboxes.forEach(cb => cb.checked = true);
      console.log('[Viewer] Select All clicked');
      // Update time filter range based on new selection
      updateTimeFilterRangeFromRouteSelection(doc);
    });
    
    deselectAllBtn.addEventListener('click', () => {
      const checkboxes = doc.querySelectorAll('.route-filter input[type="checkbox"]');
      checkboxes.forEach(cb => cb.checked = false);
      console.log('[Viewer] Deselect All clicked');
      // Update time filter range based on new selection
      updateTimeFilterRangeFromRouteSelection(doc);
    });
    
    // Update time filter when individual checkboxes change
    routeFilter.addEventListener('change', (e) => {
      if (e.target.type === 'checkbox') {
        console.log('[Viewer] Route checkbox changed:', e.target.value, 'checked:', e.target.checked);
        updateTimeFilterRangeFromRouteSelection(doc);
      }
    });
    
    applyFilterBtn.addEventListener('click', async () => {
      const checkboxes = doc.querySelectorAll('.route-filter input[type="checkbox"]:checked');
      selectedRouteIds.clear();
      checkboxes.forEach(cb => selectedRouteIds.add(cb.value));
      
      // Read time filter values from sliders and compute epoch range
      const timeSliderStart = doc.getElementById('timeSliderStart');
      const timeSliderEnd = doc.getElementById('timeSliderEnd');

      if (!timeSliderStart.disabled && !timeSliderEnd.disabled && timeFilterBaseDay != null) {
        const startEpoch = sliderValueToSeconds(parseInt(timeSliderStart.value), timeFilterBaseDay);
        const endEpoch = sliderValueToSeconds(parseInt(timeSliderEnd.value), timeFilterBaseDay);
        
        if (startEpoch != null && endEpoch != null) {
          timeFilterStartEpoch = startEpoch;
          timeFilterEndEpoch = endEpoch;
          // If end is before start, assume it wraps to next day
          if (timeFilterEndEpoch < timeFilterStartEpoch) {
            timeFilterEndEpoch += 86400;
          }
        } else {
          timeFilterStartEpoch = null;
          timeFilterEndEpoch = null;
        }
      } else {
        timeFilterStartEpoch = null;
        timeFilterEndEpoch = null;
      }
      
      console.log('[Viewer] Apply filter clicked:', {
        selectedCount: selectedRouteIds.size,
        selectedRoutes: Array.from(selectedRouteIds),
        timeFilterEpoch: { start: timeFilterStartEpoch, end: timeFilterEndEpoch }
      });
      
      // Show loading indicator
      const loadingIndicator = doc.getElementById('loadingIndicator');
      if (loadingIndicator) {
        loadingIndicator.style.display = 'block';
        console.log('[Viewer] Apply filter loading indicator shown');
      }
      
      // Render charts with current route and time filters
      try {
        console.log('[Viewer] Re-rendering charts with applied filters...');
        await renderCharts(doc);
        console.log('[Viewer] Charts re-rendered with applied filters');
      } catch (err) {
        console.error('[Viewer] Error applying filters:', err);
      } finally {
        if (loadingIndicator) {
          loadingIndicator.style.display = 'none';
          console.log('[Viewer] Apply filter loading indicator hidden');
        }
      }
    });

    // Top N Routes selector - attach change listener (initialization already done earlier)
    if (topNRoutesInput) {
      topNRoutesInput.addEventListener('change', async () => {
        TOP_N_ROUTES = parseInt(topNRoutesInput.value) || 150;
        console.log('[Viewer] Top N Routes changed to:', TOP_N_ROUTES);
        
        // Show loading indicator
        const loadingIndicator = doc.getElementById('loadingIndicator');
        if (loadingIndicator) {
          loadingIndicator.style.display = 'block';
          console.log('[Viewer] Top N Routes loading indicator shown');
        }
        
        // Refresh visualization with new Top N routes (await to ensure completion)
        try {
          console.log('[Viewer] Refreshing visualization with new Top N routes...');
          await renderCharts(doc);
          console.log('[Viewer] Top N Routes visualization refresh complete');
        } catch (err) {
          console.error('[Viewer] Error during Top N Routes refresh:', err);
        } finally {
          if (loadingIndicator) {
            loadingIndicator.style.display = 'none';
            console.log('[Viewer] Top N Routes loading indicator hidden');
          }
        }
      });
    }

    // Time slider listeners - update display when sliders change
    const timeSliderStart = doc.getElementById('timeSliderStart');
    const timeSliderEnd = doc.getElementById('timeSliderEnd');
    const timeDisplayStart = doc.getElementById('timeDisplayStart');
    const timeDisplayEnd = doc.getElementById('timeDisplayEnd');

    if (timeSliderStart && timeDisplayStart) {
      timeSliderStart.addEventListener('input', () => {
        if (timeFilterBaseDay !== null) {
          const startEpoch = sliderValueToSeconds(parseInt(timeSliderStart.value), timeFilterBaseDay);
          timeDisplayStart.textContent = secondsToDisplayTime(startEpoch, timeFilterBaseDay);          
        }
      });
    }

    if (timeSliderEnd && timeDisplayEnd) {
      timeSliderEnd.addEventListener('input', () => {
        if (timeFilterBaseDay !== null) {
          const endEpoch = sliderValueToSeconds(parseInt(timeSliderEnd.value), timeFilterBaseDay);
          timeDisplayEnd.textContent = secondsToDisplayTime(endEpoch, timeFilterBaseDay);
          console.log('[Viewer] Time slider end changed to:', timeDisplayEnd.textContent);
        }
      });
    }
    
    // Refresh Heatmap button
    const refreshHeatmapBtn = doc.getElementById('refreshHeatmapBtn');
    if (refreshHeatmapBtn) {
      refreshHeatmapBtn.addEventListener('click', async () => {
        console.log('[Viewer] Refresh button clicked - triggering visualization refresh...');
        
        // Read current values from UI
        const topNRoutesInput = doc.getElementById('topNRoutes');
        const heatmapMetricSelect = doc.getElementById('heatmapMetric');
        
        if (topNRoutesInput) {
          const newTopN = parseInt(topNRoutesInput.value) || 150;
          if (newTopN !== TOP_N_ROUTES) {
            TOP_N_ROUTES = newTopN;
            console.log('[Viewer] Updated Top N Routes to:', TOP_N_ROUTES);
          }
        }
        
        if (heatmapMetricSelect) {
          const selectedMetric = heatmapMetricSelect.value;
          console.log('[Viewer] Selected metric:', selectedMetric);
          // TODO: Implement metric switching when RTUtil supports multiple metrics
        }
        
        // Show loading indicator
        const loadingIndicator = doc.getElementById('loadingIndicator');
        if (loadingIndicator) {
          loadingIndicator.style.display = 'block';
          console.log('[Viewer] Refresh loading indicator shown');
        }
        
        // Re-render charts with current filters applied (this will refresh the heatmap with time filter)
        try {
          console.log('[Viewer] Refreshing visualization with current filters...');
          await renderCharts(doc);
          console.log('[Viewer] visualization refresh complete');
        } catch (err) {
          console.error('[Viewer] Error during refresh:', err);
        } finally {
          if (loadingIndicator) {
            loadingIndicator.style.display = 'none';
            console.log('[Viewer] Refresh loading indicator hidden');
          }
        }
      });
    }
  }

  function showError(errorEl, message) {
    errorEl.textContent = message;
    errorEl.style.display = 'block';
  }

  // Helper function to convert HTML time input (HH:MM) to epoch seconds offset from midnight
  function convertTimeInputToScheduled(timeInput) {
    const [hours, minutes] = timeInput.split(':').map(Number);
    if (isNaN(hours) || isNaN(minutes)) return 0;
    return hours * 3600 + minutes * 60;
  }
  
  // Helper function to convert epoch seconds offset from midnight to HTML time input (HH:MM)
  function convertScheduledToTimeInput(epochSeconds) {
    if (epochSeconds === null || epochSeconds === undefined) return '';
    const hours = Math.floor(epochSeconds / 3600) % 24;
    const minutes = Math.floor((epochSeconds % 3600) / 60);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
  }
  
  // Update time filter range based on currently checked routes (not selectedRouteIds)
  function updateTimeFilterRangeFromRouteSelection(doc) {
    const timeSliderStart = doc.getElementById('timeSliderStart');
    const timeSliderEnd = doc.getElementById('timeSliderEnd');
    const timeDisplayStart = doc.getElementById('timeDisplayStart');
    const timeDisplayEnd = doc.getElementById('timeDisplayEnd');
    const timeRangeInfo = doc.getElementById('timeRangeInfo');

    if (!processedData.tripSummaries || processedData.tripSummaries.length === 0) {
      timeSliderStart.disabled = true;
      timeSliderEnd.disabled = true;
      if (timeRangeInfo) timeRangeInfo.innerHTML = 'No trips available';
      return;
    }

    // Get currently checked routes (not yet applied)
    const checkedRoutes = new Set();
    const checkboxes = doc.querySelectorAll('.route-filter input[type="checkbox"]:checked');
    checkboxes.forEach(cb => checkedRoutes.add(cb.value));

    // Find min and max recorded times (in epoch seconds) across checked routes
    let minTime = null;
    let maxTime = null;

    for (const trip of processedData.tripSummaries) {
      if (checkedRoutes.size > 0 && !checkedRoutes.has(trip.routeId)) continue;

      if (trip.firstRecordedTime) {
        if (minTime === null || trip.firstRecordedTime < minTime) {
          minTime = trip.firstRecordedTime;
        }
      }

      if (trip.lastRecordedTime) {
        if (maxTime === null || trip.lastRecordedTime > maxTime) {
          maxTime = trip.lastRecordedTime;
        }
      }
    }

    if (minTime !== null && maxTime !== null) {
      timeSliderStart.disabled = false;
      timeSliderEnd.disabled = false;

      // Base day is the midnight epoch of the earliest recorded time
      const baseDay = Math.floor(minTime / 86400) * 86400;
      timeFilterBaseDay = baseDay;

      // Round down minTime to nearest 30-minute increment
      const minSliderValue = secondsToSliderValue(minTime, baseDay);
      // Round up maxTime to nearest 30-minute increment
      const maxTimeRounded = baseDay + Math.ceil((maxTime - baseDay) / TIME_SLOT_SECONDS) * TIME_SLOT_SECONDS;
      const maxSliderValue = secondsToSliderValue(maxTimeRounded, baseDay);

      // Set slider ranges
      timeSliderStart.min = minSliderValue;
      timeSliderStart.max = maxSliderValue;
      timeSliderStart.value = minSliderValue;

      timeSliderEnd.min = minSliderValue;
      timeSliderEnd.max = maxSliderValue;
      timeSliderEnd.value = maxSliderValue;

      // Update display
      timeDisplayStart.textContent = secondsToDisplayTime(minTime, baseDay);
      timeDisplayEnd.textContent = secondsToDisplayTime(maxTimeRounded, baseDay);

      // Update the available range display
      if (timeRangeInfo) {
        const startDisplay = formatEpochWithDayPrefix(minTime, baseDay);
        const endDisplay = formatEpochWithDayPrefix(maxTimeRounded, baseDay);
        timeRangeInfo.innerHTML = `Available range: ${startDisplay} to ${endDisplay}`;
      }
    } else {
      timeSliderStart.disabled = true;
      timeSliderEnd.disabled = true;
      if (timeRangeInfo) timeRangeInfo.innerHTML = 'No valid scheduled times found';
    }
  }
  
  // Update time filter range based on applied selectedRouteIds
  function updateTimeFilterRange(doc) {
    const timeSliderStart = doc.getElementById('timeSliderStart');
    const timeSliderEnd = doc.getElementById('timeSliderEnd');
    const timeDisplayStart = doc.getElementById('timeDisplayStart');
    const timeDisplayEnd = doc.getElementById('timeDisplayEnd');
    const timeRangeInfo = doc.getElementById('timeRangeInfo');
    
    if (!processedData.tripSummaries || processedData.tripSummaries.length === 0) {
      timeSliderStart.disabled = true;
      timeSliderEnd.disabled = true;
      if (timeRangeInfo) timeRangeInfo.innerHTML = 'No trips available';
      return;
    }
    
    // Find min and max scheduled times (in epoch seconds) across selected trips
    let minTime = null;
    let maxTime = null;
    
    for (const trip of processedData.tripSummaries) {
      if (selectedRouteIds.size > 0 && !selectedRouteIds.has(trip.routeId)) continue;
      
      if (trip.firstScheduledTime) {
        if (minTime === null || trip.firstScheduledTime < minTime) {
          minTime = trip.firstScheduledTime;
        }
      }
      
      if (trip.lastScheduledTime) {
        if (maxTime === null || trip.lastScheduledTime > maxTime) {
          maxTime = trip.lastScheduledTime;
        }
      }
    }
    
    if (minTime !== null && maxTime !== null) {
      timeSliderStart.disabled = false;
      timeSliderEnd.disabled = false;
      
      // Compute base day
      const baseDay = Math.floor(minTime / 86400) * 86400;
      timeFilterBaseDay = baseDay;

      // Round down minTime to nearest 30-minute increment
      const minSliderValue = secondsToSliderValue(minTime, baseDay);
      // Round up maxTime to nearest 30-minute increment
      const maxTimeRounded = baseDay + Math.ceil((maxTime - baseDay) / TIME_SLOT_SECONDS) * TIME_SLOT_SECONDS;
      const maxSliderValue = secondsToSliderValue(maxTimeRounded, baseDay);

      // Set slider ranges and default values
      timeSliderStart.min = minSliderValue;
      timeSliderStart.max = maxSliderValue;
      timeSliderStart.value = minSliderValue;

      timeSliderEnd.min = minSliderValue;
      timeSliderEnd.max = maxSliderValue;
      timeSliderEnd.value = maxSliderValue;

      // Update display
      timeDisplayStart.textContent = secondsToDisplayTime(minTime, baseDay);
      timeDisplayEnd.textContent = secondsToDisplayTime(maxTimeRounded, baseDay);

      if (timeRangeInfo) {
        const startDisplay = formatEpochWithDayPrefix(minTime, baseDay);
        const endDisplay = formatEpochWithDayPrefix(maxTimeRounded, baseDay);
        timeRangeInfo.innerHTML = `Available range: ${startDisplay} to ${endDisplay}`;
      }
    } else {
      timeSliderStart.disabled = true;
      timeSliderEnd.disabled = true;
      if (timeRangeInfo) {
        timeRangeInfo.innerHTML = 'No valid scheduled times found';
      }
    }
  }
  
  function setupTabSwitching(doc) {
    const tabs = doc.querySelectorAll('.tab');
    const tabContents = doc.querySelectorAll('.tab-content');
    
    tabs.forEach(tab => {
      tab.addEventListener('click', async () => {
        const targetTab = tab.getAttribute('data-tab');
        
        // Update tab buttons
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        
        // Update tab contents
        tabContents.forEach(content => {
          if (content.id === `${targetTab}Tab`) {
            content.classList.add('active');
          } else {
            content.classList.remove('active');
          }
        });
        
        // If switching to map tab, initialize or refresh map
        if (targetTab === 'map') {
          if (!mapInitialized) {
            const mapReady = initializeMap(doc);
            if (mapReady) {
              mapInitialized = true;
              // If we have data, render the heatmap
              if (processedData.stopDeltas.length > 0) {
                // Show loading indicator while rendering
                const loadingIndicator = doc.getElementById('loadingIndicator');
                if (loadingIndicator) {
                  loadingIndicator.style.display = 'block';
                  console.log('[Viewer] Map tab loading indicator shown');
                }
                
                try {
                  // Re-render with current filters (await to ensure completion)
                  await renderCharts(doc);
                  console.log('[Viewer] Map tab visualization complete');
                } catch (err) {
                  console.error('[Viewer] Error rendering map tab visualization:', err);
                } finally {
                  if (loadingIndicator) {
                    loadingIndicator.style.display = 'none';
                    console.log('[Viewer] Map tab loading indicator hidden');
                  }
                }
              }
            }
          } else if (leafletMap) {
            setTimeout(() => {
              leafletMap.invalidateSize();
            }, 100);
          }
        }
      });
    });
  }

  function updateOtpTabMaxHeight(doc) {
    const otpTab = doc.getElementById('otpTab');
    const header = doc.querySelector('.header');
    const tabs = doc.querySelector('.tabs');
    
    if (!otpTab || !header || !tabs) return;
    
    // Calculate available height
    const headerHeight = header.offsetHeight;
    const tabsHeight = tabs.offsetHeight;
    const topSpacing = headerHeight + tabsHeight;
    const padding = 40; // top and bottom padding (20px each)
    
    // Max height = window height - header - tabs - padding
    const maxHeight = window.innerHeight - topSpacing - padding;
    
    otpTab.style.maxHeight = `${Math.max(300, maxHeight)}px`; // Min 300px to ensure usability
    
    console.log('[Viewer] OTP Tab max-height updated:', {
      windowHeight: window.innerHeight,
      headerHeight,
      tabsHeight,
      maxHeight
    });
  }

  function setupOtpTabResizeListener(doc) {
    // Update on initial load
    updateOtpTabMaxHeight(doc);
    
    // Update on window resize
    window.addEventListener('resize', () => {
      updateOtpTabMaxHeight(doc);
    });
  }
  

  function getHeatLayerOptionsForZoom(zoom) {
    // TUNING GUIDE: Adjust radius/blur vs. zoom here
    const radius = clamp(Math.round(10 + Math.pow(zoom-10, 1.5) * 2.0), 10, 55);
    const blur = clamp(Math.round(radius * 0.85), 8, 45);

    // Slightly reduce opacity at high zoom to avoid full-map saturation.
    const minOpacity = zoom >= 16 ? 0.25 : (zoom >= 14 ? 0.35 : 0.5);

    return {
      radius,
      blur,
      maxZoom: 18,
      max: 1.0,
      minOpacity,
      gradient: {
        0.0: '#ffffff',
        0.2: '#d3d3d3',
        0.4: '#a9a9a9',
        0.6: '#808080',
        0.8: '#404040',
        1.0: '#000000'
      }
    };
  }

  function rebuildHeatLayer() {
    if (!leafletMap || !cachedHeatmapPoints || cachedHeatmapPoints.length === 0) return;
    if (typeof L === 'undefined' || typeof L.heatLayer === 'undefined') return;

    if (heatmapLayer) {
      leafletMap.removeLayer(heatmapLayer);
      heatmapLayer = null;
    }

    heatmapLayer = L.heatLayer(
      cachedHeatmapPoints,
      getHeatLayerOptionsForZoom(leafletMap.getZoom())
    ).addTo(leafletMap);
  }
  
  function addHeatmapLegend(map) {
    // Create a legend control
    const legend = L.control({ position: 'bottomright' });

    legend.onAdd = function() {
      const div = L.DomUtil.create('div', 'heatmap-legend');
      div.style.cssText = `
        background-color: white;
        padding: 12px;
        border-radius: 5px;
        box-shadow: 0 0 15px rgba(0,0,0,0.2);
        font-family: Arial, sans-serif;
        font-size: 12px;
        max-width: 200px;
      `;

      const title = document.createElement('div');
      title.textContent = 'Average Speed (km/h)';
      title.style.fontWeight = 'bold';
      title.style.marginBottom = '8px';
      div.appendChild(title);

      const bins = [
        { range: '< 5', color: '#d32f2f', label: 'Stopped/Very Slow' },
        { range: '5 - 15', color: '#f57c00', label: 'Slow' },
        { range: '15 - 30', color: '#fbc02d', label: 'Normal' },
        { range: '30 - 50', color: '#7cb342', label: 'Good' },
        { range: '≥ 50', color: '#388e3c', label: 'Very Good' }
      ];

      for (const bin of bins) {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.marginBottom = '6px';

        const colorBox = document.createElement('div');
        colorBox.style.cssText = `
          width: 16px;
          height: 16px;
          background-color: ${bin.color};
          border-radius: 2px;
          margin-right: 8px;
          flex-shrink: 0;
        `;

        const label = document.createElement('span');
        label.textContent = `${bin.range} km/h - ${bin.label}`;

        row.appendChild(colorBox);
        row.appendChild(label);
        div.appendChild(row);
      }

      return div;
    };

    legend.addTo(map);
  }
  
  function initializeMap(doc) {
    const mapContainer = doc.getElementById('heatmapContainer');
    if (!mapContainer) {
      console.error('[Viewer] Map container not found!');
      return false;
    }
    
    // Check if Leaflet is loaded
    if (typeof L === 'undefined') {
      console.error('[Viewer] Leaflet library not loaded!');
      mapContainer.innerHTML = '<div class="no-data">Error: Leaflet library failed to load. Please refresh the page.</div>';
      return false;
    }
    
    try {
      // Ensure the container is empty (Leaflet will populate it)
      mapContainer.innerHTML = '';

      // Initialize Leaflet map using configuration
      leafletMap = L.map(mapContainer, {
        center: MAP_CONFIG.center,
        zoom: MAP_CONFIG.zoom || 11,
        preferCanvas: true
      });
      
      // Add CartoDB Positron (greyscale) tile layer for better subshape visibility
      L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png', {
        attribution: '&copy; CartoDB &copy; OpenStreetMap contributors',
        maxZoom: 18
      }).addTo(leafletMap);

      // Rebuild heat when zoom changes to keep it readable at high zoom.
      leafletMap.on('zoomend', () => {
        rebuildHeatLayer();
      });
      
      // Add legend for the heatmap
      addHeatmapLegend(leafletMap);
      
      // Defer a size invalidation to the next tick in case layout just changed (tab switched)
      setTimeout(() => {
        try {
          leafletMap.invalidateSize();
        } catch (e) {
        }
      }, 0);
      return true;
    } catch (err) {
      console.error('[Viewer] Error initializing map:', err);
      return false;
    }
  }
  
  function updateHeatmap(stopDeltas) {
    if (!leafletMap) {
      return;
    }
    
    if (stopDeltas.length === 0) {
      return;
    }
    
    if (!stopsData) {
      return;
    }
    
    // Check if Leaflet.heat is loaded
    if (typeof L.heatLayer === 'undefined') {
      return;
    }
    
    // Aggregate incremental delays by stop
    const stopMap = {};
    
    for (const stop of stopDeltas) {
      if (stop.incrementalDelay === null) continue;
      
      if (!stopMap[stop.stopId]) {
        stopMap[stop.stopId] = {
          stopId: stop.stopId,
          delays: []
        };
      }
      
      stopMap[stop.stopId].delays.push(stop.incrementalDelay);
    }
    
    // Calculate average incremental delay per stop
    const stopAggregations = [];
    for (const stopId in stopMap) {
      const stop = stopMap[stopId];
      const avgDelay = stop.delays.reduce((sum, d) => sum + d, 0) / stop.delays.length;
      
      stopAggregations.push({
        stopId,
        avgIncrementalDelay: avgDelay,
        recordCount: stop.delays.length
      });
    }
    
    if (stopAggregations.length === 0) {
      return;
    }
    
    // Prepare heatmap data points
    const heatmapPoints = [];
    
    // COLOR GRADIENT MECHANISM:
    // ------------------------------------------------------------------------
    // Uses PERCENTILE-based normalization to spread colors meaningfully.
    // This avoids "all red" when most stops have similar delays.
    //
    // Current mapping:
    //   - 10th percentile delay → intensity 0.0 (blue)
    //   - 50th percentile (median) → intensity 0.5 (yellow)
    //   - 90th percentile delay → intensity 1.0 (dark red)
    //
    // Stops below 10th %ile are clamped to blue; above 90th to dark red.
    // This ensures a visible gradient even when delays cluster together.
    
    const delays = stopAggregations.map(s => s.avgIncrementalDelay).sort((a, b) => a - b);
    const p10 = delays[Math.floor(delays.length * 0.10)] || 0;
    const p90 = delays[Math.floor(delays.length * 0.90)] || 0;
    const delayRange = p90 - p10;
    
    for (const stop of stopAggregations) {
      const stopInfo = stopsData[stop.stopId];
      if (!stopInfo || !stopInfo.stop_lat || !stopInfo.stop_lon) {
        continue;
      }
      
      const lat = parseFloat(stopInfo.stop_lat);
      const lon = parseFloat(stopInfo.stop_lon);
      
      if (isNaN(lat) || isNaN(lon)) {
        continue;
      }
      
      // Map delay to intensity using 10th-90th percentile range
      let intensity = 0.5; // default to mid-range
      if (delayRange > 0) {
        intensity = (stop.avgIncrementalDelay - p10) / delayRange;
        intensity = clamp(intensity, 0, 1); // clamp outliers
      }
      
      heatmapPoints.push([lat, lon, intensity]);
    }
    
    if (heatmapPoints.length === 0) {
      return;
    }
    
    // Ensure map has proper size before creating heatmap
    const mapSize = leafletMap.getSize();
    if (mapSize.x === 0 || mapSize.y === 0) {
      setTimeout(() => {
        leafletMap.invalidateSize();
        updateHeatmap(stopDeltas);
      }, 200);
      return;
    }

    try {
      cachedHeatmapPoints = heatmapPoints;
      rebuildHeatLayer();
      
      // Fit map bounds to show all points
      try {
        if (heatmapPoints.length > 0) {
          const bounds = L.latLngBounds(heatmapPoints.map(p => [p[0], p[1]]));
          leafletMap.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 });
        }
      } catch (boundsErr) {
      }
      
      // Final summary log
      console.log(`[Heatmap] Generated heatmap: ${stopAggregations.length} stops aggregated, ${heatmapPoints.length} points plotted, delay range ${(p90 - p10).toFixed(0)}s`);
    } catch (err) {
    }
  }

  /**
   * Visualize top 10 busiest routes with subshapes on the map
   * Calls RTUtil.visualizeTop10BusiestRoutes to generate and render subshapes
   */
  async function visualizeSubshapesForBusiestRoutes(filteredTripSummaries = null) {
    console.log('[DEBUG] ▶️ visualizeSubshapesForBusiestRoutes ENTRY');
    
    // Use filtered trip summaries if provided, otherwise use all trip summaries
    const tripsToVisualize = filteredTripSummaries || processedData.tripSummaries;
    console.log('[DEBUG] Using trip summaries:', {
      filtered: !!filteredTripSummaries,
      count: tripsToVisualize.length,
      allCount: processedData.tripSummaries.length
    });
    
    // Determine the correct document context (popup window or main page)
    console.log('[DEBUG] 🔍 Document context decision:', {
      viewerWindowExists: !!viewerWindow,
      viewerWindowType: viewerWindow ? viewerWindow.constructor.name : 'null',
      mainDocumentExists: !!document,
      mainDocumentBody: !!document.body
    });
    
    const targetDoc = viewerWindow ? viewerWindow.document : document;
    console.log('[DEBUG] ✓ Using document context:', viewerWindow ? 'popup window' : 'main window');
    console.log('[DEBUG] 🔍 Target document state:', {
      body: !!targetDoc.body,
      head: !!targetDoc.head,
      readyState: targetDoc.readyState
    });
    
    // Show loading overlay in the correct document
    console.log('[DEBUG] 📍 Showing loading overlay...');
    const loadingOverlay = showSubshapeLoadingOverlay(targetDoc);
    console.log('[DEBUG] ✅ Loading overlay created:', !!loadingOverlay);

    // CRITICAL: Add a small delay to allow browser to render the overlay before heavy work
    // Without this, the overlay gets rendered and immediately hidden (race condition)
    await new Promise(resolve => setTimeout(resolve, 100));
    console.log('[DEBUG] ⏳ Rendered overlay, proceeding with visualization work...');

    try {
      if (!leafletMap) {
        console.warn('[DEBUG] ❌ Map not initialized, cannot visualize subshapes');
        hideSubshapeLoadingOverlay(loadingOverlay);
        return;
      }

      if (!window.RTUtil || !window.RTUtil.visualizeTop10BusiestRoutes) {
        console.warn('[Viewer] RTUtil not loaded, cannot visualize subshapes');
        hideSubshapeLoadingOverlay(loadingOverlay);
        return;
      }

      if (!processedData || !tripsToVisualize || Object.keys(processedData.routeStats).length === 0) {
        console.warn('[Viewer] No processed data available for subshape visualization');
        hideSubshapeLoadingOverlay(loadingOverlay);
        return;
      }

      // CRITICAL: Reset subshapesLayer on refresh to avoid mixing stale layers
      // Initialize as fresh L.layerGroup() to ensure clean redraw
      if (window.subshapesLayer) {
        try {
          if (leafletMap.hasLayer(window.subshapesLayer)) {
            leafletMap.removeLayer(window.subshapesLayer);
            console.log('[Viewer] Removed stale subshapesLayer from map');
          }
        } catch (e) {
          console.warn('[Viewer] Error removing old subshapesLayer:', e);
        }
      }
      
      // Create fresh layer group for this visualization
      window.subshapesLayer = L.layerGroup();
      console.log('[Viewer] Initialized fresh L.layerGroup() for subshapes visualization');

      console.log('[Viewer] Starting subshape visualization...');

      // Load GTFS data needed for subshape generation
      // This data is loaded from the same GitHub repo as the recorded data
      const gtfsData = {
        trips: {},
        shapes: {},
        stops: {},
        routes: {},
        shapeRouteMap: {},
        stopTimes: {}
      };

      // Load trips data
      if (!window.gtfsTrips) {
        try {
          console.log('[Viewer] Loading GTFS trips data for subshape analysis...');
          const response = await fetch(`${GITHUB_RAW_BASE}/data/trips.json`);
          if (response.ok) {
            window.gtfsTrips = await response.json();
            console.log(`[Viewer] Loaded ${Object.keys(window.gtfsTrips).length} trips`);
          } else {
            console.warn('[Viewer] Could not load trips.json:', response.status);
          }
        } catch (err) {
          console.error('[Viewer] Error loading trips data:', err);
        }
      }
      gtfsData.trips = window.gtfsTrips || {};

      // Load shapes data
      if (!window.gtfsShapes) {
        try {
          console.log('[Viewer] Loading GTFS shapes data for subshape analysis...');
          const response = await fetch(`${GITHUB_RAW_BASE}/data/shapes.json`);
          if (response.ok) {
            window.gtfsShapes = await response.json();
            console.log(`[Viewer] Loaded ${Object.keys(window.gtfsShapes).length} shapes`);
          } else {
            console.warn('[Viewer] Could not load shapes.json:', response.status);
          }
        } catch (err) {
          console.error('[Viewer] Error loading shapes data:', err);
        }
      }
      gtfsData.shapes = window.gtfsShapes || {};

      // Load stops data (reuse existing stopsData if available)
      if (!stopsData || Object.keys(stopsData).length === 0) {
        try {
          console.log('[Viewer] Loading stops data for subshape analysis...');
          await loadStopsData();
        } catch (err) {
          console.error('[Viewer] Error loading stops data:', err);
        }
      }
      gtfsData.stops = stopsData || {};

      // Load routes data (reuse existing routesData if available)
      if (!routesData || Object.keys(routesData).length === 0) {
        try {
          console.log('[Viewer] Loading routes data for subshape analysis...');
          await loadRoutesData();
        } catch (err) {
          console.error('[Viewer] Error loading routes data:', err);
        }
      }
      gtfsData.routes = routesData || {};

      // Load shape-route-map data
      if (!window.gtfsShapeRouteMap) {
        try {
          console.log('[Viewer] Loading GTFS shape-route-map for subshape analysis...');
          const response = await fetch(`${GITHUB_RAW_BASE}/data/shape-route-map.json`);
          if (response.ok) {
            window.gtfsShapeRouteMap = await response.json();
            console.log(`[Viewer] Loaded shape-route-map with ${Object.keys(window.gtfsShapeRouteMap).length} entries`);
          } else {
            console.warn('[Viewer] Could not load shape-route-map.json:', response.status);
          }
        } catch (err) {
          console.error('[Viewer] Error loading shape-route-map:', err);
        }
      }
      gtfsData.shapeRouteMap = window.gtfsShapeRouteMap || {};

      // Build stop_times from recording data for all trips we'll visualize
      // Strategy: Single pass through tripSummaries to:
      // 1. Identify top 10 routes by trip-hours
      // 2. Build maps for efficient lookup
      // 3. For each shape on each top route, select the trip with most stops
      
      console.log('[Viewer] Building stop_times data from recording data...');
      
      // Use pre-built tripsByRoute map (built during data initialization)
      // Identify top N routes by trip-hours for this visualization (using TOP_N_ROUTES)
      const routeMap = {};
      
      for (const routeId in processedData.tripsByRoute) {
        // Filter by selected routes if any are selected
        if (selectedRouteIds.size > 0 && !selectedRouteIds.has(routeId)) continue;
        if (!processedData.routeStats[routeId]) continue;
        routeMap[routeId] = processedData.routeStats[routeId].tripHours || 0;
      }
      
      const topRouteIds = Object.entries(routeMap)
        .sort((a, b) => b[1] - a[1])
        .slice(0, TOP_N_ROUTES)
        .map(entry => entry[0]);

      // Use tripsByRoute from processedData for efficient lookups
      const tripsByRoute = processedData.tripsByRoute;

      // SECOND PASS: For each top route & shape, select the trip with most stops
      // Keep recorded data separate from GTFS namespace
      const recordedStopTimes = {};
      const shapeIdToTripIdMap = {};  // Track which tripId we selected for each shapeId
      
      // DEBUG: Check tripsByRoute structure BEFORE processing
      console.log('[DEBUG] 🔍 tripsByRoute inspection:', {
        topRouteIdsCount: topRouteIds.length,
        sampleRouteId: topRouteIds[0],
        tripsInFirstRoute: tripsByRoute[topRouteIds[0]] ? tripsByRoute[topRouteIds[0]].length : 'NOT FOUND',
        sampleTrip: tripsByRoute[topRouteIds[0]]?.[0] ? {
          keys: Object.keys(tripsByRoute[topRouteIds[0]][0]),
          tripId: tripsByRoute[topRouteIds[0]][0].tripId,
          vehicleId: tripsByRoute[topRouteIds[0]][0].vehicleId,
          routeId: tripsByRoute[topRouteIds[0]][0].routeId,
          stopCount: tripsByRoute[topRouteIds[0]][0].stopCount
        } : 'NO TRIPS'
      });
      
      for (const routeId of topRouteIds) {
        if (!tripsByRoute[routeId]) {
          console.warn(`[DEBUG] ⚠️ tripsByRoute[${routeId}] is missing!`);
          continue;
        }
        
        // Group trips by shape_id
        const shapeMap = {};
        for (const trip of tripsByRoute[routeId]) {
          if (!trip.tripId) {
            console.warn(`[DEBUG] ⚠️ Trip in route ${routeId} has no tripId:`, trip);
            continue;
          }
          const shapeId = gtfsData.trips[trip.tripId]?.shape_id;
          if (!shapeId) continue;
          
          if (!shapeMap[shapeId]) {
            shapeMap[shapeId] = [];
          }
          shapeMap[shapeId].push(trip);
        }
        
        // For each shape, pick trip with most stops
        for (const shapeId in shapeMap) {
          const tripsForShape = shapeMap[shapeId];
          const selectedTrip = tripsForShape.reduce((max, t) => 
            (t.stopCount > max.stopCount) ? t : max
          );
          
          // DEBUG: Check if selectedTrip has tripId
          if (!selectedTrip.tripId) {
            console.error(`[DEBUG] ❌ CRITICAL: selectedTrip for shape ${shapeId} has NO tripId!`, {
              selectedTripKeys: Object.keys(selectedTrip),
              selectedTrip: selectedTrip
            });
          }
          
          // Track which tripId we selected for this shapeId (to avoid rescanning in utility)
          shapeIdToTripIdMap[shapeId] = selectedTrip.tripId;
          
          // Extract stops from recording data and convert to stop_times format
          if (processedData.stopDeltasByTrip[selectedTrip.tripId]) {
            const recordingStops = processedData.stopDeltasByTrip[selectedTrip.tripId];
            const stopTimesArray = recordingStops.map(s => ({
              stop_id: s.stopId,
              stop_sequence: s.stopSeq
            }));
            recordedStopTimes[selectedTrip.tripId] = stopTimesArray;
          }
        }
      }
      
      console.log(`[Viewer] Built stop_times for ${Object.keys(recordedStopTimes).length} trips from recording data`);
      
      // DEBUG: Log details about recordedStopTimes
      console.log('[DEBUG] recordedStopTimes structure:', {
        totalTrips: Object.keys(recordedStopTimes).length,
        sampleTrip: recordedStopTimes[Object.keys(recordedStopTimes)[0]] ? {
          tripId: Object.keys(recordedStopTimes)[0],
          stopCount: recordedStopTimes[Object.keys(recordedStopTimes)[0]].length
        } : 'none',
        allTripsEmpty: Object.keys(recordedStopTimes).every(tid => recordedStopTimes[tid].length === 0)
      });
      
      // DEBUG: Log topRouteIds and shapeIdToTripIdMap
      console.log('[DEBUG] Route selection:', {
        topRouteIds: topRouteIds.slice(0, 5),
        topRouteIdsCount: topRouteIds.length
      });
      
      console.log('[DEBUG] shapeIdToTripIdMap sample:', {
        totalShapes: Object.keys(shapeIdToTripIdMap).length,
        sample: Object.entries(shapeIdToTripIdMap).slice(0, 3).map(([shapeId, tripId]) => ({ shapeId, tripId }))
      });

      console.log('[Viewer] GTFS data prepared:', {
        trips: Object.keys(gtfsData.trips).length,
        shapes: Object.keys(gtfsData.shapes).length,
        stops: Object.keys(gtfsData.stops).length,
        routes: Object.keys(gtfsData.routes).length,
        shapeRouteMap: Object.keys(gtfsData.shapeRouteMap).length,
        recordedStopTimes: Object.keys(recordedStopTimes).length
      });

      // Clear the heatmap layer to show subshapes on top
      if (heatmapLayer) {
        leafletMap.removeLayer(heatmapLayer);
        heatmapLayer = null;
      }
      cachedHeatmapPoints = null;

      // Call the utility function with separate recorded data and shape→trip mapping
      console.log('[DEBUG] 🔧 Calling RTUtil.visualizeTop10BusiestRoutes...');
      console.log('[DEBUG] 📍 BEFORE RTUtil - window.subshapesLayer state:', {
        exists: !!window.subshapesLayer,
        layers: window.subshapesLayer ? window.subshapesLayer.getLayers().length : 'N/A',
        onMap: window.subshapesLayer ? leafletMap.hasLayer(window.subshapesLayer) : 'N/A'
      });
      
      const result = await window.RTUtil.visualizeTop10BusiestRoutes(
        tripsToVisualize,
        processedData.routeStats,
        gtfsData,
        recordedStopTimes,
        leafletMap,
        processedData.stopDeltasByTrip,  // Pass full stop details for speed calculation
        segmentsCache,  // Pass the persistent segments cache (masterSegments)
        TOP_N_ROUTES  // Pass the topN parameter
      );
      console.log('[DEBUG] ✅ RTUtil call returned:', result?.metadata);
      
      // 🔍 SANITY CHECK: Verify shapes were actually added to layer
      if (window.subshapesLayer) {
        const shapeCount = window.subshapesLayer.getLayers().length;
        console.log('[DEBUG] 🔍 Subshapes layer contains', shapeCount, 'visual elements');
        console.log('[DEBUG] 📍 AFTER RTUtil - window.subshapesLayer state:', {
          exists: !!window.subshapesLayer,
          layers: shapeCount,
          onMap: leafletMap.hasLayer(window.subshapesLayer),
          layerType: window.subshapesLayer.constructor.name
        });
        if (shapeCount === 0) {
          console.warn('[DEBUG] ⚠️ WARNING: Subshapes layer is EMPTY! No shapes were rendered!');
          console.warn('[DEBUG] 🔍 Possible causes:');
          console.warn('[DEBUG]    1. RTUtil received empty recordedStopTimes:', Object.keys(recordedStopTimes).length === 0);
          console.warn('[DEBUG]    2. RTUtil received empty topRouteIds:', topRouteIds.length === 0);
          console.warn('[DEBUG]    3. RTUtil didn\'t add layers to window.subshapesLayer');
        }
      } else {
        console.error('[DEBUG] ❌ ERROR: window.subshapesLayer is undefined!');
      }
      
      // Refresh map size and view to ensure layers are visible
      if (leafletMap) {
        try {
          console.log('[Viewer] Refreshing map view...');
          leafletMap.invalidateSize();
          
          // Check if subshapesLayer is on the map
          if (window.subshapesLayer) {
            const hasLayer = leafletMap.hasLayer(window.subshapesLayer);
            console.log('[DEBUG] 🗺️ Subshapes layer on map:', hasLayer);
            
            if (!hasLayer) {
              console.warn('[DEBUG] ⚠️ Subshapes layer not on map! Attempting to re-add...');
              try {
                window.subshapesLayer.addTo(leafletMap);
                console.log('[DEBUG] ✅ Re-added subshapes layer to map');
              } catch (e) {
                console.error('[DEBUG] ❌ Failed to re-add subshapes layer:', e);
              }
            }
          } else {
            console.warn('[DEBUG] ❌ window.subshapesLayer is not defined');
          }
        } catch (e) {
          console.error('[DEBUG] ❌ Error refreshing map:', e);
        }
      }
      
      // Log summary statistics (removed verbose segment details)
      const segmentKeys = Object.keys(segmentsCache);
      console.log(`[DEBUG] 📊 Segments cache: ${segmentKeys.length} total segments built`);

    } catch (err) {
      console.error('[DEBUG] ❌ Error visualizing subshapes:', err);
    } finally {
      // Hide loading overlay
      console.log('[DEBUG] 🔚 Hiding loading overlay...');
      hideSubshapeLoadingOverlay(loadingOverlay);
      console.log('[DEBUG] ⏹️ visualizeSubshapesForBusiestRoutes EXIT');
    }
  }

  function showSubshapeLoadingOverlay(targetDoc) {
    // Use provided document or fallback to global document
    const doc = targetDoc || document;
    console.log('[DEBUG] 📍 showSubshapeLoadingOverlay - using doc:', doc === document ? 'MAIN' : 'POPUP');
    console.log('[DEBUG] 📍 targetDoc provided?', !!targetDoc, '| viewerWindow exists?', !!viewerWindow);
    console.log('[DEBUG] 📍 doc.body exists?', !!doc.body, '| doc.head exists?', !!doc.head);
    
    // Check if document is in valid state
    if (!doc.body) {
      console.error('[DEBUG] ❌ CRITICAL: doc.body is null/undefined! Cannot append overlay!');
      return null;
    }
    
    // Create overlay element
    const overlay = doc.createElement('div');
    overlay.id = 'subshapeLoadingOverlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background-color: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
      pointer-events: auto;
    `;

    // Create spinner (MUST use doc, not global document)
    const spinner = doc.createElement('div');
    spinner.style.cssText = `
      width: 50px;
      height: 50px;
      border: 5px solid rgba(255, 255, 255, 0.3);
      border-top: 5px solid #ffffff;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    `;

    // Add animation (MUST use doc)
    const style = doc.createElement('style');
    style.textContent = `
      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
    `;
    doc.head.appendChild(style);

    // Add loading text (MUST use doc)
    const text = doc.createElement('div');
    text.style.cssText = `
      position: absolute;
      color: white;
      font-size: 14px;
      font-family: Arial, sans-serif;
      margin-top: 80px;
      text-align: center;
    `;
    text.textContent = 'Generating subshapes...';

    overlay.appendChild(spinner);
    overlay.appendChild(text);
    
    try {
      doc.body.appendChild(overlay);
      console.log('[DEBUG] ✅ Loading overlay successfully appended to body');
      console.log('[DEBUG] 📊 Overlay element:', {
        id: overlay.id,
        display: overlay.style.display,
        zIndex: overlay.style.zIndex,
        parentNode: overlay.parentNode ? overlay.parentNode.tagName : 'null'
      });
    } catch (e) {
      console.error('[DEBUG] ❌ ERROR appending overlay to body:', e);
      return null;
    }

    console.log('[Viewer] Loading overlay shown in correct document context');
    return overlay;
  }

  function hideSubshapeLoadingOverlay(overlay) {
    if (overlay && overlay.parentNode) {
      try {
        overlay.parentNode.removeChild(overlay);
        console.log('[DEBUG] ✅ Loading overlay removed from DOM');
      } catch (e) {
        console.error('[DEBUG] ❌ Error removing overlay:', e);
      }
    } else {
      console.warn('[DEBUG] ⚠️ Cannot remove overlay - overlay or parentNode missing', {
        overlayExists: !!overlay,
        hasParent: overlay?.parentNode ? true : false
      });
    }
  }

  // STANDALONE TESTING FUNCTION - can be called from console to test loading blocker
  // Usage: testLoadingBlocker() - will show for 3 seconds then auto-hide
  window.testLoadingBlocker = function(targetDoc = null, durationMs = 3000) {
    const doc = targetDoc || (viewerWindow ? viewerWindow.document : document);
    console.log('[TEST] 📍 testLoadingBlocker - using doc context:', doc === document ? 'MAIN' : 'POPUP', 'for', durationMs, 'ms');
    
    // Create overlay element
    const overlay = doc.createElement('div');
    overlay.id = 'testLoadingOverlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background-color: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
      pointer-events: auto;
    `;

    // Create spinner
    const spinner = doc.createElement('div');
    spinner.style.cssText = `
      width: 50px;
      height: 50px;
      border: 5px solid rgba(255, 255, 255, 0.3);
      border-top: 5px solid #ffffff;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    `;

    // Add animation
    const style = doc.createElement('style');
    style.textContent = `
      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
    `;
    doc.head.appendChild(style);

    // Add loading text
    const text = doc.createElement('div');
    text.style.cssText = `
      position: absolute;
      color: white;
      font-size: 16px;
      font-weight: bold;
      font-family: Arial, sans-serif;
      margin-top: 80px;
      text-align: center;
    `;
    text.textContent = `TEST MODE: Loading blocker (will hide in ${durationMs / 1000}s)`;

    overlay.appendChild(spinner);
    overlay.appendChild(text);
    doc.body.appendChild(overlay);

    console.log('[TEST] ✅ Loading blocker shown in DOM');
    
    // Auto-hide after specified duration
    const timeoutId = setTimeout(() => {
      if (overlay && overlay.parentNode) {
        try {
          overlay.parentNode.removeChild(overlay);
          console.log('[TEST] ✅ Loading blocker auto-hidden after', durationMs, 'ms');
        } catch (e) {
          console.error('[TEST] ❌ Error removing overlay:', e);
        }
      }
    }, durationMs);
    
    // Return object with manual hide capability
    return {
      overlay,
      hide: () => {
        clearTimeout(timeoutId);
        if (overlay && overlay.parentNode) {
          try {
            overlay.parentNode.removeChild(overlay);
            console.log('[TEST] ✅ Loading blocker manually hidden');
          } catch (e) {
            console.error('[TEST] ❌ Error removing overlay:', e);
          }
        }
      }
    };
  };

  function updateStatusBadge(badgeEl, text, type) {
    badgeEl.textContent = text;
    badgeEl.className = `status-badge status-${type}`;
  }

  function initializeRouteFilter(doc, tripSummaries) {
    const routeFilterContainer = doc.getElementById('routeFilter');
    routeFilterContainer.innerHTML = '';
    
    // Get unique routes
    const routeSet = new Set();
    tripSummaries.forEach(trip => routeSet.add(trip.routeId));
    const routes = Array.from(routeSet).sort((a, b) => {
      const aNum = parseInt(a);
      const bNum = parseInt(b);
      if (!isNaN(aNum) && !isNaN(bNum)) return aNum - bNum;
      return a.localeCompare(b);
    });
    
    // Create checkboxes (all selected by default)
    selectedRouteIds.clear();
    routes.forEach(routeId => {
      selectedRouteIds.add(routeId);
      
      const label = doc.createElement('label');
      const checkbox = doc.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = routeId;
      checkbox.checked = true;
      
      // Get route short name and long name if available
      const routeData = routesData && routesData[routeId] ? routesData[routeId] : null;
      const shortName = routeData ? routeData.route_short_name : null;
      const longName = routeData ? routeData.route_long_name : null;
      let displayText = ` ${routeId}`;
      
      if (shortName && longName) {
        displayText = ` ${shortName} - ${longName}`;
      } else if (shortName) {
        displayText = ` ${shortName}`;
      } else if (longName) {
        displayText = ` ${longName}`;
      }
      
      label.appendChild(checkbox);
      label.appendChild(doc.createTextNode(displayText));
      routeFilterContainer.appendChild(label);
    });
  }

  function initializeCharts(doc) {
    console.log('[Viewer] Initializing charts...');
    
    if (typeof Chart === 'undefined') {
      console.error('[Viewer] Chart.js not loaded!');
      const otpTab = doc.getElementById('otpTab');
      if (otpTab) {
        otpTab.innerHTML = '<div class="no-data">Error: Chart.js library failed to load. Please refresh the page or check your internet connection.</div>';
      }
      return false;
    }
    
    console.log('[Viewer] Chart.js library loaded successfully');
    
    // Initialize route chart
    const routeCanvas = doc.getElementById('routeChart');
    if (!routeCanvas) {
      console.error('[Viewer] Canvas element #routeChart not found!');
      return false;
    }
    
    console.log('[Viewer] Creating route chart...');
    try {
      const routeCtx = routeCanvas.getContext('2d');
      routeChart = new Chart(routeCtx, {
        type: 'bar',
        data: {
          labels: [],
          datasets: [{
            label: 'Average Delay',
            data: [],
            backgroundColor: [],
            borderColor: [],
            borderWidth: 1
          }]
        },
        options: {
          indexAxis: 'y',
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: (context) => {
                  const delay = context.parsed.x;
                  return `Avg Delay: ${delay.toFixed(0)}s`;
                }
              }
            }
          },
          scales: {
            x: {
              title: { display: true, text: 'Average Delay (seconds)' },
              ticks: {
                stepSize: 60,
                callback: (value) => `${value}s`
              }
            },
            y: {
              title: { display: true, text: 'Route' }
            }
          }
        }
      });
      console.log('[Viewer] Route chart created successfully');
    } catch (err) {
      console.error('[Viewer] Failed to create route chart:', err);
      return false;
    }
    
    // Initialize busiest routes chart
    const busiestRoutesCanvas = doc.getElementById('busiestRoutesChart');
    if (!busiestRoutesCanvas) {
      console.error('[Viewer] Canvas element #busiestRoutesChart not found!');
      return false;
    }
    
    console.log('[Viewer] Creating busiest routes chart...');
    try {
      const busiestRoutesCtx = busiestRoutesCanvas.getContext('2d');
      busiestRoutesChart = new Chart(busiestRoutesCtx, {
        type: 'bar',
        data: {
          labels: [],
          datasets: [{
            label: 'Average Delay',
            data: [],
            backgroundColor: [],
            borderColor: [],
            borderWidth: 1
          }]
        },
        options: {
          indexAxis: 'y',
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: (context) => {
                  const delay = context.parsed.x;
                  return `Avg Delay: ${delay.toFixed(0)}s`;
                }
              }
            }
          },
          scales: {
            x: {
              title: { display: true, text: 'Average Delay (seconds)' },
              ticks: {
                stepSize: 60,
                callback: (value) => `${value}s`
              }
            },
            y: {
              title: { display: true, text: 'Route' }
            }
          }
        }
      });
      console.log('[Viewer] Busiest routes chart created successfully');
    } catch (err) {
      console.error('[Viewer] Failed to create busiest routes chart:', err);
      return false;
    }
    
    // Initialize stop chart
    const stopCanvas = doc.getElementById('stopChart');
    if (!stopCanvas) {
      console.error('[Viewer] Canvas element #stopChart not found!');
      return false;
    }
    
    console.log('[Viewer] Creating stop chart...');
    try {
      const stopCtx = stopCanvas.getContext('2d');
      stopChart = new Chart(stopCtx, {
        type: 'bar',
        data: {
          labels: [],
          datasets: [{
            label: 'Average Incremental Delay',
            data: [],
            backgroundColor: [],
            borderColor: [],
            borderWidth: 1
          }]
        },
        options: {
          indexAxis: 'y',
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: (context) => {
                  const delay = context.parsed.x;
                  return `Avg Incremental Delay: ${delay.toFixed(0)}s`;
                }
              }
            }
          },
          scales: {
            x: {
              title: { display: true, text: 'Average Incremental Delay (seconds)' },
              ticks: {
                stepSize: 60,
                callback: (value) => `${value}s`
              }
            },
            y: {
              title: { display: true, text: 'Stop' },
              ticks: {
                font: { size: 10 }
              }
            }
          }
        }
      });
      console.log('[Viewer] Stop chart created successfully');
    } catch (err) {
      console.error('[Viewer] Failed to create stop chart:', err);
      return false;
    }
    
    // Initialize hourly delay chart
    const hourlyDelayCanvas = doc.getElementById('hourlyDelayChart');
    if (!hourlyDelayCanvas) {
      console.error('[Viewer] Canvas element #hourlyDelayChart not found!');
      return false;
    }
    
    console.log('[Viewer] Creating hourly delay chart...');
    try {
      const hourlyDelayCtx = hourlyDelayCanvas.getContext('2d');
      hourlyDelayChart = new Chart(hourlyDelayCtx, {
        type: 'line',
        data: {
          labels: [],
          datasets: []
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          plugins: {
            legend: { display: true, position: 'top' },
            tooltip: {
              callbacks: {
                label: (context) => {
                  const value = context.parsed.y;
                  if (value === null) return 'No data';
                  return `Avg Incremental Delay: ${value.toFixed(0)}s`;
                }
              }
            }
          },
          scales: {
            x: {
              title: { display: true, text: 'Time of Day' },
              type: 'linear',
              ticks: {
                stepSize: 3600,
                autoSkip: false,
                callback: (value) => `${value}h`
              },
              min: 0,
              max: 86400
            },
            y: {
              title: { display: true, text: 'Average Incremental Delay (seconds)' },
              ticks: {
                stepSize: 60,
                callback: (value) => `${value}s`
              }
            }
          }
        }
      });
      console.log('[Viewer] Hourly delay chart created successfully');
    } catch (err) {
      console.error('[Viewer] Failed to create hourly delay chart:', err);
      return false;
    }
    
    console.log('[Viewer] Charts initialized');
    return true;
  }

  async function renderCharts(doc) {
    console.log('[Viewer] ▶️ renderCharts ENTRY:', {
      tripSummaries: processedData.tripSummaries.length,
      stopDeltas: processedData.stopDeltas.length,
      selectedRoutes: Array.from(selectedRouteIds),
      mapInitialized,
      leafletMapExists: !!leafletMap
    });
    
    // Apply time filtering
    let filteredTripSummaries = processedData.tripSummaries;
    let filteredStopDeltas = processedData.stopDeltas;
    
    if (timeFilterStartEpoch !== null && timeFilterEndEpoch !== null) {
      const filteredTripIds = new Set();

      for (const trip of processedData.tripSummaries) {
        if (!trip.firstRecordedTime || !trip.lastRecordedTime) continue;

        // Interval overlap test: trip [firstRecordedTime, lastRecordedTime] intersects filter [start, end]
        const tripStart = trip.firstRecordedTime;
        const tripEnd = trip.lastRecordedTime;
        if (tripEnd >= timeFilterStartEpoch && tripStart <= timeFilterEndEpoch) {
          filteredTripIds.add(trip.tripId);
        }
      }

      filteredTripSummaries = processedData.tripSummaries.filter(t => filteredTripIds.has(t.tripId));
      filteredStopDeltas = processedData.stopDeltas.filter(s => filteredTripIds.has(s.tripId));
    }
    
    const routeAgg = aggregateByRoute(filteredTripSummaries, selectedRouteIds);
    const busiestRoutesAgg = aggregateByBusiestRoutes(filteredTripSummaries, selectedRouteIds, processedData.routeStats);
    const stopAgg = aggregateByStop(filteredStopDeltas, selectedRouteIds, stopsData);
    
    console.log('[Viewer] Aggregation complete:', {
      routeAggCount: routeAgg.length,
      busiestRoutesAggCount: busiestRoutesAgg.length,
      stopAggCount: stopAgg.length
    });
    
    if (routeAgg.length === 0 && stopAgg.length === 0 && busiestRoutesAgg.length === 0) {
      doc.getElementById('otpTab').innerHTML = '<div class="no-data">No data available. Try adjusting filters or selecting a different date.</div>';
      return;
    }
    
    // Update route chart
    updateRouteChart(routeAgg);
    
    // Update busiest routes chart
    updateBusiestRoutesChart(busiestRoutesAgg);
    
    // Update stop chart
    updateStopChart(stopAgg);
    
    // Update hourly delay chart
    // Compute a default time range if not set by Apply Filter
    let hourlyStartEpoch = timeFilterStartEpoch;
    let hourlyEndEpoch = timeFilterEndEpoch;
    
    if (hourlyStartEpoch === null || hourlyEndEpoch === null) {
      // Use the same timeFilterBaseDay and time source as the time filter for consistency
      let minTime = null, maxTime = null;
      for (const trip of filteredTripSummaries) {
        if (trip.firstRecordedTime && (minTime === null || trip.firstRecordedTime < minTime)) minTime = trip.firstRecordedTime;
        if (trip.lastRecordedTime && (maxTime === null || trip.lastRecordedTime > maxTime)) maxTime = trip.lastRecordedTime;
      }
      if (minTime !== null && maxTime !== null) {
        hourlyStartEpoch = minTime;
        hourlyEndEpoch = maxTime;
      }
    }
    
    updateHourlyDelayChart(doc, filteredStopDeltas, hourlyStartEpoch, hourlyEndEpoch, timeFilterBaseDay);
    
    // DISABLED: Old heatmap plotting - now using subshape visualization instead
    // updateHeatmap(filteredStopDeltas);

    // Visualize subshapes for top 10 busiest routes (only if map tab is active and ready)
    // Replaced heatmap with subshape visualization for better route-level insights
    // IMPORTANT: Await visualization to ensure loading overlay and all async work completes
    const mapTab = doc.querySelector('.tab[data-tab="map"]');
    const isMapTabActive = mapTab && mapTab.classList.contains('active');
    
    console.log('[DEBUG] 🎯 Visualization check:', {
      leafletMapExists: !!leafletMap,
      mapInitialized,
      isMapTabActive,
      shouldVisualize: leafletMap && mapInitialized && isMapTabActive
    });
    
    if (leafletMap && mapInitialized && isMapTabActive) {
      try {
        console.log('[DEBUG] ▶️ Starting visualization with filtered trip data...');
        await visualizeSubshapesForBusiestRoutes(filteredTripSummaries);
        console.log('[DEBUG] ✅ Subshape visualization COMPLETED');
      } catch (err) {
        console.error('[DEBUG] ❌ Subshape visualization ERROR:', err);
      }
    } else {
      console.warn('[DEBUG] ⏭️ Skipping visualization:', {
        reason: !leafletMap ? 'no leafletMap' : (!mapInitialized ? 'mapInitialized=false' : 'map tab not active')
      });
    }
    
    // Update stats tab
    renderStatsTab(doc, filteredTripSummaries, filteredStopDeltas);
    
    console.log('[Viewer] ⏹️ renderCharts EXIT - all updates complete');
  }
  
  // Helper functions for time filtering (working with epoch seconds)
  function isTimeInRange(timeEpoch, startEpoch, endEpoch) {
    if (timeEpoch === null || startEpoch === null || endEpoch === null) return false;
    return timeEpoch >= startEpoch && timeEpoch <= endEpoch;
  }
  
  function isTimeBefore(timeEpoch1, timeEpoch2) {
    if (timeEpoch1 === null || timeEpoch2 === null) return false;
    return timeEpoch1 < timeEpoch2;
  }

  function updateRouteChart(data) {
    console.log('[Viewer] Updating route chart with', data.length, 'routes');
    
    if (!routeChart) {
      console.error('[Viewer] Route chart not initialized!');
      return;
    }
    
    if (data.length === 0) {
      routeChart.data.labels = [];
      routeChart.data.datasets[0].data = [];
      routeChart.data.datasets[0].backgroundColor = [];
      routeChart.data.datasets[0].borderColor = [];
      routeChart.update('none');
      return;
    }
    
    // Create gradient colors (red = worst)
    const colors = data.map((_, i) => {
      const ratio = i / Math.max(data.length - 1, 1);
      const r = Math.floor(220 - ratio * 70);
      const g = Math.floor(50 + ratio * 150);
      const b = 50;
      return `rgb(${r}, ${g}, ${b})`;
    });
    
    // Update data with route names
    routeChart.data.labels = data.map(d => {
      const routeName = routesData && routesData[d.routeId] ? routesData[d.routeId].route_long_name : null;
      return routeName ? `${d.routeId} - ${routeName}` : d.routeId;
    });
    routeChart.data.datasets[0].data = data.map(d => d.avgDelay);
    routeChart.data.datasets[0].backgroundColor = colors;
    routeChart.data.datasets[0].borderColor = colors;
    
    // Store full data for tooltip access
    routeChart.fullData = data;
    
    // Update tooltip callback to access stored data
    routeChart.options.plugins.tooltip.callbacks.label = (context) => {
      const route = routeChart.fullData[context.dataIndex];
      return [
        `Avg Delay: ${route.avgDelay.toFixed(0)}s`,
        `Trips: ${route.tripCount}`
      ];
    };
    
    routeChart.update('none');
  }

  function updateStopChart(data) {
    console.log('[Viewer] Updating stop chart with', data.length, 'stops');
    
    if (!stopChart) {
      console.error('[Viewer] Stop chart not initialized!');
      return;
    }
    
    if (data.length === 0) {
      stopChart.data.labels = [];
      stopChart.data.datasets[0].data = [];
      stopChart.data.datasets[0].backgroundColor = [];
      stopChart.data.datasets[0].borderColor = [];
      stopChart.update('none');
      return;
    }
    
    // Create gradient colors
    const colors = data.map((_, i) => {
      const ratio = i / Math.max(data.length - 1, 1);
      const r = Math.floor(220 - ratio * 70);
      const g = Math.floor(50 + ratio * 150);
      const b = 50;
      return `rgb(${r}, ${g}, ${b})`;
    });
    
    // Update data
    stopChart.data.labels = data.map(d => `${d.stopId} - ${d.stopName}`);
    stopChart.data.datasets[0].data = data.map(d => d.avgIncrementalDelay);
    stopChart.data.datasets[0].backgroundColor = colors;
    stopChart.data.datasets[0].borderColor = colors;
    
    // Store full data for tooltip access
    stopChart.fullData = data;
    
    // Update tooltip callback to access stored data
    stopChart.options.plugins.tooltip.callbacks.label = (context) => {
      const stop = stopChart.fullData[context.dataIndex];
      return [
        `Avg Incremental Delay: ${stop.avgIncrementalDelay.toFixed(0)}s`,
        `Records: ${stop.recordCount}`,
        `Stop: ${stop.stopName}`
      ];
    };
    
    stopChart.update('none');
  }

  function updateBusiestRoutesChart(data) {
    console.log('[Viewer] Updating busiest routes chart with', data.length, 'routes');
    
    if (!busiestRoutesChart) {
      console.error('[Viewer] Busiest routes chart not initialized!');
      return;
    }
    
    if (data.length === 0) {
      busiestRoutesChart.data.labels = [];
      busiestRoutesChart.data.datasets[0].data = [];
      busiestRoutesChart.data.datasets[0].backgroundColor = [];
      busiestRoutesChart.data.datasets[0].borderColor = [];
      busiestRoutesChart.update('none');
      return;
    }
    
    // Create gradient colors (red = worst delay)
    const colors = data.map((_, i) => {
      const ratio = i / Math.max(data.length - 1, 1);
      const r = Math.floor(220 - ratio * 70);
      const g = Math.floor(50 + ratio * 150);
      const b = 50;
      return `rgb(${r}, ${g}, ${b})`;
    });
    
    // Update data with route names (sorted by trip-hours already)
    busiestRoutesChart.data.labels = data.map(d => {
      const routeName = routesData && routesData[d.routeId] ? routesData[d.routeId].route_long_name : null;
      return routeName ? `${d.routeId} - ${routeName}` : d.routeId;
    });
    busiestRoutesChart.data.datasets[0].data = data.map(d => d.avgDelay);
    busiestRoutesChart.data.datasets[0].backgroundColor = colors;
    busiestRoutesChart.data.datasets[0].borderColor = colors;
    
    // Store full data for tooltip access
    busiestRoutesChart.fullData = data;
    
    // Update tooltip callback to access stored data
    busiestRoutesChart.options.plugins.tooltip.callbacks.label = (context) => {
      const route = busiestRoutesChart.fullData[context.dataIndex];
      return [
        `Avg Delay: ${route.avgDelay.toFixed(0)}s`,
        `Trip-Hours: ${route.tripHours.toFixed(1)}`,
        `Trips: ${route.tripCount}`
      ];
    };
    
    busiestRoutesChart.update('none');
  }

  function updateHourlyDelayChart(doc, filteredStopDeltas, hourlyStartEpoch, hourlyEndEpoch, baseDay) {
    console.log('[Viewer] Updating hourly delay chart');
    
    if (!hourlyDelayChart) {
      console.error('[Viewer] Hourly delay chart not initialized!');
      return;
    }
    
    // Aggregate by hourly buckets
    const hourlyData = aggregateHourlyDelayByRoute(filteredStopDeltas, selectedRouteIds, processedData.routeStats, hourlyStartEpoch, hourlyEndEpoch);
    
    if (hourlyData.series.length === 0 || hourlyData.hourStartTimes.length === 0) {
      console.log('[Viewer] No hourly data available');
      hourlyDelayChart.data.labels = [];
      hourlyDelayChart.data.datasets = [];
      hourlyDelayChart.update('none');
      return;
    }
    
    // Determine baseDay: use passed-in value, or compute from first hour time
    let chartBaseDay = baseDay;
    if (!chartBaseDay && hourlyData.hourStartTimes.length > 0) {
      chartBaseDay = Math.floor(hourlyData.hourStartTimes[0] / 86400) * 86400;
    }
    
    // Assign colors to series (red, black, yellow, blue, green)
    const colors = [
      'rgb(255, 0, 0)',       // red
      'rgb(0, 0, 0)',         // black
      'rgb(255, 255, 0)',     // yellow
      'rgb(0, 0, 255)',       // blue
      'rgb(0, 128, 0)'        // green
    ];
    
    hourlyData.series.forEach((series, idx) => {
      const color = colors[idx % colors.length];
      series.borderColor = color;
      series.backgroundColor = color;
      series.borderWidth = 2;
    });
    
    // Helper: format epoch seconds to HH:MM using consistent baseDay
    function formatEpochToHHMM(epochSeconds) {
      if (epochSeconds === null) return '';
      const delta = Math.max(0, Math.floor(epochSeconds - chartBaseDay));
      const hrs = Math.floor(delta / 3600);
      const mins = Math.floor((delta % 3600) / 60);
      return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
    }
    
    // Build datasets with x,y format using actual epoch times
    const datasets = hourlyData.series.map(series => {
      const data = [];
      for (let idx = 0; idx < series.data.length; idx++) {
        const value = series.data[idx];
        if (value !== null) {
          data.push({
            x: hourlyData.hourStartTimes[idx],
            y: value
          });
        }
      }
      
      return {
        label: series.label,
        data: data,
        borderColor: series.borderColor,
        backgroundColor: series.backgroundColor,
        borderWidth: series.borderWidth,
        tension: series.tension,
        fill: series.fill,
        pointRadius: series.pointRadius,
        pointHoverRadius: series.pointHoverRadius,
        spanGaps: false // Don't connect gaps
      };
    });
    
    // Generate labels for all hours
    const labels = hourlyData.hourStartTimes.map(epochTime => formatEpochToHHMM(epochTime));
    
    hourlyDelayChart.data.labels = labels;
    hourlyDelayChart.data.datasets = datasets;
    
    // Update x-axis scale to show all hours tightly
    hourlyDelayChart.options.scales.x.min = hourlyData.hourStartTimes[0];
    hourlyDelayChart.options.scales.x.max = hourlyData.hourStartTimes[hourlyData.hourStartTimes.length - 1];
    hourlyDelayChart.options.scales.x.ticks.stepSize = 3600; // 1 hour in seconds
    hourlyDelayChart.options.scales.x.ticks.autoSkip = false; // Show all ticks
    hourlyDelayChart.options.scales.x.ticks.callback = function(value) {
      return formatEpochToHHMM(value);
    };
    
    hourlyDelayChart.update('none');
  }

  function renderStatsTab(doc, tripSummaries, stopDeltas) {
    const statsGrid = doc.getElementById('statsGrid');
    if (!statsGrid) return;
    
    // Calculate statistics
    const totalTrips = tripSummaries.length;
    const totalStops = stopDeltas.length;
    const tripsMissingSchedule = tripSummaries.filter(t => t.scheduledDuration === null).length;
    const stopsWithActual = stopDeltas.filter(s => s.delta !== null).length;
    const stopsMissingActual = totalStops - stopsWithActual;
    const tripsWithDelay = tripSummaries.filter(t => t.maxDelay !== null).length;
    const avgMaxDelay = tripsWithDelay > 0 
      ? tripSummaries.filter(t => t.maxDelay !== null).reduce((sum, t) => sum + t.maxDelay, 0) / tripsWithDelay 
      : 0;
    const stopsWithIncrementalDelay = stopDeltas.filter(s => s.incrementalDelay !== null).length;
    const avgIncrementalDelay = stopsWithIncrementalDelay > 0
      ? stopDeltas.filter(s => s.incrementalDelay !== null).reduce((sum, s) => sum + s.incrementalDelay, 0) / stopsWithIncrementalDelay
      : 0;
    
    // Create stat cards
    const stats = [
      { title: 'Total Trips', value: totalTrips, description: 'Number of trips in dataset' },
      { title: 'Total Stop Records', value: totalStops, description: 'Number of stop-level records' },
      { title: 'Trips Missing Schedule', value: tripsMissingSchedule, description: 'Trips without scheduled duration' },
      { title: 'Stop Records Missing Actual', value: stopsMissingActual, description: 'Stops without actual arrival time' },
      { title: 'Trips with Delay Data', value: tripsWithDelay, description: 'Trips with valid delay measurements' },
      { title: 'Avg Max Delay per Trip', value: `${avgMaxDelay.toFixed(0)}s`, description: 'Average maximum delay across trips' },
      { title: 'Stops with Incremental Delay', value: stopsWithIncrementalDelay, description: 'Stops with valid incremental delay' },
      { title: 'Avg Incremental Delay', value: `${avgIncrementalDelay.toFixed(0)}s`, description: 'Average incremental delay across stops' }
    ];
    
    statsGrid.innerHTML = stats.map(stat => `
      <div class="stat-card">
        <h3>${stat.title}</h3>
        <div class="stat-value">${stat.value}</div>
        <div class="stat-description">${stat.description}</div>
      </div>
    `).join('');
  }

  // ============================================================================
  // DEBUG HELPERS
  // ============================================================================

  /**
   * Get 20 random trips for a specific route with all stop details
   * Usage in console: RTRecordingViewer.sampleTrips('501')
   */
  function sampleTripsForRoute(routeId) {
    if (!currentData || !currentData.recordedData) {
      console.log('[Viewer] No data loaded yet');
      return;
    }

    const recordedData = currentData.recordedData;
    
    // Find all trips for this route
    const tripsForRoute = [];
    for (const tripId in recordedData) {
      const trip = recordedData[tripId];
      if (trip.rid === routeId) {
        tripsForRoute.push(tripId);
      }
    }

    if (tripsForRoute.length === 0) {
      console.log(`[Viewer] No trips found for route ${routeId}`);
      return;
    }

    // Randomly select up to 20 trips
    const sampleSize = Math.min(20, tripsForRoute.length);
    const randomTrips = [];
    const usedIndices = new Set();
    
    while (randomTrips.length < sampleSize && usedIndices.size < tripsForRoute.length) {
      const idx = Math.floor(Math.random() * tripsForRoute.length);
      if (!usedIndices.has(idx)) {
        usedIndices.add(idx);
        randomTrips.push(tripsForRoute[idx]);
      }
    }

    // Build stop deltas map for quick lookup (tripId -> stopSeq -> stopDelta)
    const stopDeltasMap = {};
    if (processedData.stopDeltas) {
      for (const stopDelta of processedData.stopDeltas) {
        if (stopDelta.routeId === routeId) {
          if (!stopDeltasMap[stopDelta.tripId]) {
            stopDeltasMap[stopDelta.tripId] = {};
          }
          stopDeltasMap[stopDelta.tripId][stopDelta.stopSeq] = stopDelta;
        }
      }
    }

    console.log(`[Viewer Debug] Route ${routeId}: showing ${randomTrips.length} random trips from ${tripsForRoute.length} total\n`);

    // Log each trip
    randomTrips.forEach((tripId, tripIdx) => {
      const trip = recordedData[tripId];
      const route = routesData[trip.rid];
      const routeDisplay = route ? `${route.route_short_name || trip.rid}` : trip.rid;
      
      const stopSeqs = Object.keys(trip.stops).map(Number).sort((a, b) => a - b);

      const stopDetails = [];
      for (const seq of stopSeqs) {
        const stop = trip.stops[seq];
        const stopData = stopsData[stop.sid];
        const stopName = stopData?.stop_name || stop.sid;
        
        // Get delay info from stopDeltas if available
        const stopDelta = stopDeltasMap[tripId]?.[stop.seq];
        const delay = stopDelta?.delta || null;
        const incrementalDelay = stopDelta?.incrementalDelay || null;

        stopDetails.push({
          seq: stop.seq,
          stopId: stop.sid,
          stopName: stopName,
          arr: isValidArrivalTime(stop.arr) ? stop.arr : null,
          sch_arr: stop.sch_arr || null,
          delay: delay !== null ? `${delay}s (${formatDuration(delay)})` : 'null',
          incrementalDelay: incrementalDelay !== null ? `${incrementalDelay}s (${formatDuration(incrementalDelay)})` : 'null'
        });
      }

      console.group(`Trip ${tripIdx + 1}/${randomTrips.length}: ${tripId} (Route ${routeDisplay}, Vehicle ${trip.vid})`);
      console.table(stopDetails);
      console.groupEnd();
    });
  }

  // ============================================================================
  // DEBUG UTILITIES
  // ============================================================================

  /**
   * Debug function to analyze a specific trip by ID
   * Shows detailed stop-by-stop data and delay metrics
   * 
   * Call from browser console in RTRecordingViewer.html:
   *   window.RTRecordingViewer.debugTripById('your-trip-id-here')
   */
  function debugTripById(tripId) {
    console.group(`%c[RTRecordingViewer DEBUG] Trip Details: ${tripId}`, 'color: #d32f2f; font-weight: bold');
    
    if (!currentData || !currentData.recordedData) {
      console.error('ERROR: No data loaded. Use "Load Data" first.');
      console.groupEnd();
      return;
    }
    
    const recordedData = currentData.recordedData;
    const routes = (window.gtfsData && window.gtfsData.routes) || {};
    
    // Look up the trip
    const trip = recordedData[tripId];
    if (!trip) {
      console.error(`ERROR: Trip ID "${tripId}" not found in recorded data.`);
      console.groupEnd();
      return;
    }
    
    const routeId = String(trip.rid);
    const route = routes[routeId];
    const routeName = route 
      ? `${route.route_short_name || ''} - ${route.route_long_name || ''}`
      : `Route ${routeId}`;
    
    console.log(`Route: ${routeName} (${routeId})`);
    console.log(`Vehicle: ${trip.vid || 'N/A'}`);
    
    // Build stop details
    const stopSeqKeys = Object.keys(trip.stops);
    const stopDetails = [];
    const stopIds = (stopsData || {});
    
    for (let s = 0; s < stopSeqKeys.length; s++) {
      const stopSeq = stopSeqKeys[s];
      const stop = trip.stops[stopSeq];
      
      if (stop && typeof stop === 'object') {
        let delaySeconds = (isValidArrivalTime(stop.arr) && stop.sch_arr)
          ? (stop.arr - stop.sch_arr)
          : null;
        delaySeconds = normalizeDelay(delaySeconds);
        
        const stopName = stopIds[stop.sid] ? stopIds[stop.sid].name : `Stop ${stop.sid}`;
        
        stopDetails.push({
          seq: Number(stopSeq),
          stopId: stop.sid,
          stopName: stopName,
          arr_recorded: isValidArrivalTime(stop.arr) ? stop.arr : 'MISSING',
          sch_arr: stop.sch_arr || 'N/A',
          delaySeconds: delaySeconds,
          delayFormatted: delaySeconds !== null ? formatDuration(delaySeconds) : 'N/A'
        });
      }
    }
    
    if (stopDetails.length > 0) {
      console.log(`\nStops (${stopDetails.length} total):`);
      console.table(stopDetails);
      
      // Calculate trip-level metrics
      const validDelays = stopDetails
        .filter(s => s.delaySeconds !== null)
        .map(s => s.delaySeconds);
      
      if (validDelays.length > 0) {
        const maxDelay = Math.max(...validDelays);
        const minDelay = Math.min(...validDelays);
        const avgDelay = validDelays.reduce((a, b) => a + b, 0) / validDelays.length;
        
        console.log('\n📈 Trip Metrics:');
        console.log(`  Max Delay: ${formatDuration(maxDelay)} (${maxDelay}s)`);
        console.log(`  Min Delay: ${formatDuration(minDelay)} (${minDelay}s)`);
        console.log(`  Avg Delay: ${formatDuration(avgDelay)} (${avgDelay.toFixed(1)}s)`);
        console.log(`  Valid stops: ${validDelays.length}/${stopDetails.length}`);
      } else {
        console.log('⚠️  No valid delay data for this trip');
      }
    } else {
      console.log('⚠️  No stops recorded for this trip');
    }
    
    console.groupEnd();
  }

  /**
   * Debug function to analyze trip delays from currently loaded data
   * Call from browser console in RTrecordingViewer.html:
   *   window.RTRecordingViewer.debugTripDelays()
   */
  function debugTripDelays() {
    console.group('%c[RTRecordingViewer DEBUG] Trip Delay Analysis', 'color: #d32f2f; font-weight: bold');
    
    if (!currentData || !currentData.recordedData) {
      console.error('ERROR: No data loaded. Use "Load Data" first.');
      console.groupEnd();
      return;
    }
    
    const recordedData = currentData.recordedData;
    const routes = (window.gtfsData && window.gtfsData.routes) || {};
    const allTripIds = Object.keys(recordedData);
    
    console.log(`📊 Total recorded trips: ${allTripIds.length}`);
    
    // Read current filter state from DOM (not from selectedRouteIds which might be stale)
    // Check if we're in a popup (viewerWindow) or the main page (document)
    const targetDoc = viewerWindow ? viewerWindow.document : document;
    const checkedCheckboxes = targetDoc.querySelectorAll('.route-filter input[type="checkbox"]:checked');
    const currentSelectedRoutes = new Set();
    
    checkedCheckboxes.forEach(cb => {
      currentSelectedRoutes.add(String(cb.value));
    });
    
    console.log(`🔍 Selected Routes (from UI): ${currentSelectedRoutes.size > 0 ? Array.from(currentSelectedRoutes).join(', ') : 'None (all routes)'}`);
    
    // Filter trips by selected routes
    const filteredTripIds = [];
    for (let i = 0; i < allTripIds.length; i++) {
      const tripId = allTripIds[i];
      const trip = recordedData[tripId];
      
      if (trip && typeof trip === 'object' && trip.rid) {
        const routeId = String(trip.rid);
        // Include trip if no filter is active OR if its route is in the selected set
        if (currentSelectedRoutes.size === 0 || currentSelectedRoutes.has(routeId)) {
          filteredTripIds.push(tripId);
        }
      }
    }
    
    console.log(`✓ Found ${filteredTripIds.length} trips matching filter\n`);
    
    if (filteredTripIds.length === 0) {
      console.warn('⚠️  No trips found. Try selecting different routes or click "Apply Filter".');
      console.groupEnd();
      return;
    }
    
    // Analyze ALL filtered trips (up to 1000)
    const tripsToAnalyze = filteredTripIds.slice(0, 1000);
    console.log(`✓ Analyzing all ${tripsToAnalyze.length} trips (capped at 1000)\n`);
    
    const tripDelayData = [];
    
    // Analyze each trip
    for (let i = 0; i < tripsToAnalyze.length; i++) {
      const tripId = tripsToAnalyze[i];
      const trip = recordedData[tripId];
      
      if (!trip || !trip.stops) continue;
      
      const routeId = String(trip.rid);
      const route = routes[routeId];
      const routeName = route 
        ? `${route.route_short_name || ''} - ${route.route_long_name || ''}`
        : `Route ${routeId}`;
      
      // Build stop details (for calculating delays, not logging)
      const stopSeqKeys = Object.keys(trip.stops);
      const stopDetails = [];
      
      for (let s = 0; s < stopSeqKeys.length; s++) {
        const stopSeq = stopSeqKeys[s];
        const stop = trip.stops[stopSeq];
        
        if (stop && typeof stop === 'object') {
          let delaySeconds = (isValidArrivalTime(stop.arr) && stop.sch_arr)
            ? (stop.arr - stop.sch_arr)
            : null;
          delaySeconds = normalizeDelay(delaySeconds);
          
          stopDetails.push({
            seq: Number(stopSeq),
            delaySeconds: delaySeconds
          });
        }
      }
      
      // Calculate trip-level metrics (silently, no logging per trip - too verbose for 1000 trips)
      const validDelays = stopDetails
        .filter(s => s.delaySeconds !== null)
        .map(s => s.delaySeconds);
      
      if (validDelays.length > 0) {
        const maxDelay = Math.max(...validDelays);
        const minDelay = Math.min(...validDelays);
        const avgDelay = validDelays.reduce((a, b) => a + b, 0) / validDelays.length;
        
        tripDelayData.push({
          tripId,
          routeName,
          vehicleId: trip.vid,
          stopCount: stopDetails.length,
          maxDelay,
          minDelay,
          avgDelay
        });
      }
    }
    
    // Summary
    if (tripDelayData.length > 0) {
      console.log(`\n📊 SUMMARY - All ${tripDelayData.length} Analyzed Trips:`);
      console.table(tripDelayData);
      
      const allMaxDelays = tripDelayData.map(t => t.maxDelay);
      const overallMax = Math.max(...allMaxDelays);
      const overallMin = Math.min(...allMaxDelays);
      const overallAvg = allMaxDelays.reduce((a, b) => a + b, 0) / allMaxDelays.length;
      
      console.log('\n🎯 Overall Max Delays (Average of Trip Max Delays):');
      console.log(`  Highest: ${formatDuration(overallMax)}`);
      console.log(`  Lowest: ${formatDuration(overallMin)}`);
      console.log(`  Average: ${formatDuration(overallAvg)}`);
    }
    
    console.log('\n✅ Analysis complete');
    console.groupEnd();
  }

  // ============================================================================
  // EXPORTS
  // ============================================================================

  window.RTRecordingViewer = {
    open: openViewer,
    sampleTrips: sampleTripsForRoute,
    debugTripById: debugTripById,
    debugTripDelays: debugTripDelays,
    visualizeSubshapesForBusiestRoutes: visualizeSubshapesForBusiestRoutes
  };

  // ============================================================================
  // AUTO-INITIALIZE IF LOADED STANDALONE
  // ============================================================================

  // Auto-initialize if this is the viewer page (regardless of how it was opened)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      // Initialize if we're in the RTrecordingViewer.html page itself
      if (document.getElementById('dataSource')) {
        console.log('[Viewer] Auto-initializing...');
        initializeViewer(window);
      }
    });
  } else {
    // Page already loaded
    if (document.getElementById('dataSource')) {
      console.log('[Viewer] Auto-initializing...');
      initializeViewer(window);
    }
  }

})();
