/**
 * RT Recording Utility - Support Functions
 * Migrated from gtfsWebClient/support.js
 * Provides GTFS shape and subshape analysis utilities
 */

(function() {
  'use strict';

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
   * Segment class - represents a unique station-to-station corridor
   * Can be shared by multiple routes
   */
  class Segment {
    constructor(fromStopId, toStopId, fromStopName, toStopName, coordinates, distance) {
      this.id = `${fromStopId}_${toStopId}`;
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
  }

  /**
   * Generate subshapes for a given shape_id
   * Subshapes represent segments between consecutive stops on a route
   * 
   * @param {string} shapeId - The shape_id to process
   * @param {Object} gtfsData - GTFS data object containing stops, shapes
   * @param {string} tripId - Pre-selected trip ID (viewer already selected this trip for this shape)
   * @param {Object} recordedStopTimes - Recorded stop times data keyed by tripId
   * @param {Array} tripsForThisShape - All trips using this shape (for speed calculation)
   * @param {Object} stopDeltasByTrip - Full stop data with actual times for each trip
   * @returns {Promise<Array>} Array of subshape objects with {origin_station, destination_station, distance, coordinates, speedKmh, color}
   */
  async function generateSubshapesForShapeId(shapeId, gtfsData, tripId, recordedStopTimes, tripsForThisShape, stopDeltasByTrip) {
    if (!gtfsData || !gtfsData.stops || !gtfsData.shapes) {
      console.error('[RTUtil] GTFS data not loaded');
      return [];
    }

    if (!tripId) {
      console.warn(`[RTUtil] No tripId provided for shape_id: ${shapeId}`);
      return [];
    }

    // Get the full shape
    const fullShape = gtfsData.shapes[shapeId];
    if (!fullShape || fullShape.length === 0) {
      console.warn(`[RTUtil] No shape found for shape_id: ${shapeId}`);
      return [];
    }

    const subshapes = [];
    const stops = gtfsData.stops;
    
    // If we have recorded stop_times data available, use it
    if (recordedStopTimes && recordedStopTimes[tripId]) {
      const stopTimesForTrip = recordedStopTimes[tripId];
      console.time(`[RTUtil]     Haversine calcs for ${shapeId} (${stopTimesForTrip.length - 1} stop pairs)`);
      
      for (let i = 0; i < stopTimesForTrip.length - 1; i++) {
        const currentStopId = stopTimesForTrip[i].stop_id;
        const nextStopId = stopTimesForTrip[i + 1].stop_id;
        
        const originStop = stops[currentStopId];
        const destStop = stops[nextStopId];

        if (!originStop || !destStop) continue;

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
            const originStopInTrip = stopDeltas.find(s => s.stopId === currentStopId);
            const destStopInTrip = stopDeltas.find(s => s.stopId === nextStopId);
            
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
            console.log(`[RTUtil] Segment ${currentStopId}->${nextStopId} (shape ${shapeId}): distance=${distance.toFixed(3)} km, avg_travel_time=${avgTravelTimeSeconds.toFixed(1)} sec (${(avgTravelTimeSeconds/60).toFixed(2)} min), speed=${speedKmh.toFixed(1)} km/h`);
          } else if (distance > 0) {
            console.log(`[RTUtil] Segment ${currentStopId}->${nextStopId} (shape ${shapeId}): distance=${distance.toFixed(3)} km, NO TRAVEL TIME DATA (${travelTimes.length} samples)`);
          }
        }

        // Map speed to color (5-bin)
        const color = getSpeedColor(speedKmh);

        subshapes.push({
          fromStopId: currentStopId,
          toStopId: nextStopId,
          origin_station: originStop.stop_name,
          destination_station: destStop.stop_name,
          distance: Number(distance.toFixed(3)),
          coordinates: subshapeCoords,
          speedKmh: Number(speedKmh.toFixed(1)),
          color: color
        });
      }
    } else {
    }

    return subshapes;
  }

  /**
   * Generate and visualize top 10 busiest routes with subshapes on map
   * This function is called from RTRecordingViewer to populate the map
   * 
   * @param {Array} tripSummaries - Array of trip summary objects from RTRecordingViewer
   * @param {Object} routeStats - Route statistics object with tripHours data
   * @param {Object} gtfsData - GTFS data object (trips, shapes, stops, routes, shapeRouteMap)
   * @param {Object} recordedStopTimes - Recorded stop times data keyed by tripId
   * @param {Object} shapeIdToTripIdMap - Pre-selected tripId for each shapeId (built by viewer)
   * @param {Object} leafletMap - Leaflet map instance
   * @param {Object} stopDeltasByTrip - Full stop data with actual times for speed calculation
   * @returns {Promise<Object>} Object with { topRoutes, subshapesData, metadata }
   */
  async function visualizeTop10BusiestRoutes(tripSummaries, routeStats, gtfsData, recordedStopTimes, shapeIdToTripIdMap, leafletMap, stopDeltasByTrip, topN = 10, segmentsCache = {}) {
    if (!leafletMap) {
      console.error('[RTUtil] Map not available');
      return { topRoutes: [], subshapesData: {}, metadata: { error: 'Map not available' } };
    }

    if (!gtfsData || !gtfsData.trips || !gtfsData.shapes) {
      console.error('[RTUtil] GTFS data not loaded');
      return { topRoutes: [], subshapesData: {}, metadata: { error: 'GTFS data not loaded' } };
    }

    try {
      console.time('[RTUtil] TOTAL VISUALIZATION TIME');
      console.log(`[RTUtil] Starting visualization of top ${topN} busiest routes`);

      // Step 1: Clear all existing objects on map
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
        return { topRoutes: [], subshapesData: {}, metadata: { error: 'Leaflet not available' } };
      }
      
window.subshapesLayer = L.layerGroup();
      console.log('[RTUtil] Created new subshapes layer');

      // Step 2: Calculate top 10 busiest routes by trip-hours
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

      console.log(`[RTUtil] Top ${topN} busiest routes:`, topRoutes.map(r => ({ routeId: r.routeId, tripHours: r.tripHours.toFixed(2) })));

      // Step 3: Build segments (deduplicated station-to-station corridors)
      const segmentsMap = {}; // Key: fromStopId_toStopId -> Segment
      const subshapesData = {};
      const shapeRouteMap = gtfsData.shapeRouteMap || {};
      const trips = gtfsData.trips;

      for (const routeData of topRoutes) {
        const routeId = routeData.routeId;
        const isFirstRoute = routeData === topRoutes[0];
        if (isFirstRoute) console.time(`[RTUtil] ROUTE ${routeId} (FIRST ROUTE TIMING)`);
        
        subshapesData[routeId] = {
          routeId,
          tripHours: routeData.tripHours,
          tripCount: routeData.tripCount,
          shapes: {}
        };

        // Find all trips belonging to this route
        const tripsForRoute = Object.entries(trips)
          .filter(([, trip]) => trip.route_id === routeId)
          .map(([tripId, trip]) => ({ tripId, ...trip }));

        // Extract unique shape_ids
        const uniqueShapeIds = [...new Set(tripsForRoute.map(t => t.shape_id).filter(Boolean))];

        console.log(`[RTUtil] Route ${routeId}: ${tripsForRoute.length} trips, ${uniqueShapeIds.length} unique shapes`);

        // Step 4: Generate subshapes for each unique shape and deduplicate into segments
        for (const shapeId of uniqueShapeIds) {
          if (isFirstRoute) console.time(`[RTUtil]   Shape ${shapeId}`);
          try {
            // Get pre-selected tripId from viewer (avoids rescanning)
            const tripId = shapeIdToTripIdMap[shapeId];
            
            // Filter trips for this specific shape
            const tripsForThisShape = tripsForRoute.filter(t => t.shape_id === shapeId);
            
            const subshapes = await generateSubshapesForShapeId(
              shapeId, 
              gtfsData, 
              tripId, 
              recordedStopTimes, 
              tripsForThisShape,
              stopDeltasByTrip
            );
            if (isFirstRoute) console.timeEnd(`[RTUtil]   Shape ${shapeId}`);
            subshapesData[routeId].shapes[shapeId] = subshapes;

            // Step 5: Deduplicate subshapes into segments
            for (const subshape of subshapes) {
              const segmentKey = `${subshape.fromStopId}_${subshape.toStopId}`;
              let segment = null;
              
              // First check if segment already exists in cache (from previous refresh/initialization)
              if (segmentsCache && segmentsCache[segmentKey]) {
                segment = segmentsCache[segmentKey];
                console.log(`[RTUtil] Reusing cached segment ${segmentKey} for route ${routeId}, shape ${shapeId}`);
                // Update the segment's parent shapes and routes
                segment.addRoute(routeId);
                segment.addShape(shapeId);
              } else if (segmentsMap[segmentKey]) {
                // Segment exists in current 'segmentsMap, check distance tolerance
                segment = segmentsMap[segmentKey];
                const distanceDiff = Math.abs(segment.distance - subshape.distance) / segment.distance;
                
                if (distanceDiff > 0.05) {
                  // Distance difference >5%, log warning
                  console.warn(
                    `[RTUtil] Distance mismatch for segment ${subshape.fromStationId}->${subshape.toStationId}: ` +
                    `existing=${segment.distance.toFixed(3)}km vs new=${subshape.distance.toFixed(3)}km (diff=${(distanceDiff*100).toFixed(1)}%)`
                  );
                }
                
                // Add route and shape to existing segment
                segment.addRoute(routeId);
                segment.addShape(shapeId);
              } else {
                // New segment, create it
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
                segmentsMap[segmentKey] = segment;
                
                // Also add to cache for persistence across refreshes
                if (segmentsCache) {
                  segmentsCache[segmentKey] = segment;
                }
              }
            }
          } catch (err) {
            if (isFirstRoute) console.timeEnd(`[RTUtil]   Shape ${shapeId}`);
            console.error(`[RTUtil] Error processing shape ${shapeId} for route ${routeId}:`, err);
          }
        }
        
        if (isFirstRoute) console.timeEnd(`[RTUtil] ROUTE ${routeId} (FIRST ROUTE TIMING)`);
      }

      // Step 6: Aggregate travel times for each segment from all trips
      console.log(`[RTUtil] Processing ${Object.keys(segmentsMap).length} unique segments...`);
      
      for (const tripId in stopDeltasByTrip) {
        const stopDeltas = stopDeltasByTrip[tripId];
        const routeId = stopDeltas[0]?.routeId;
        
        // For each consecutive pair of stops in this trip
        for (let i = 0; i < stopDeltas.length - 1; i++) {
          const originStop = stopDeltas[i];
          const destStop = stopDeltas[i + 1];
          
          if (!originStop.actualEpoch || !destStop.actualEpoch) continue;
          
          const segmentKey = `${originStop.stopId}_${destStop.stopId}`;
          const segment = segmentsMap[segmentKey];
          
          if (segment) {
            const travelTimeSeconds = destStop.actualEpoch - originStop.actualEpoch;
            if (travelTimeSeconds > 0) {
              segment.addTravelTime(tripId, routeId, travelTimeSeconds);
            }
          }
        }
      }

      // Step 7: Plot all segments on map
      console.log(`[RTUtil] Plotting ${Object.keys(segmentsMap).length} unique segments...`);
      
      for (const segmentKey in segmentsMap) {
        const segment = segmentsMap[segmentKey];
        const polylineCoords = segment.coordinates.map(p => [p.lat, p.lon]);
        
        // Calculate average speed and color
        const avgSpeedKmh = segment.getAverageSpeedKmh();
        const color = getSpeedColor(avgSpeedKmh);
        
        // Get route names (convert from routeIds)
        const routeNames = Array.from(segment.routes).sort().join(', ');
        
        const polyline = L.polyline(polylineCoords, {
          color: color,
          weight: 3,
          opacity: 0.7,
          interactive: true
        }).bindPopup(
          `<b>${segment.fromStopName}</b> → <b>${segment.toStopName}</b><br>` +
          `Distance: ${segment.distance.toFixed(3)} km<br>` +
          `Speed: ${avgSpeedKmh.toFixed(1)} km/h (${segment.travelTimeSamples.length} samples)<br>` +
          `Routes: ${routeNames}`
        );

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
        console.log('[RTUtil] Total polylines in layer:', Object.keys(segmentsMap).length);
        
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
      console.log(`[RTUtil] Visualization complete. Total routes: ${topRoutes.length}, Total shape groups: ${Object.keys(subshapesData).length}, Total segments: ${Object.keys(segmentsMap).length}`);

      return {
        topRoutes,
        subshapesData,
        metadata: {
          timestamp: new Date().toISOString(),
          totalSubshapesPlotted: Object.values(subshapesData).reduce((sum, route) => 
            sum + Object.values(route.shapes).reduce((ssum, shapeList) => ssum + shapeList.length, 0), 0
          )
        }
      };

    } catch (err) {
      console.error('[RTUtil] Error in visualizeTop10BusiestRoutes:', err);
      return { topRoutes: [], subshapesData: {}, metadata: { error: err.message } };
    }
  }

  /**
   * Get color based on speed (5-bin color coding)
   * @param {number} speedKmh - Speed in km/h
   * @returns {string} Hex color code
   */
  function getSpeedColor(speedKmh) {
    // 5-bin color mapping based on average speed
    if (speedKmh < 5) return '#d32f2f';      // Red: Stopped / very slow
    if (speedKmh < 15) return '#f57c00';     // Orange: Slow
    if (speedKmh < 30) return '#fbc02d';     // Yellow: Normal
    if (speedKmh < 50) return '#7cb342';     // Light green: Good
    return '#388e3c';                        // Dark green: Very good
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

  // Expose functions to global scope for use in RTRecordingViewer
  if (typeof window !== 'undefined') {
    window.RTUtil = {
      haversineDistance,
      findClosestShapePointIndex,
      getDistanceBetweenShapePoints,
      generateSubshapesForShapeId,
      visualizeTop10BusiestRoutes,
      getRouteColor,
      clearSubshapes
    };
  }

})();
