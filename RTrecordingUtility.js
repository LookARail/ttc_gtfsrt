/**
 * RT Recording Utility - Support Functions
 * Migrated from gtfsWebClient/support.js
 * Provides GTFS shape and subshape analysis utilities
 */

(function() {
  'use strict';

  // ========== HEATMAP METRIC CONFIGURATION ==========
  // Defines color bins and thresholds for different heatmap metrics
  // Edit these values here to customize metric visualization appearance
  
  const HEATMAP_METRICS = {
    travelTime: {
      title: 'Travel Time',
      unit: 'km/h',
      description: 'Average speed (km/h)',
      colorBuckets: [
        { min: 50, max: Infinity, name: 'Very Good', color: '#388e3c' },      // Dark Green
        { min: 30, max: 50, name: 'Good', color: '#7cb342' },                // Light Green
        { min: 15, max: 30, name: 'Normal', color: '#fbc02d' },              // Yellow
        { min: 5, max: 15, name: 'Slow', color: '#f57c00' },                 // Orange
        { min: 0, max: 5, name: 'Stopped/Stopped', color: '#d32f2f' },      // Red
      ]
    },
    variance: {
      title: 'Travel Time Variance',
      unit: 'ratio',
      description: 'Variability: worst 20% / best 20% (lower = more consistent)',
      colorBuckets: [
        { min: 4.0, max: Infinity, name: 'Highly Variable', color: '#ef4444' },       // Red
        { min: 2.5, max: 4.0, name: 'Variable', color: '#f97316' },                  // Orange
        { min: 1.6, max: 2.5, name: 'Somewhat Consistent', color: '#eab308' },      // Yellow
        { min: 1.2, max: 1.6, name: 'Consistent', color: '#84cc16' },               // Light Green
        { min: 1.0, max: 1.2, name: 'Very Consistent', color: '#22c55e' },           // Green
      ]
    },
    adherence: {
      title: 'Travel Time Adherence',
      unit: 'ratio',
      description: 'Schedule adherence: actual / scheduled (1.0 = perfect, deviation = bad)',
      colorBuckets: [
        { min: 0.5, max: 0.7, name: 'Much Slower', color: '#ef4444' },               // Red
        { min: 0.7, max: 0.8, name: 'Slower than Schedule', color: '#f97316' },      // Orange
        { min: 0.8, max: 1.25, name: 'On Schedule', color: '#22c55e' },              // Green (0.8-1.25 = ±25%)
        { min: 1.25, max: 1.4, name: 'Faster than Schedule', color: '#1387e6' },     // Blue
        { min: 1.4, max: Infinity, name: 'Much Faster', color: '#000000' }           // Black
      ]
    }
  };

  /**
   * Calculate haversine distance between two geographic points
   * @param {number} lat1 - Starting latitude  
   * @param {number} lon1 - Starting longitude
   * @param {number} lat2 - Ending latitude
   * @param {number} lon2 - Ending longitude
   * @returns {number} Distance in meters
   */
  function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth radius in meters
    const toRad = deg => deg * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + 
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /**
   * Find closest shape point index to a given stop location
   * @param {number} stopLat - Stop latitude
   * @param {number} stopLon - Stop longitude
   * @param {Array} shapePoints - Array of shape points with {lat, lon}
   * @returns {number} Index of closest shape point, or -1 if no points
   */
  function findClosestShapePointIndex(stopLat, stopLon, shapePoints) {
    if (!shapePoints || shapePoints.length === 0) return -1;
    let minDist = Infinity;
    let closestIdx = -1;
    for (let i = 0; i < shapePoints.length; i++) {
      const pt = shapePoints[i];
      const dist = haversineDistance(stopLat, stopLon, pt.lat, pt.lon);
      if (dist < minDist) {
        minDist = dist;
        closestIdx = i;
      }
    }
    return closestIdx;
  }

  /**
   * Calculate cumulative distance between two shape point indices
   * @param {Array} shapePoints - Array of shape points with {lat, lon}
   * @param {number} fromIdx - Starting index
   * @param {number} toIdx - Ending index
   * @returns {number} Distance in meters between fromIdx and toIdx
   */
  function getDistanceBetweenShapePoints(shapePoints, fromIdx, toIdx) {
    if (!shapePoints || fromIdx < 0 || toIdx < 0 || fromIdx > toIdx) return 0;
    
    let totalDist = 0;
    for (let i = fromIdx; i < toIdx; i++) {
      const p1 = shapePoints[i];
      const p2 = shapePoints[i + 1];
      totalDist += haversineDistance(p1.lat, p1.lon, p2.lat, p2.lon);
    }
    return totalDist;
  }

  /**
   * Generate a unique 8-character hex ID for a segment
   * @returns {string} Unique hex ID (e.g., "a1b2c3d4")
   */
  function generateSegmentId() {
    return Math.random().toString(16).substring(2, 10);
  }

  // Reference to persistent masterSegments cache (only valid after visualization call)
  // Populated on each visualization call to hold reference to the persistent cache
  let currentMasterSegments = null;

  /**
   * Segment class - represents a unique station-to-station corridor
   * Can be shared by multiple routes
   */
  class Segment {
    constructor(fromStopId, toStopId, fromStopName, toStopName, coordinates, distance) {
      this.id = `${fromStopId}_${toStopId}`;
      this.segmentId = generateSegmentId(); // Unique ID for this session
      this.fromStopId = fromStopId;
      this.toStopId = toStopId;
      this.fromStopName = fromStopName;
      this.toStopName = toStopName;
      this.coordinates = coordinates;
      this.distance = distance;
      this.routes = new Set(); // Set of routeIds
      this.shapes = new Set(); // Set of shapeIds that use this segment
      this.parentShapeIds = []; // Array of shapeIds that created or can use this segment
      this.travelTimeSamples = []; // Array of {tripId, routeId, travelTimeSeconds}
    }

    addRoute(routeId) {
      this.routes.add(routeId);
    }
    
    addShape(shapeId) {
      this.shapes.add(shapeId);
      if (!this.parentShapeIds.includes(shapeId)) {
        this.parentShapeIds.push(shapeId);
      }
    }

    addTravelTime(tripId, routeId, travelTimeSeconds) {
      this.travelTimeSamples.push({ tripId, routeId, travelTimeSeconds });
    }

    getAverageSpeedKmh() {
      if (this.travelTimeSamples.length === 0 || this.distance === 0) return 0;
      const avgTimeSeconds = this.travelTimeSamples.reduce((sum, s) => sum + s.travelTimeSeconds, 0) / this.travelTimeSamples.length;
      const hours = avgTimeSeconds / 3600;
      return this.distance / hours;
    }

    /**
     * Calculate travel time variance (worst 20% / best 20%)
     * Returns ratio: 1.0 = perfect consistency, >2.0 = highly variable
     * Only considers samples with valid positive travel times
     */
    getVariance() {
      if (!this.travelTimeSamples || this.travelTimeSamples.length < 5) return null;
      
      const validTimes = this.travelTimeSamples
        .map(s => s.travelTimeSeconds)
        .filter(t => t > 0);
      
      if (validTimes.length < 5) return null; // Need at least 5 samples
      
      const sorted = [...validTimes].sort((a, b) => a - b);
      const bottomIndex = Math.ceil(sorted.length * 0.2); // 20% fastest
      const topIndex = Math.floor(sorted.length * 0.8);   // Bottom of top 20% (slowest)
      
      if (topIndex >= sorted.length) return null;
      
      const best20 = sorted.slice(0, bottomIndex);
      const worst20 = sorted.slice(topIndex);
      
      if (best20.length === 0 || worst20.length === 0) return null;
      
      const best20AvgTime = best20.reduce((a, b) => a + b, 0) / best20.length;
      const worst20AvgTime = worst20.reduce((a, b) => a + b, 0) / worst20.length;
      
      if (best20AvgTime <= 0) return null;
      
      // Variance ratio: worst / best (higher = more variable)
      return worst20AvgTime / best20AvgTime;
    }

    /**
     * Calculate travel time adherence (actual / scheduled)
     * Returns ratio: 1.0 = perfect adherence, <1.0 = slower than schedule, >1.0 = faster
     * Note: This requires stopDeltasByTrip data passed at computation time
     */
    getAdherence(stopDeltasByTrip) {
      if (!stopDeltasByTrip || Object.keys(stopDeltasByTrip).length === 0) return null;
      
      const actualTimes = [];
      const scheduledTimes = [];
      
      // Collect actual and scheduled times from all samples
      for (const sample of this.travelTimeSamples) {
        const stopDeltas = stopDeltasByTrip[sample.tripId];
        if (!stopDeltas) continue;
        
        // Find stops for this segment
        const originStop = stopDeltas.find(s => s.stopId === this.fromStopId);
        const destStop = stopDeltas.find(s => s.stopId === this.toStopId);
        
        if (!originStop || !destStop) continue;
        
        // Collect both actual times (which we already have in samples)
        if (sample.travelTimeSeconds > 0) {
          actualTimes.push(sample.travelTimeSeconds);
        }
        
        // Collect scheduled times
        if (originStop.scheduledEpoch && destStop.scheduledEpoch) {
          const scheduledTime = destStop.scheduledEpoch - originStop.scheduledEpoch;
          if (scheduledTime > 0) {
            scheduledTimes.push(scheduledTime);
          }
        }
      }
      
      if (actualTimes.length < 5 || scheduledTimes.length < 5) return null; // Need at least 5 samples
      
      // Calculate averages
      const avgActual = actualTimes.reduce((a, b) => a + b, 0) / actualTimes.length;
      const avgScheduled = scheduledTimes.reduce((a, b) => a + b, 0) / scheduledTimes.length;
      
      if (avgScheduled <= 0 || avgActual <= 0) return null;
      
      // Adherence ratio: actual / scheduled
      // < 1.0 = faster than schedule (good)
      // = 1.0 = perfect adherence
      // > 1.0 = slower than schedule (bad)
      return avgActual / avgScheduled;
    }
  }

  /**
   * Build subshape geometry and statistics for a segment
   * Uses the first trip's recorded stop sequence (deterministic), builds shape coords and distance
   * 
   * @param {string} fromStopId - Origin stop
   * @param {string} toStopId - Destination stop
   * @param {string} shapeId - Shape ID to extract coordinates from
   * @param {Object} gtfsData - GTFS data with stops and shapes
   * @param {Array} tripsForThisShape - All trips using this shape (for speed calculation)
   * @param {Object} stopDeltasByTrip - Stop data with actual times for speed calculation
   * @returns {Object} Subshape object with {origin_station, destination_station, distance, coordinates, speedKmh, color}
   */
  function buildSubshapeGeometry(fromStopId, toStopId, shapeId, gtfsData, tripsForThisShape, stopDeltasByTrip) {
    const fullShape = gtfsData.shapes[shapeId];
    const stops = gtfsData.stops;
    
    if (!fullShape || !stops[fromStopId] || !stops[toStopId]) return null;

    const originStop = stops[fromStopId];
    const destStop = stops[toStopId];

    // Find closest shape points to stop locations
    let startIdx = findClosestShapePointIndex(originStop.stop_lat, originStop.stop_lon, fullShape);
    if (startIdx < 0) startIdx = 0;

    let endIdx = findClosestShapePointIndex(destStop.stop_lat, destStop.stop_lon, fullShape);
    if (endIdx < 0) endIdx = fullShape.length - 1;

    // Ensure we're going forward
    if (endIdx <= startIdx) {
      endIdx = Math.min(startIdx + 1, fullShape.length - 1);
    }

    // Extract subshape coordinates
    const subshapeCoords = [];
    for (let j = startIdx; j <= endIdx; j++) {
      subshapeCoords.push({
        lat: fullShape[j].lat,
        lon: fullShape[j].lon
      });
    }

    // Calculate distance
    let distance = 0;
    const traveledValues = fullShape
      .map(pt => pt.shape_dist_traveled)
      .filter(val => val !== undefined && val !== null);
    const hasValidDistanceData = traveledValues.some(val => val > 0);

    if (hasValidDistanceData) {
      const startDistTraveled = fullShape[startIdx].shape_dist_traveled || 0;
      const endDistTraveled = fullShape[endIdx].shape_dist_traveled || 0;
      distance = Math.abs(endDistTraveled - startDistTraveled);
    } else {
      const distanceMeters = getDistanceBetweenShapePoints(fullShape, startIdx, endIdx);
      distance = distanceMeters * 0.001;  // Convert meters to km
    }

    // Calculate average speed for this segment across all trips using this shape
    let speedKmh = 0;
    if (tripsForThisShape && tripsForThisShape.length > 0 && stopDeltasByTrip) {
      const travelTimes = [];
      
      for (const trip of tripsForThisShape) {
        const stopDeltas = stopDeltasByTrip[trip.tripId];
        if (!stopDeltas || stopDeltas.length === 0) continue;
        
        // Find this segment's stops in this trip
        const originStopInTrip = stopDeltas.find(s => s.stopId === fromStopId);
        const destStopInTrip = stopDeltas.find(s => s.stopId === toStopId);
        
        // Calculate travel time if both stops have actual arrival data
        if (originStopInTrip && destStopInTrip && originStopInTrip.actualEpoch && destStopInTrip.actualEpoch) {
          const travelTimeSeconds = destStopInTrip.actualEpoch - originStopInTrip.actualEpoch;
          if (travelTimeSeconds > 0) {
            travelTimes.push(travelTimeSeconds);
          }
        }
      }
      
      // Calculate average speed
      if (travelTimes.length > 0 && distance > 0) {
        const avgTravelTimeSeconds = travelTimes.reduce((a, b) => a + b, 0) / travelTimes.length;
        const hours = avgTravelTimeSeconds / 3600;
        speedKmh = distance / hours;
      }
    }

    // Map speed to color (5-bin)
    const color = getSpeedColor(speedKmh);

    return {
      fromStopId,
      toStopId,
      origin_station: originStop.stop_name,
      destination_station: destStop.stop_name,
      distance: Number(distance.toFixed(3)),
      coordinates: subshapeCoords,
      speedKmh: Number(speedKmh.toFixed(1)),
      color
    };
  }

  /**
   * Builds segments deterministically from first trip's recorded stop sequence
   * Accumulates travel time statistics across all trips
   * 
   * @param {Array} tripSummaries - Array of trip summary objects from RTRecordingViewer
   * @param {Object} routeStats - Route statistics object with tripHours data
   * @param {Object} gtfsData - GTFS data object (trips, shapes, stops, routes)
   * @param {Object} recordedStopTimes - Recorded stop times data keyed by tripId (stop sequence per trip)
   * @param {Object} leafletMap - Leaflet map instance
   * @param {Object} stopDeltasByTrip - Full stop data with actual times for travel time calculation
   * @param {Object} masterSegments - Persistent segment cache across calls (cleared only on data reload)
   * @param {number} topN - Number of top routes to visualize (default 10)
   * @param {string} metric - Heatmap metric: 'travelTime', 'variance', or 'adherence' (default 'travelTime')
   * @returns {Promise<Object>} Object with { topRoutes, segmentsByRoute, metadata }
   */
  async function visualizeSegmentsForTopRoutes(tripSummaries, routeStats, gtfsData, recordedStopTimes, leafletMap, stopDeltasByTrip, masterSegments, topN = 10, metric = 'travelTime') {
    if (!leafletMap) {
      console.error('[RTUtil] Map not available');
      return { topRoutes: [], segmentsByRoute: {}, metadata: { error: 'Map not available' } };
    }

    // DEBUG: Show what data was passed in
    console.log('[RTUtil] Function called with:', {
      tripSummariesCount: tripSummaries?.length || 0,
      stopDeltasByTripCount: stopDeltasByTrip ? Object.keys(stopDeltasByTrip).length : 0,
      masterSegmentsCount: masterSegments ? Object.keys(masterSegments).length : 0,
      topN
    });

    if (!gtfsData || !gtfsData.trips || !gtfsData.shapes) {
      console.error('[RTUtil] GTFS data not loaded');
      return { topRoutes: [], segmentsByRoute: {}, metadata: { error: 'GTFS data not loaded' } };
    }

    if (!masterSegments) {
      console.error('[RTUtil] masterSegments not provided');
      return { topRoutes: [], segmentsByRoute: {}, metadata: { error: 'masterSegments not available' } };
    }

    try {
      console.time('[RTUtil] TOTAL VISUALIZATION TIME');
      console.log(`[RTUtil] Starting visualization of top ${topN} busiest routes`);

      // Step 1: Clear all existing objects on map (but NOT segments cache - it persists)
      // Store reference to masterSegments for debug function lookups
      currentMasterSegments = masterSegments;
      if (window.subshapesLayer) {
        try {
          leafletMap.removeLayer(window.subshapesLayer);
          console.log('[RTUtil] Removed existing subshapes layer from map');
        } catch (e) {
          console.warn('[RTUtil] Could not remove existing layer:', e);
        }
        window.subshapesLayer = null;
      }
      
      // Verify Leaflet is available
      if (typeof L === 'undefined') {
        console.error('[RTUtil] Leaflet (L) is not defined!');
        return { topRoutes: [], segmentsByRoute: {}, metadata: { error: 'Leaflet not available' } };
      }
      
      window.subshapesLayer = L.layerGroup();

      // Step 2: Calculate top N busiest routes by trip-hours
      const routeMap = {};
      for (const trip of tripSummaries) {
        if (!trip.routeId || !routeStats[trip.routeId]) continue;
        if (trip.scheduledDuration === null) continue;

        if (!routeMap[trip.routeId]) {
          routeMap[trip.routeId] = {
            routeId: trip.routeId,
            tripHours: routeStats[trip.routeId].tripHours || 0,
            tripCount: 0
          };
        }
        routeMap[trip.routeId].tripCount++;
      }

      const routeList = Object.values(routeMap);
      routeList.sort((a, b) => b.tripHours - a.tripHours);
      const topRoutes = routeList.slice(0, topN);

      // Step 2b: Create a Set of recorded trip IDs for fast lookup (time-filtered trips)
      // This ensures we only use trips from the current time filter, not all GTFS trips
      const recordedTripIds = new Set(tripSummaries.map(t => t.tripId));

      // Step 2c: Create filtered copy of stopDeltasByTrip containing only time-filtered trips
      const filteredStopDeltasByTrip = {};
      for (const tripId of recordedTripIds) {
        if (stopDeltasByTrip[tripId]) {
          filteredStopDeltasByTrip[tripId] = stopDeltasByTrip[tripId];
        }
      }

      // Step 3: Track segments used for these top routes for visualization
      const segmentsByRoute = {};
      const trips = gtfsData.trips;

      for (const routeData of topRoutes) {
        const routeId = routeData.routeId;
        const isFirstRoute = routeData === topRoutes[0];
        if (isFirstRoute) console.time(`[RTUtil] ROUTE ${routeId} (FIRST ROUTE TIMING)`);
        
        segmentsByRoute[routeId] = {
          routeId,
          tripHours: routeData.tripHours,
          tripCount: routeData.tripCount,
          shapes: {}
        };

        // Find all trips belonging to this route (only from recorded/time-filtered set)
        const tripsForRoute = Object.entries(trips)
          .filter(([tripId, trip]) => trip.route_id === routeId && recordedTripIds.has(tripId))
          .map(([tripId, trip]) => ({ tripId, ...trip }));

        // Extract unique shape_ids
        const uniqueShapeIds = [...new Set(tripsForRoute.map(t => t.shape_id).filter(Boolean))];

        //console.log(`[RTUtil] Route ${routeId}: ${tripsForRoute.length} trips, ${uniqueShapeIds.length} unique shapes`);

        // Step 4: For each shape, use first trip's stop sequence to build segments
        for (const shapeId of uniqueShapeIds) {
          if (isFirstRoute) console.time(`[RTUtil]   Shape ${shapeId}`);
          try {
            // Filter trips for this specific shape
            const tripsForThisShape = tripsForRoute.filter(t => t.shape_id === shapeId);
            
            if (tripsForThisShape.length === 0) {
              if (isFirstRoute) console.timeEnd(`[RTUtil]   Shape ${shapeId}`);
              continue;
            }

            // Use trip with MOST stops recorded (best data quality for stop sequence)
            // Sort by stop count descending, so trips with more stops come first
            const sortedTrips = tripsForThisShape.map(trip => ({
              trip,
              stopCount: recordedStopTimes[trip.tripId] ? recordedStopTimes[trip.tripId].length : 0
            }))
            .sort((a, b) => b.stopCount - a.stopCount);
            
            const firstTrip = sortedTrips[0]?.trip;
            
            if (!firstTrip) {
              if (isFirstRoute) console.timeEnd(`[RTUtil]   Shape ${shapeId}`);
              continue;
            }
            
            const stopSequence = recordedStopTimes[firstTrip.tripId];

            if (!stopSequence || stopSequence.length < 2) {
              if (isFirstRoute) console.timeEnd(`[RTUtil]   Shape ${shapeId}`);
              continue;
            }


            // Step 5: For each consecutive stop pair in the sequence, build/update segment
            const shapeSubshapes = [];
            for (let i = 0; i < stopSequence.length - 1; i++) {
              const fromStopId = stopSequence[i].stop_id;
              const toStopId = stopSequence[i + 1].stop_id;
              const segmentKey = `${fromStopId}_${toStopId}`;

              let segment = null;

              // Check if segment already exists in master cache
              if (masterSegments[segmentKey]) {
                segment = masterSegments[segmentKey];
                //console.log(`[RTUtil]     Reusing existing segment ${segmentKey} for route ${routeId}, shape ${shapeId}`);
                segment.addRoute(routeId);
                segment.addShape(shapeId);
              } else {
                // Build new segment: get geometry from shape
                const subshape = buildSubshapeGeometry(fromStopId, toStopId, shapeId, gtfsData, tripsForThisShape, stopDeltasByTrip);
                
                if (!subshape) {
                  continue;
                }

                // Create new segment with geometry
                segment = new Segment(
                  subshape.fromStopId,
                  subshape.toStopId,
                  subshape.origin_station,
                  subshape.destination_station,
                  subshape.coordinates,
                  subshape.distance
                );
                segment.addRoute(routeId);
                segment.addShape(shapeId);
                
                // Add to master cache for persistence
                masterSegments[segmentKey] = segment;
              }

              shapeSubshapes.push(segmentKey);
            }

            segmentsByRoute[routeId].shapes[shapeId] = shapeSubshapes;

          } catch (err) {
            console.error(`[RTUtil] Error processing shape ${shapeId} for route ${routeId}:`, err);
          }
        }
        
        if (isFirstRoute) console.timeEnd(`[RTUtil] ROUTE ${routeId} (FIRST ROUTE TIMING)`);
      }

      // Step 6: Aggregate travel times for segments from all trips (time-filtered only)
      // First, clear travel time samples for all segments (fresh data for this visualization)
      for (const segmentKey in masterSegments) {
        masterSegments[segmentKey].travelTimeSamples = [];
      }
      console.log(`[RTUtil] Cleared travel time samples. Aggregating across ${Object.keys(filteredStopDeltasByTrip).length} time-filtered trips...`);
      
      for (const tripId in filteredStopDeltasByTrip) {
        const stopDeltas = filteredStopDeltasByTrip[tripId];
        const routeId = stopDeltas[0]?.routeId;
        
        // For each consecutive pair of stops in this trip
        for (let i = 0; i < stopDeltas.length - 1; i++) {
          const originStop = stopDeltas[i];
          const destStop = stopDeltas[i + 1];
          
          if (!originStop.actualEpoch || !destStop.actualEpoch) continue;
          
          const segmentKey = `${originStop.stopId}_${destStop.stopId}`;
          const segment = masterSegments[segmentKey];
          
          if (segment) {
            const travelTimeSeconds = destStop.actualEpoch - originStop.actualEpoch;
            if (travelTimeSeconds > 0) {
              segment.addTravelTime(tripId, routeId, travelTimeSeconds);
            }
          }
        }
      }

      // Step 7: Plot all segments in masterSegments
      console.log(`[RTUtil] Plotting ${Object.keys(masterSegments).length} unique segments on map...`);
      console.log(`[RTUtil] Using metric: ${metric}`);
      
      // Separate segments by whether they have data
      const greySegments = [];
      const coloredSegments = [];
      
      for (const segmentKey in masterSegments) {
        const segment = masterSegments[segmentKey];
        if (!segment) continue;
        
        if (!segment.travelTimeSamples || segment.travelTimeSamples.length === 0) {
          greySegments.push({ segmentKey, segment });
        } else {
          coloredSegments.push({ segmentKey, segment });
        }
      }
      
      // Plot grey segments first (they'll be beneath)
      for (const { segmentKey, segment } of greySegments) {
        const polylineCoords = segment.coordinates.map(p => [p.lat, p.lon]);
        const color = getSegmentMetricColor(segment, metric, stopDeltasByTrip);
        const routeNames = Array.from(segment.routes).sort().join(', ');
        
        let popupContent = `<b>[${segment.segmentId}]</b> ${segment.fromStopName} → ${segment.toStopName}<br>` +
                           `Distance: ${segment.distance.toFixed(3)} km<br>`;
        
        if (metric === 'variance') {
          popupContent += `Variance: Insufficient data<br>`;
        } else if (metric === 'adherence') {
          popupContent += `Adherence: Insufficient data (no scheduled times)<br>`;
        } else {
          popupContent += `Speed: No data<br>`;
        }
        
        popupContent += `Samples: 0<br>Routes: ${routeNames}`;
        const opacity = 1.0; // Grey segments are fully opaque but grey in color
        
        const polyline = L.polyline(polylineCoords, {
          color: color,
          weight: 3,
          opacity: opacity,
          interactive: true
        }).bindPopup(popupContent);
        
        polyline.addTo(window.subshapesLayer);
      }
      
      // Then plot colored segments (they'll be on top)
      for (const { segmentKey, segment } of coloredSegments) {

        const polylineCoords = segment.coordinates.map(p => [p.lat, p.lon]);
        
        // Get color based on selected metric
        const color = getSegmentMetricColor(segment, metric, stopDeltasByTrip);
        
        // Get route names (convert from routeIds)
        const routeNames = Array.from(segment.routes).sort().join(', ');
        
        // Build popup content based on metric
        let popupContent = `<b>[${segment.segmentId}]</b> ${segment.fromStopName} → ${segment.toStopName}<br>` +
                           `Distance: ${segment.distance.toFixed(3)} km<br>`;
        
        if (metric === 'variance') {
          const variance = segment.getVariance();
          if (variance !== null) {
            popupContent += `Variance (worst/best): ${variance.toFixed(2)}<br>`;
          } else {
            popupContent += `Variance: Insufficient data<br>`;
          }
        } else if (metric === 'adherence') {
          const adherence = segment.getAdherence(stopDeltasByTrip);
          if (adherence !== null) {
            popupContent += `Adherence (actual/scheduled): ${adherence.toFixed(2)}<br>`;
          } else {
            popupContent += `Adherence: Insufficient data (no scheduled times)<br>`;
          }
        } else {
          // travelTime metric
          if (segment.travelTimeSamples && segment.travelTimeSamples.length > 0) {
            const avgSpeedKmh = segment.getAverageSpeedKmh();
            popupContent += `Speed: ${avgSpeedKmh.toFixed(1)} km/h<br>`;
          } else {
            popupContent += `Speed: No data<br>`;
          }
        }
        
        popupContent += `Samples: ${segment.travelTimeSamples.length}<br>Routes: ${routeNames}`;
        
        // Set opacity: 60% for colored segments, 30% for grey (no data)
        const opacity = 0.6; // Colored segments are more opaque
        
        const polyline = L.polyline(polylineCoords, {
          color: color,
          weight: 3,
          opacity: opacity,
          interactive: true
        }).bindPopup(popupContent);

        polyline.addTo(window.subshapesLayer);
      }

      // Clear heatmap layer to avoid overlap with subshapes
      if (window.heatmapLayer) {
        try {
          leafletMap.removeLayer(window.heatmapLayer);
          window.heatmapLayer = null;
        } catch (e) {
          // Heatmap might not be on map yet, that's fine
        }
      }

      // Add subshapes layer to map
      try {
        window.subshapesLayer.addTo(leafletMap);
        console.log('[RTUtil] Subshapes layer added to map successfully');
        console.log('[RTUtil] Total polylines plotted:', Object.keys(masterSegments).length);
        
        // Verify the layer is on the map
        if (leafletMap.hasLayer(window.subshapesLayer)) {
          console.log('[RTUtil] ✓ Confirmed: subshapes layer is on the map');
        } else {
          console.error('[RTUtil] ✗ ERROR: subshapes layer is NOT on the map after adding!');
        }
      } catch (e) {
        console.error('[RTUtil] Error adding subshapes layer to map:', e);
      }

      console.timeEnd('[RTUtil] TOTAL VISUALIZATION TIME');
      console.log(`[RTUtil] Visualization complete. Total routes: ${topRoutes.length}, Total segments in master cache: ${Object.keys(masterSegments).length}, Segments plotted: ${Object.keys(masterSegments).length}`);

      return {
        topRoutes,
        segmentsByRoute,
        metadata: {
          timestamp: new Date().toISOString(),
          totalSegmentsPlotted: Object.keys(masterSegments).length,
          totalSegmentsInCache: Object.keys(masterSegments).length
        }
      };

    } catch (err) {
      console.error('[RTUtil] Error in visualizeSegmentsForTopRoutes:', err);
      return { topRoutes: [], segmentsByRoute: {}, metadata: { error: err.message } };
    }
  }

  /**
   * Get color based on speed (5-bin color coding)
   * @param {number} speedKmh - Speed in km/h
   * @returns {string} Hex color code
   */
  function getSpeedColor(speedKmh) {
    // 5-bin color mapping based on average speed
    if (speedKmh < 0.0001) return '#d32f2f'; // Red: stopped/no data (bin starts at 0.0001 to be safe)
    if (speedKmh < 5) return '#d32f2f';      // Red: Stopped / very slow
    if (speedKmh < 15) return '#f57c00';     // Orange: Slow
    if (speedKmh < 30) return '#fbc02d';     // Yellow: Normal
    if (speedKmh < 50) return '#7cb342';     // Light green: Good
    return '#388e3c';                        // Dark green: Very good
  }

  /**
   * Get color based on travel time variance (5-bin color coding)
   * Variance is the ratio of worst 20% travel time / best 20% travel time
   * Lower variance = more consistent = better
   * @param {number} varianceRatio - Variance ratio (1.0 = perfect, higher = worse)
   * @returns {string} Hex color code
   */
  function getVarianceColor(varianceRatio) {
    if (varianceRatio === null || varianceRatio === undefined) return '#cccccc'; // Grey for no data
    const bucket = HEATMAP_METRICS.variance.colorBuckets.find(b => 
      varianceRatio >= b.min && varianceRatio < b.max
    );
    return bucket ? bucket.color : '#cccccc';
  }

  /**
   * Get color based on travel time adherence (5-bin color coding)
   * Adherence is the ratio of actual travel time / scheduled travel time
   * 1.0 = perfect adherence, deviations (both higher and lower) are bad
   * @param {number} adherenceRatio - Adherence ratio (1.0 = perfect)
   * @returns {string} Hex color code
   */
  function getAdherenceColor(adherenceRatio) {
    if (adherenceRatio === null || adherenceRatio === undefined) return '#cccccc'; // Grey for no data
    const bucket = HEATMAP_METRICS.adherence.colorBuckets.find(b => 
      adherenceRatio >= b.min && adherenceRatio < b.max
    );
    return bucket ? bucket.color : '#cccccc';
  }

  /**
   * Get color for a segment based on selected metric
   * Returns grey if segment has no data samples
   * @param {Object} segment - Segment object with travel time samples
   * @param {string} metric - Metric type: 'travelTime', 'variance', 'adherence'
   * @param {Object} stopDeltasByTrip - Stop deltas for adherence calculation (optional)
   * @returns {string} Hex color code
   */
  function getSegmentMetricColor(segment, metric = 'travelTime', stopDeltasByTrip = null) {
    // If no data samples, always return grey
    if (!segment.travelTimeSamples || segment.travelTimeSamples.length === 0) {
      return '#cccccc'; // Grey for no data
    }
    
    switch (metric) {
      case 'variance': {
        const variance = segment.getVariance();
        return getVarianceColor(variance);
      }
      case 'adherence': {
        const adherence = segment.getAdherence(stopDeltasByTrip);
        return getAdherenceColor(adherence);
      }
      case 'travelTime':
      default: {
        const speedKmh = segment.getAverageSpeedKmh();
        return getSpeedColor(speedKmh);
      }
    }
  }

  /**
   * Get route color from GTFS data
   * Uses route_color if available, otherwise uses route_type defaults
   * @param {string} routeId - Route ID
   * @param {Object} gtfsData - GTFS data with routes
   * @returns {string} Hex color code
   */
  function getRouteColor(routeId, gtfsData) {
    const ROUTE_TYPE_DEFAULT_COLORS = {
      0: '#e74c3c',  // Tram / Streetcar
      1: '#3498db',  // Subway / Metro
      2: '#2c3e50',  // Rail
      3: '#e67e22',  // Bus
      4: '#1abc9c',  // Ferry
      11: '#9b59b6', // Trolleybus
      12: '#f39c12'  // Monorail
    };

    if (!gtfsData || !gtfsData.routes) return '#888888';

    const route = gtfsData.routes[routeId];
    if (!route) return '#888888';

    if (route.route_color && route.route_color.length > 0) {
      return route.route_color.startsWith('#')
        ? route.route_color
        : `#${route.route_color}`;
    }

    return ROUTE_TYPE_DEFAULT_COLORS[route.route_type] || '#888888';
  }

  /**
   * Clear subshapes layer from map
   */
  function clearSubshapes(leafletMap) {
    if (window.subshapesLayer && leafletMap) {
      leafletMap.removeLayer(window.subshapesLayer);
      window.subshapesLayer = null;
    }
    console.log('[RTUtil] Subshapes cleared from map');
  }

  /**
   * Debug function to get statistics for a segment by its ID
   * Searches the persistent masterSegments cache by segmentId property
   * Usage: RTUtil.debugSegment('a1b2c3d4')
   * @param {string} segmentId - The unique segment ID
   */
  function debugSegment(segmentId) {
    if (!currentMasterSegments) {
      console.log(`[RTUtil.debugSegment] No visualization data available. Call visualizeSegmentsForTopRoutes() first.`);
      return null;
    }
    
    // Search masterSegments by segmentId property (key is fromStopId_toStopId, not segmentId)
    let segment = null;
    for (const segmentKey in currentMasterSegments) {
      if (currentMasterSegments[segmentKey].segmentId === segmentId) {
        segment = currentMasterSegments[segmentKey];
        break;
      }
    }
    
    if (!segment) {
      console.log(`[RTUtil.debugSegment] Segment ID ${segmentId} not found in cached segments.`);
      console.log(`[RTUtil.debugSegment] Available segments: ${Object.keys(currentMasterSegments).map(k => currentMasterSegments[k].segmentId).join(', ') || 'none'}`);
      return null;
    }
    
    const varianceRatio = segment.getVariance();
    const avgSpeedKmh = segment.getAverageSpeedKmh();
    const routeNames = Array.from(segment.routes).sort().join(', ');
    const shapeNames = Array.from(segment.shapes).sort().join(', ');
    
    const tripIds = [...new Set(segment.travelTimeSamples.map(s => s.tripId))].slice(0, 10);
    
    const debugInfo = {
      segmentId: segment.segmentId,
      stopPair: `${segment.fromStopName} → ${segment.toStopName}`,
      stopIds: `${segment.fromStopId} → ${segment.toStopId}`,
      distance: `${segment.distance.toFixed(3)} km`,
      routes: routeNames,
      shapes: shapeNames,
      samples: segment.travelTimeSamples.length,
      avgSpeed: `${avgSpeedKmh.toFixed(1)} km/h`,
      variance: varianceRatio !== null ? `${varianceRatio.toFixed(2)} (ratio)` : 'Insufficient data (<5 samples)',
      sampleTripIds: tripIds,
      fullData: segment
    };
    
    console.log('[RTUtil.debugSegment] Full segment data:', debugInfo);
    console.log('[RTUtil.debugSegment] Travel time samples:', segment.travelTimeSamples);
    
    return debugInfo;
  }

  // Expose functions to global scope for use in RTRecordingViewer
  if (typeof window !== 'undefined') {
    window.RTUtil = {
      haversineDistance,
      findClosestShapePointIndex,
      getDistanceBetweenShapePoints,
      buildSubshapeGeometry,
      visualizeSegmentsForTopRoutes,
      getRouteColor,
      clearSubshapes,
      debugSegment,
      // Metric configuration and functions
      HEATMAP_METRICS,
      getSegmentMetricColor,
      getSpeedColor,
      getVarianceColor,
      getAdherenceColor
    };
  }

})();
