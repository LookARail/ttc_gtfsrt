// RT Recording Viewer
// Opens in a new popup window to analyze recorded trip data

(function() {
  'use strict';

  // GitHub configuration - Update with your repository details
  const GITHUB_REPO = "LookArail/ttc_gtfsrt";
  const GITHUB_BRANCH = "main";
  const GITHUB_RAW_BASE = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}`;
  
  const TORONTO_TZ = 'America/Toronto';
  let viewerWindow = null;
  let currentData = null;
  let stopsData = null;
  let selectedRouteIds = new Set();
  let processedData = {
    tripSummaries: [],
    stopDeltas: [],
    routeAggregations: [],
    stopAggregations: []
  };

  // ============================================================================
  // TIMEZONE & FORMATTING UTILITIES
  // ============================================================================

  function scheduledTimeToEpoch(scheduledTimeStr, referenceEpochSeconds) {
    if (!scheduledTimeStr || !referenceEpochSeconds) return null;
    
    const parts = scheduledTimeStr.split(':');
    if (parts.length !== 3) return null;
    
    let hours = parseInt(parts[0]);
    const minutes = parseInt(parts[1]);
    const seconds = parseInt(parts[2]);
    
    if (isNaN(hours) || isNaN(minutes) || isNaN(seconds)) return null;
    
    const referenceDate = new Date(referenceEpochSeconds * 1000);
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
    
    const formatParts = formatter.formatToParts(referenceDate);
    const year = parseInt(formatParts.find(p => p.type === 'year').value);
    const month = parseInt(formatParts.find(p => p.type === 'month').value) - 1;
    const day = parseInt(formatParts.find(p => p.type === 'day').value);
    
    let daysToAdd = 0;
    while (hours >= 24) {
      hours -= 24;
      daysToAdd++;
    }
    
    const testDate = new Date(Date.UTC(year, month, day, 12, 0, 0));
    const testParts = formatter.formatToParts(testDate);
    const torontoHour = parseInt(testParts.find(p => p.type === 'hour').value);
    let offsetHours = torontoHour - 12;
    if (offsetHours > 12) offsetHours -= 24;
    if (offsetHours < -12) offsetHours += 24;
    
    const scheduledUTC = Date.UTC(year, month, day + daysToAdd, hours - offsetHours, minutes, seconds);
    
    return Math.floor(scheduledUTC / 1000);
  }

  function formatDuration(seconds) {
    if (seconds === null || seconds === undefined) return 'N/A';
    
    const absSeconds = Math.abs(seconds);
    const hrs = Math.floor(absSeconds / 3600);
    const mins = Math.floor((absSeconds % 3600) / 60);
    const secs = Math.floor(absSeconds % 60);
    
    const sign = seconds >= 0 ? '+' : '-';
    return `${sign}${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  // ============================================================================
  // DATA LOADING
  // ============================================================================

  async function loadStopsData() {
    if (stopsData) return stopsData;
    
    try {
      const response = await fetch(`${GITHUB_RAW_BASE}/data/stops.json`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      stopsData = await response.json();
      return stopsData;
    } catch (err) {
      console.error('Failed to load stops data:', err);
      return {};
    }
  }

  async function scanAvailableRecordings() {
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
    const stopDeltas = [];
    let debugSampleShown = false;
    
    // Process each trip
    for (const tripId in recordedData) {
      const trip = recordedData[tripId];
      let maxDelay = null;
      
      // Process each stop in the trip
      for (const stopSeq in trip.stops) {
        const stop = trip.stops[stopSeq];
        
        // Skip if no actual arrival time
        if (!stop.arr) continue;
        
        // Get scheduled time (prefer arrival, fallback to departure)
        const scheduledTimeStr = stop.sch_arr || stop.sch_dep;
        if (!scheduledTimeStr) {
          stopDeltas.push({
            tripId,
            routeId: trip.rid,
            stopId: stop.sid,
            stopSeq: stop.seq,
            delta: null // No scheduled data
          });
          continue;
        }
        
        // Debug first few conversions
        if (!debugSampleShown) {
          console.log('[Viewer] Sample scheduled time conversion:', {
            tripId,
            routeId: trip.rid,
            stopSeq,
            scheduledTimeStr,
            actualArrival: stop.arr,
            actualArrivalDate: new Date(stop.arr * 1000).toISOString()
          });
          debugSampleShown = true;
        }
        
        // Convert scheduled time to epoch
        const scheduledEpoch = scheduledTimeToEpoch(scheduledTimeStr, stop.arr);
        if (scheduledEpoch === null) {
          stopDeltas.push({
            tripId,
            routeId: trip.rid,
            stopId: stop.sid,
            stopSeq: stop.seq,
            delta: null
          });
          continue;
        }
        
        // Calculate delta (positive = late, negative = early)
        const delta = stop.arr - scheduledEpoch;
        
        stopDeltas.push({
          tripId,
          routeId: trip.rid,
          stopId: stop.sid,
          stopSeq: stop.seq,
          delta
        });
        
        // Track max delay for this trip
        if (maxDelay === null || delta > maxDelay) {
          maxDelay = delta;
        }
      }
      
      // Record trip summary
      tripSummaries.push({
        tripId,
        routeId: trip.rid,
        vehicleId: trip.vid,
        maxDelay: maxDelay !== null ? maxDelay : null,
        stopCount: Object.keys(trip.stops).length
      });
    }
    
    console.log('[Viewer] Processing complete:', {
      tripSummaries: tripSummaries.length,
      stopDeltas: stopDeltas.length,
      deltasWithValues: stopDeltas.filter(d => d.delta !== null).length,
      tripsWithMaxDelay: tripSummaries.filter(t => t.maxDelay !== null).length,
      sampleTripsWithDelay: tripSummaries.filter(t => t.maxDelay !== null).slice(0, 3).map(t => ({ 
        routeId: t.routeId, 
        maxDelay: t.maxDelay 
      })),
      sampleTripsWithoutDelay: tripSummaries.filter(t => t.maxDelay === null).slice(0, 3).map(t => ({ 
        routeId: t.routeId, 
        stopCount: t.stopCount 
      }))
    });
    
    return { tripSummaries, stopDeltas };
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
      if (stop.delta === null) continue;
      
      if (!stopMap[stop.stopId]) {
        stopMap[stop.stopId] = {
          stopId: stop.stopId,
          stopName: stopsData[stop.stopId]?.stop_name || stop.stopId,
          deltas: []
        };
      }
      
      stopMap[stop.stopId].deltas.push(stop.delta);
    }
    
    // Calculate averages
    const aggregations = [];
    for (const stopId in stopMap) {
      const stop = stopMap[stopId];
      const avgDelay = stop.deltas.reduce((sum, d) => sum + d, 0) / stop.deltas.length;
      
      aggregations.push({
        stopId,
        stopName: stop.stopName,
        avgDelay,
        recordCount: stop.deltas.length
      });
    }
    
    // Sort by avgDelay descending, take top 20
    aggregations.sort((a, b) => b.avgDelay - a.avgDelay);
    const topStops = aggregations.slice(0, 20);
    
    console.log('[Viewer] Stop aggregation result:', {
      totalStops: aggregations.length,
      top20Count: topStops.length
    });
    
    return topStops;
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
    
    // Wait for window to fully load, then initialize
    const checkLoad = setInterval(() => {
      if (viewerWindow.document.readyState === 'complete') {
        clearInterval(checkLoad);
        // Inject our functions and data accessors into the child window
        viewerWindow.RTViewerFunctions = {
          loadFromMemory,
          loadFromGitHub,
          loadFromFile,
          scanAvailableRecordings,
          processData,
          aggregateByRoute,
          aggregateByStop,
          loadStopsData,
          scheduledTimeToEpoch,
          formatDuration
        };
        viewerWindow.parentRecordedData = typeof recordedData !== 'undefined' ? recordedData : null;
        viewerWindow.parentScheduledTimesCache = typeof scheduledTimesCache !== 'undefined' ? scheduledTimesCache : null;
        initializeViewer(viewerWindow);
      }
    }, 100);
  }

  function initializeViewer(win) {
    const doc = win.document;
    
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
        
        // Load stops data and process
        await loadStopsData();
        const processed = processData(data);
        processedData.tripSummaries = processed.tripSummaries;
        processedData.stopDeltas = processed.stopDeltas;
        
        // Initialize route filter
        initializeRouteFilter(doc, processed.tripSummaries);
        
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
    });
    
    deselectAllBtn.addEventListener('click', () => {
      const checkboxes = doc.querySelectorAll('.route-filter input[type="checkbox"]');
      checkboxes.forEach(cb => cb.checked = false);
    });
    
    applyFilterBtn.addEventListener('click', () => {
      const checkboxes = doc.querySelectorAll('.route-filter input[type="checkbox"]:checked');
      selectedRouteIds.clear();
      checkboxes.forEach(cb => selectedRouteIds.add(cb.value));
      
      console.log('[Viewer] Apply filter clicked:', {
        selectedCount: selectedRouteIds.size,
        selectedRoutes: Array.from(selectedRouteIds)
      });
      
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
          const scheduledTimeStr = stop.sch_arr || stop.sch_dep;
          const scheduledEpoch = scheduledTimeStr ? scheduledTimeToEpoch(scheduledTimeStr, stop.arr) : null;
          const delta = (stop.arr && scheduledEpoch) ? stop.arr - scheduledEpoch : null;
          
          stopDetails.push({
            seq: stop.seq,
            stopId: stop.sid,
            scheduledStr: scheduledTimeStr || 'MISSING',
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
      
      label.appendChild(checkbox);
      label.appendChild(doc.createTextNode(` ${routeId}`));
      routeFilterContainer.appendChild(label);
    });
  }

  function renderCharts(doc) {
    console.log('[Viewer] Rendering charts with:', {
      tripSummaries: processedData.tripSummaries.length,
      stopDeltas: processedData.stopDeltas.length,
      selectedRoutes: Array.from(selectedRouteIds)
    });
    
    const routeAgg = aggregateByRoute(processedData.tripSummaries, selectedRouteIds);
    const stopAgg = aggregateByStop(processedData.stopDeltas, selectedRouteIds, stopsData);
    
    console.log('[Viewer] Aggregation complete:', {
      routeAggCount: routeAgg.length,
      stopAggCount: stopAgg.length
    });
    
    if (routeAgg.length === 0 && stopAgg.length === 0) {
      doc.getElementById('otpTab').innerHTML = '<div class="no-data">No data available. Try adjusting filters or selecting a different date.</div>';
      return;
    }
    
    // Render route chart
    renderRouteChart(doc, routeAgg);
    
    // Render stop chart
    renderStopChart(doc, stopAgg);
  }

  function renderRouteChart(doc, data) {
    console.log('[Viewer] Rendering route chart with', data.length, 'routes');
    
    const canvas = doc.getElementById('routeChart');
    if (!canvas) {
      console.error('[Viewer] Route chart canvas not found!');
      return;
    }
    
    const ctx = canvas.getContext('2d');
    
    // Check if Chart.js is available
    if (typeof Chart === 'undefined') {
      console.error('[Viewer] Chart.js is not loaded!');
      return;
    }
    
    // Destroy existing chart
    if (canvas.chart) {
      canvas.chart.destroy();
    }
    
    if (data.length === 0) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
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
    
    canvas.chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: data.map(d => d.routeId),
        datasets: [{
          label: 'Average Delay',
          data: data.map(d => d.avgDelay),
          backgroundColor: colors,
          borderColor: colors,
          borderWidth: 1
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (context) => {
                const route = data[context.dataIndex];
                return [
                  `Avg Delay: ${formatDuration(route.avgDelay)}`,
                  `Trips: ${route.tripCount}`
                ];
              }
            }
          }
        },
        scales: {
          x: {
            title: { display: true, text: 'Average Delay (seconds)' },
            ticks: {
              callback: (value) => formatDuration(value)
            }
          },
          y: {
            title: { display: true, text: 'Route' }
          }
        }
      }
    });
  }

  function renderStopChart(doc, data) {
    const canvas = doc.getElementById('stopChart');
    const ctx = canvas.getContext('2d');
    
    // Destroy existing chart
    if (canvas.chart) {
      canvas.chart.destroy();
    }
    
    if (data.length === 0) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
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
    
    canvas.chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: data.map(d => `${d.stopId} - ${d.stopName}`),
        datasets: [{
          label: 'Average Delay',
          data: data.map(d => d.avgDelay),
          backgroundColor: colors,
          borderColor: colors,
          borderWidth: 1
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (context) => {
                const stop = data[context.dataIndex];
                return [
                  `Avg Delay: ${formatDuration(stop.avgDelay)}`,
                  `Records: ${stop.recordCount}`,
                  `Stop: ${stop.stopName}`
                ];
              }
            }
          }
        },
        scales: {
          x: {
            title: { display: true, text: 'Average Delay (seconds)' },
            ticks: {
              callback: (value) => formatDuration(value)
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
  }

  // ============================================================================
  // EXPORTS
  // ============================================================================

  window.RTRecordingViewer = {
    open: openViewer
  };

})();
