// RT Recording Viewer
// Opens in a new popup window to analyze recorded trip data

(function() {
  'use strict';

  // GitHub configuration - can be overridden by runtime config
  const GITHUB_REPO = (window.APP_CONFIG && window.APP_CONFIG.githubRepo) || "";
  const GITHUB_BRANCH = (window.APP_CONFIG && window.APP_CONFIG.githubBranch) || "main";
  const GITHUB_RAW_BASE = GITHUB_REPO ? `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}` : "";

  const TIME_ZONE = (window.APP_CONFIG && window.APP_CONFIG.timeZone) || 'UTC';
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
    stopAggregations: []
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

  async function loadFromMemory() {
    // Access recordedData from parent window (injected by openViewer)
    const parentData = window.parentRecordedData || (typeof recordedData !== 'undefined' ? recordedData : null);
    const parentCache = window.parentScheduledTimesCache || (typeof scheduledTimesCache !== 'undefined' ? scheduledTimesCache : null);
    
    if (!parentData) {
      throw new Error('No recording data available in memory. Start recording first.');
    }
    
    const tripCount = Object.keys(parentData).length;
    if (tripCount === 0) {
      throw new Error('Recording data is empty. No trips recorded yet.');
    }
    
    return {
      recordedData: JSON.parse(JSON.stringify(parentData)),
      scheduledTimesCache: parentCache ? JSON.parse(JSON.stringify(parentCache)) : {},
      source: 'memory',
      tripCount
    };
  }

  async function loadFromGitHub(dateStr) {
    if (!GITHUB_RAW_BASE) {
      throw new Error('No GitHub repo configured (githubRepo missing in config.json). Cannot load recordings from GitHub.');
    }

    const response = await fetch(`${GITHUB_RAW_BASE}/recordedRTData/${dateStr}.json`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    return {
      ...data,
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
          if (!data.recordedData) {
            reject(new Error('Invalid file format: missing recordedData'));
            return;
          }
          resolve({
            ...data,
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
    const { recordedData, scheduledTimesCache = {} } = data;
    
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
        
        // Skip if no actual arrival time
        if (!stop.arr) continue;
        
        // Get scheduled arrival time (already in epoch seconds)
        const scheduledEpoch = stop.sch_arr || stop.sch_dep;
        // Also capture recorded (actual) times for this trip
        const actualEpoch = stop.arr || stop.dep || null;
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
            scheduledArrival: scheduledEpoch
          });
          debugSampleShown = true;
        }
        
        // Calculate delta (positive = late, negative = early)
        const delta = stop.arr - scheduledEpoch;
        
        const stopDelta = {
          tripId,
          routeId: trip.rid,
          stopId: stop.sid,
          stopSeq: stop.seq,
          delta,
          incrementalDelay: null, // Will be computed after all stops are processed
          scheduledEpoch: scheduledEpoch
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
    console.log('[Viewer] Aggregating busiest routes:', {
      totalTrips: tripSummaries.length,
      selectedRoutes: Array.from(selectedRoutes),
      preComputedRoutes: Object.keys(routeStats).length
    });
    
    // Use pre-computed routeStats instead of filtering stopDeltas (O(1) instead of O(trips * stops))
    const aggregations = [];
    
    for (const routeId in routeStats) {
      if (selectedRoutes.size > 0 && !selectedRoutes.has(routeId)) continue;
      
      const stats = routeStats[routeId];
      const avgDelay = stats.delayCount > 0 ? stats.delaySum / stats.delayCount : 0;
      
      // Only include if route has valid trip data
      if (stats.tripCount > 0) {
        aggregations.push({
          routeId,
          tripHours: stats.tripHours,
          tripCount: stats.tripCount,
          avgDelay,
          delayCount: stats.delayCount
        });
      }
    }
    
    // Sort by tripHours descending, take top 10
    aggregations.sort((a, b) => b.tripHours - a.tripHours);
    const topRoutes = aggregations.slice(0, 10);
    
    console.log('[Viewer] Busiest routes aggregation result:', {
      totalRoutes: aggregations.length,
      top10Count: topRoutes.length,
      top10: topRoutes.map(r => ({ 
        route: r.routeId, 
        tripHours: r.tripHours.toFixed(2), 
        avgDelay: r.avgDelay.toFixed(0) 
      }))
    });
    
    return topRoutes;
  }

  function aggregateHourlyDelayByRoute(stopDeltas, selectedRoutes, routeStats, timeFilterStartEpoch, timeFilterEndEpoch) {
    const TOP_N_ROUTES = 5;
    
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
    
    // Wait for window to fully load, then inject data references
    // The child window will auto-initialize itself
    const checkLoad = setInterval(() => {
      if (viewerWindow.document.readyState === 'complete') {
        clearInterval(checkLoad);
        // Inject data accessors into the child window
        viewerWindow.parentRecordedData = typeof recordedData !== 'undefined' ? recordedData : null;
        viewerWindow.parentScheduledTimesCache = typeof scheduledTimesCache !== 'undefined' ? scheduledTimesCache : null;
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
    
    // Data source selection
    dataSourceSelect.addEventListener('change', async (e) => {
      const source = e.target.value;
      
      githubDateContainer.style.display = 'none';
      fileUploadContainer.style.display = 'none';
      loadDataBtn.disabled = true;
      loadError.style.display = 'none';
      
      if (source === 'memory') {
        loadDataBtn.disabled = false;
      } else if (source === 'github') {
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
        
        if (source === 'memory') {
          data = await loadFromMemory();
          updateStatusBadge(statusBadge, `Loaded from memory: ${data.tripCount} trips`, 'success');
        } else if (source === 'github') {
          const date = githubDateSelect.value;
          data = await loadFromGitHub(date);
          updateStatusBadge(statusBadge, `Loaded from GitHub: ${date}`, 'info');
        } else if (source === 'file') {
          const file = fileInput.files[0];
          data = await loadFromFile(file);
          updateStatusBadge(statusBadge, `Loaded from file: ${file.name}`, 'info');
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
        
        // Initialize route filter
        initializeRouteFilter(doc, processed.tripSummaries);
        
        // Setup tab switching
        setupTabSwitching(doc);
        
        // Update time filter range (initially all routes are selected)
        updateTimeFilterRangeFromRouteSelection(doc);
        
        // Render charts with all routes selected
        renderCharts(doc);
        
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
    
    applyFilterBtn.addEventListener('click', () => {
      const checkboxes = doc.querySelectorAll('.route-filter input[type="checkbox"]:checked');
      selectedRouteIds.clear();
      checkboxes.forEach(cb => selectedRouteIds.add(cb.value));
      
      // Read time filter values (extended HH:MM[:SS]) and compute epoch range
      const timeStartInput = doc.getElementById('timeStart');
      const timeEndInput = doc.getElementById('timeEnd');

      if (timeStartInput.value && timeEndInput.value && timeFilterBaseDay != null) {
        const offsetStart = parseExtendedTimeToOffset(timeStartInput.value);
        const offsetEnd = parseExtendedTimeToOffset(timeEndInput.value);
        if (offsetStart != null && offsetEnd != null) {
          timeFilterStartEpoch = timeFilterBaseDay + offsetStart;
          timeFilterEndEpoch = timeFilterBaseDay + offsetEnd;
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
      
      // Update time filter range based on current dataset
      updateTimeFilterRange(doc);
      
      // Debug: Show detailed stop-level data for up to 20 random trips
      const filteredTrips = processedData.tripSummaries.filter(t => 
        selectedRouteIds.size === 0 || selectedRouteIds.has(t.routeId)
      );
      
      const sampleSize = Math.min(20, filteredTrips.length);
      const randomTrips = [];
      const usedIndices = new Set();
      
      while (randomTrips.length < sampleSize && usedIndices.size < filteredTrips.length) {
        const idx = Math.floor(Math.random() * filteredTrips.length);
        if (!usedIndices.has(idx)) {
          usedIndices.add(idx);
          randomTrips.push(filteredTrips[idx]);
        }
      }
      
      console.log(`[Viewer Debug] Showing detailed stop data for ${randomTrips.length} random trips:`);
      
      randomTrips.forEach((tripSummary, tripIdx) => {
        const tripData = currentData.recordedData[tripSummary.tripId];
        if (!tripData) return;
        
        const stopDetails = [];
        for (const stopSeq in tripData.stops) {
          const stop = tripData.stops[stopSeq];
          const scheduledEpoch = stop.sch_arr || stop.sch_dep;
          const delta = (stop.arr && scheduledEpoch) ? stop.arr - scheduledEpoch : null;
          
          stopDetails.push({
            seq: stop.seq,
            stopId: stop.sid,
            scheduledEpoch: scheduledEpoch,
            actualEpoch: stop.arr,
            actualTime: stop.arr ? new Date(stop.arr * 1000).toISOString() : 'MISSING',
            delta: delta !== null ? `${delta}s (${formatDuration(delta)})` : 'NULL'
          });
        }
        
        console.log(`[Viewer Debug] Trip ${tripIdx + 1}/${randomTrips.length}:`, {
          tripId: tripSummary.tripId,
          routeId: tripSummary.routeId,
          vehicleId: tripSummary.vehicleId,
          maxDelay: tripSummary.maxDelay !== null ? `${tripSummary.maxDelay}s (${formatDuration(tripSummary.maxDelay)})` : 'NULL',
          stopCount: stopDetails.length,
          stops: stopDetails
        });
      });
      
      renderCharts(doc);
    });
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
    const timeStartInput = doc.getElementById('timeStart');
    const timeEndInput = doc.getElementById('timeEnd');
    const timeRangeInfo = doc.getElementById('timeRangeInfo');

    if (!processedData.tripSummaries || processedData.tripSummaries.length === 0) {
      timeStartInput.disabled = true;
      timeEndInput.disabled = true;
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
      timeStartInput.disabled = false;
      timeEndInput.disabled = false;

      // Base day is the midnight epoch of the earliest recorded time
      const baseDay = Math.floor(minTime / 86400) * 86400;
      timeFilterBaseDay = baseDay;

      // Show extended HH:MM:SS where hours may be >24
      timeStartInput.value = convertEpochToExtendedTime(minTime, baseDay);
      timeEndInput.value = convertEpochToExtendedTime(maxTime, baseDay);
      // Update the available range display using day-prefix formatting
      if (timeRangeInfo) {
        const startDisplay = formatEpochWithDayPrefix(minTime, baseDay);
        const endDisplay = formatEpochWithDayPrefix(maxTime, baseDay);
        timeRangeInfo.innerHTML = `Available range: ${startDisplay} to ${endDisplay}`;
      }
    } else {
      timeStartInput.disabled = true;
      timeEndInput.disabled = true;
      if (timeRangeInfo) timeRangeInfo.innerHTML = 'No valid scheduled times found';
    }
  }
  
  // Update time filter range based on applied selectedRouteIds
  function updateTimeFilterRange(doc) {
    const timeStartInput = doc.getElementById('timeStart');
    const timeEndInput = doc.getElementById('timeEnd');
    const timeRangeInfo = doc.getElementById('timeRangeInfo');
    
    if (!processedData.tripSummaries || processedData.tripSummaries.length === 0) {
      timeStartInput.disabled = true;
      timeEndInput.disabled = true;
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
      timeStartInput.disabled = false;
      timeEndInput.disabled = false;
      
      // Set default values if not already set
      if (!timeStartInput.value) {
        timeStartInput.value = convertScheduledToTimeInput(minTime);
      }
      if (!timeEndInput.value) {
        timeEndInput.value = convertScheduledToTimeInput(maxTime);
      }
      // Compute base day and display with day-prefix formatting so hours >=24 or D+HH:MM:SS are shown
      const baseDay = Math.floor(minTime / 86400) * 86400;
      timeFilterBaseDay = baseDay;
      if (timeRangeInfo) {
        const startDisplay = formatEpochWithDayPrefix(minTime, baseDay);
        const endDisplay = formatEpochWithDayPrefix(maxTime, baseDay);
        timeRangeInfo.innerHTML = `Available range: ${startDisplay} to ${endDisplay}`;
      }
    } else {
      timeStartInput.disabled = true;
      timeEndInput.disabled = true;
      if (timeRangeInfo) {
        timeRangeInfo.innerHTML = 'No valid scheduled times found';
      }
    }
  }
  
  function setupTabSwitching(doc) {
    const tabs = doc.querySelectorAll('.tab');
    const tabContents = doc.querySelectorAll('.tab-content');
    
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
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
                // Re-render with current filters
                renderCharts(doc);
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

  function clamp(number, min, max) {
    return Math.min(max, Math.max(min, number));
  }

  function getHeatLayerOptionsForZoom(zoom) {
    // TUNING GUIDE: Adjust radius/blur vs. zoom here
    const radius = clamp(Math.round(10 + Math.pow(zoom-10, 1.5) * 2.0), 10, 55);
    const blur = clamp(Math.round(radius * 0.85), 8, 45);

    console.log(`[Viewer] Heatmap options for zoom ${zoom}: radius=${radius}px, blur=${blur}px, minOpacity=${zoom >= 16 ? 0.25 : (zoom >= 14 ? 0.35 : 0.5)}`);

    // Slightly reduce opacity at high zoom to avoid full-map saturation.
    const minOpacity = zoom >= 16 ? 0.25 : (zoom >= 14 ? 0.35 : 0.5);

    return {
      radius,
      blur,
      maxZoom: 18,
      max: 1.0,
      minOpacity,
      gradient: {
        0.0: 'blue',
        0.2: 'lime',
        0.4: 'yellow',
        0.6: 'orange',
        0.8: 'red',
        1.0: 'darkred'
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

      // Initialize Leaflet map centered on Toronto
      leafletMap = L.map(mapContainer, {
        center: [43.65, -79.38],
        zoom: 11,
        preferCanvas: true
      });
      
      // Add OpenStreetMap tile layer
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 18
      }).addTo(leafletMap);

      // Rebuild heat when zoom changes to keep it readable at high zoom.
      leafletMap.on('zoomend', () => {
        rebuildHeatLayer();
      });
      
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
    } catch (err) {
    }
  }

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
      
      // Get route name if available
      const routeName = routesData && routesData[routeId] ? routesData[routeId].route_long_name : null;
      const displayText = routeName ? ` ${routeId} - ${routeName}` : ` ${routeId}`;
      
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

  function renderCharts(doc) {
    console.log('[Viewer] Updating charts with:', {
      tripSummaries: processedData.tripSummaries.length,
      stopDeltas: processedData.stopDeltas.length,
      selectedRoutes: Array.from(selectedRouteIds)
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
    
    // Update heatmap (pass all filtered stop deltas, not just top 20)
    updateHeatmap(filteredStopDeltas);
    
    // Update stats tab
    renderStatsTab(doc, filteredTripSummaries, filteredStopDeltas);
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
          arr: stop.arr || null,
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
  // EXPORTS
  // ============================================================================

  window.RTRecordingViewer = {
    open: openViewer,
    sampleTrips: sampleTripsForRoute
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
