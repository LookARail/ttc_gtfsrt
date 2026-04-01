/**
 * Debug Utilities
 * Access from browser console via: window.DebugTTC.testTripDelayCalculations()
 */

window.DebugTTC = window.DebugTTC || {};

/**
 * Diagnose trip delay calculations for currently selected routes
 * 
 * Analyzes recorded RT data (not GTFS static data) to show stop-level delays.
 * Filters by selected routes and picks 10 random trips to inspect.
 * 
 * Usage in browser console:
 *   window.DebugTTC.testTripDelayCalculations()
 */
window.DebugTTC.testTripDelayCalculations = function() {
  try {
    console.group('%c[DEBUG] Trip Delay Calculation Test', 'color: #1976d2; font-weight: bold');
    
    // Get debug variables exposed by main.js
    if (!window._TTC_DEBUG) {
      console.error('ERROR: Debug variables not exposed. Has main.js loaded?');
      console.groupEnd();
      return;
    }
    
    const { gtfsData, activeFilter, recordedData, isValidArrivalTime } = window._TTC_DEBUG;
    
    // Check if we have recorded data
    if (!recordedData || typeof recordedData !== 'object') {
      console.error('ERROR: recordedData not available');
      console.groupEnd();
      return;
    }
    
    const recordedTripIds = Object.keys(recordedData);
    console.log(`📊 Total recorded trips: ${recordedTripIds.length}`);
    
    if (activeFilter && activeFilter.routeIds) {
      console.log(`📊 Active Route Filter: ${activeFilter.routeIds.size} routes selected (${Array.from(activeFilter.routeIds).join(', ')})`);
    } else {
      console.log('📊 Active Route Filter: None (all routes)');
    }
    
    // Step 1: Filter recorded trips by active route selection
    const filteredTripIds = [];
    
    try {
      for (let i = 0; i < recordedTripIds.length; i++) {
        const tripId = recordedTripIds[i];
        const trip = recordedData[tripId];
        
        if (trip && typeof trip === 'object' && trip.rid) {
          const routeId = String(trip.rid);
          
          // Apply filter: if no filter (null), include all; otherwise check against routeIds Set
          if (!activeFilter.routeIds || activeFilter.routeIds.has(routeId)) {
            filteredTripIds.push(tripId);
          }
        }
      }
    } catch (err) {
      console.error('ERROR filtering recorded trips:', err.message);
      console.groupEnd();
      return;
    }
    
    console.log(`✓ Found ${filteredTripIds.length} recorded trips matching filter\n`);
    
    if (filteredTripIds.length === 0) {
      console.warn('⚠️  No recorded trips found for selected routes. Try a different route.');
      console.groupEnd();
      return;
    }
    
    // Step 2: Pick up to 10 random trips
    const sampleSize = Math.min(10, filteredTripIds.length);
    const randomTrips = [];
    const usedIndices = new Set();
    
    while (randomTrips.length < sampleSize) {
      const idx = Math.floor(Math.random() * filteredTripIds.length);
      if (!usedIndices.has(idx)) {
        usedIndices.add(idx);
        randomTrips.push(filteredTripIds[idx]);
      }
    }
    
    console.log(`✓ Randomly selected ${randomTrips.length} trips to analyze\n`);
    
    // Step 3: Analyze each trip's stops
    const tripDelayData = [];
    const routes = gtfsData.routes || {};
    
    for (let i = 0; i < randomTrips.length; i++) {
      const tripId = randomTrips[i];
      const trip = recordedData[tripId];
      
      if (!trip || !trip.stops) continue;
      
      const routeId = String(trip.rid);
      const vehicleId = trip.vid || 'N/A';
      const route = routes[routeId];
      const routeName = route 
        ? `${route.route_short_name || ''}${route.route_long_name ? ' - ' + route.route_long_name : ''}`
        : `Route ${routeId}`;
      
      console.group(`Recorded Trip ${i + 1}/${randomTrips.length}: ${tripId}`);
      console.log(`Route: ${routeName} (${routeId})`);
      console.log(`Vehicle: ${vehicleId}`);
      
      // Build stop details
      const stopSeqKeys = Object.keys(trip.stops);
      const stopDetails = [];
      
      for (let s = 0; s < stopSeqKeys.length; s++) {
        const stopSeq = stopSeqKeys[s];
        const stop = trip.stops[stopSeq];
        
        if (stop && typeof stop === 'object') {
          const delaySeconds = (isValidArrivalTime(stop.arr) && stop.sch_arr)
            ? (stop.arr - stop.sch_arr)
            : null;
          
          stopDetails.push({
            stopSeq: Number(stopSeq),
            stopId: stop.sid || 'N/A',
            arr_recorded: isValidArrivalTime(stop.arr) ? stop.arr : 'MISSING/SKIP',
            sch_arr: stop.sch_arr || 'N/A',
            sch_dep: stop.sch_dep || 'N/A',
            delaySeconds: delaySeconds,
            delayFormatted: delaySeconds !== null ? formatDelayMinutes(delaySeconds) : 'N/A'
          });
        }
      }
      
      if (stopDetails.length > 0) {
        console.log(`Stops recorded: ${stopDetails.length}`);
        console.table(stopDetails);
        
        // Calculate trip-level delays (from stops that have valid data)
        const validDelays = stopDetails
          .filter(s => s.delaySeconds !== null)
          .map(s => s.delaySeconds);
        
        if (validDelays.length > 0) {
          const maxDelay = Math.max(...validDelays);
          const minDelay = Math.min(...validDelays);
          const avgDelay = validDelays.reduce((a, b) => a + b, 0) / validDelays.length;
          
          console.log('\n📈 Trip Delay Metrics:');
          console.log(`  Max Delay: ${formatDelayMinutes(maxDelay)} (${maxDelay}s)`);
          console.log(`  Min Delay: ${formatDelayMinutes(minDelay)} (${minDelay}s)`);
          console.log(`  Avg Delay: ${formatDelayMinutes(avgDelay)} (${avgDelay.toFixed(1)}s)`);
          console.log(`  Valid stops: ${validDelays.length}/${stopDetails.length}`);
          
          tripDelayData.push({
            tripId,
            routeName,
            vehicleId,
            stopCount: stopDetails.length,
            validStops: validDelays.length,
            maxDelay,
            minDelay,
            avgDelay
          });
        } else {
          console.log('⚠️  No valid delay data (missing scheduled or arrival times)');
        }
      } else {
        console.log('⚠️  No stops recorded for this trip');
      }
      
      console.groupEnd();
    }
    
    // Summary
    if (tripDelayData.length > 0) {
      console.log('\n📊 SUMMARY - All Sampled Trips:');
      console.table(tripDelayData);
      
      const allMaxDelays = tripDelayData.map(t => t.maxDelay);
      const overallMaxOfMaxes = Math.max(...allMaxDelays);
      const overallMinOfMaxes = Math.min(...allMaxDelays);
      const overallAvgOfMaxes = allMaxDelays.reduce((a, b) => a + b, 0) / allMaxDelays.length;
      
      console.log('\n🎯 Overall Analysis (Trip Max Delays):');
      console.log(`  Highest max delay: ${formatDelayMinutes(overallMaxOfMaxes)} (${overallMaxOfMaxes}s)`);
      console.log(`  Lowest max delay: ${formatDelayMinutes(overallMinOfMaxes)} (${overallMinOfMaxes}s)`);
      console.log(`  Average max delay: ${formatDelayMinutes(overallAvgOfMaxes)} (${overallAvgOfMaxes.toFixed(1)}s)`);
    }
    
    console.log('\n✅ Diagnostic complete');
    console.groupEnd();
    
  } catch (err) {
    console.error('[DEBUG ERROR]', err);
    console.groupEnd();
  }
};

/**
 * Helper function to format seconds as minutes:seconds
 */
function formatDelayMinutes(seconds) {
  if (typeof seconds !== 'number' || !isFinite(seconds)) return 'N/A';
  const sign = seconds >= 0 ? '+' : '-';
  const absSeconds = Math.abs(seconds);
  const mins = Math.floor(absSeconds / 60);
  const secs = Math.floor(absSeconds % 60);
  return `${sign}${mins}m ${secs}s`;
}

// Make the function easy to call
console.log('%c✓ Debug utilities loaded. Call: window.DebugTTC.testTripDelayCalculations()', 'color: green; font-weight: bold');
