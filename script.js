const fileInput = document.getElementById('gtfsFile');
const processBtn = document.getElementById('processBtn');
const checkCalendarBtn = document.getElementById('checkCalendarBtn');
const statusEl = document.getElementById('status');
const outputEl = document.getElementById('output');

function log(msg) {
	statusEl.textContent = msg;
	outputEl.textContent += msg + '\n';
}

function safeParseCSV(text) {
	return Papa.parse(text, { header: true, skipEmptyLines: true, dynamicTyping: false }).data;
}

// Client-side calendar date helpers (for logging only, non-blocking)
function getTodayTorontoDateStr() {
	const now = new Date();
	const formatter = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'America/Toronto' });
	const parts = formatter.formatToParts(now);
	const dateObj = {};
	parts.forEach(({ type, value }) => { dateObj[type] = parseInt(value); });
	return String(dateObj.year) + String(dateObj.month).padStart(2, '0') + String(dateObj.day).padStart(2, '0');
}

function getEarliestCalendarStartDate(calendarRows) {
	let earliest = null;
	(calendarRows || []).forEach(row => {
		if (row.start_date && (!earliest || row.start_date < earliest)) earliest = row.start_date;
	});
	return earliest;
}

function checkCalendarDateLocal(earliestStart) {
	const torontoDate = getTodayTorontoDateStr();
	if (!earliestStart) return { proceed: true, torontoDate, earliestStart: null, reason: 'No calendar.txt or no start_dates found' };
	const proceed = torontoDate >= earliestStart;
	const reason = proceed 
		? `Current Toronto date (${torontoDate}) >= Earliest start_date (${earliestStart}); would proceed` 
		: `Current Toronto date (${torontoDate}) < Earliest start_date (${earliestStart}); would abort`;
	return { proceed, torontoDate, earliestStart, reason };
}

function processRoutes(rows) {
	const routes = {};
	(rows||[]).forEach(r => {
		if (!r.route_id) return;
		routes[r.route_id] = {
			route_id: r.route_id,
			route_short_name: r.route_short_name || '',
			route_long_name: r.route_long_name || '',
			route_type: parseInt(r.route_type) || 0,
			route_color: r.route_color || ''
		};
	});
	return routes;
}

function processTrips(rows) {
	const trips = {};
	const shapeRouteMap = {};
	(rows||[]).forEach(t => {
		if (!t.trip_id) return;
		trips[t.trip_id] = {
			trip_id: t.trip_id,
			route_id: t.route_id,
			service_id: t.service_id,
			trip_headsign: t.trip_headsign || '',
			direction_id: parseInt(t.direction_id) || 0,
			block_id: t.block_id || '',
			shape_id: t.shape_id || ''
		};
		if (t.shape_id && !shapeRouteMap[t.shape_id]) shapeRouteMap[t.shape_id] = t.route_id;
	});
	return { trips, shapeRouteMap };
}

function processStops(rows) {
	const stops = {};
	(rows||[]).forEach(s => {
		if (!s.stop_id) return;
		stops[s.stop_id] = {
			stop_id: s.stop_id,
			stop_name: s.stop_name || '',
			stop_lat: parseFloat(s.stop_lat) || 0,
			stop_lon: parseFloat(s.stop_lon) || 0
		};
	});
	return stops;
}

function processShapes(rows) {
	const shapes = {};
	(rows||[]).forEach(s => {
		if (!s.shape_id) return;
		if (!shapes[s.shape_id]) shapes[s.shape_id] = [];
		shapes[s.shape_id].push({ lat: parseFloat(s.shape_pt_lat)||0, lon: parseFloat(s.shape_pt_lon)||0, sequence: parseInt(s.shape_pt_sequence)||0 });
	});
	Object.keys(shapes).forEach(id => shapes[id].sort((a,b)=>a.sequence-b.sequence));
	return shapes;
}

function processStopTimes(rows, trips) {
	const tripIndex = {};
	(rows||[]).forEach(st => {
		const tripId = st.trip_id; if (!tripId) return;
		if (!tripIndex[tripId]) tripIndex[tripId] = [];
		const stopTime = { sid: st.stop_id||'', seq: parseInt(st.stop_sequence)||0, arr: st.arrival_time||'', dep: st.departure_time||'' };
		if (st.stop_headsign) stopTime.hs = st.stop_headsign;
		if (st.pickup_type && st.pickup_type !== '0') stopTime.pu = parseInt(st.pickup_type);
		if (st.drop_off_type && st.drop_off_type !== '0') stopTime.do = parseInt(st.drop_off_type);
		tripIndex[tripId].push(stopTime);
	});
	Object.keys(tripIndex).forEach(tid => tripIndex[tid].sort((a,b)=>a.seq-b.seq));

	// group by route
	const routeIndex = {};
	Object.keys(tripIndex).forEach(tripId => {
		const trip = trips[tripId]; if (!trip || !trip.route_id) return;
		const routeId = trip.route_id;
		if (!routeIndex[routeId]) routeIndex[routeId] = {};
		routeIndex[routeId][tripId] = tripIndex[tripId];
	});
	return routeIndex;
}

async function processZip(file) {
	log('Reading ZIP...');
	const arrayBuffer = await file.arrayBuffer();
	const zip = await JSZip.loadAsync(arrayBuffer);

	// Helper to read a file inside zip
	async function readIfExists(name) {
		const f = zip.file(name) || zip.file(name.toLowerCase());
		if (!f) return null;
		return await f.async('string');
	}

	const routesTxt = await readIfExists('routes.txt');
	const tripsTxt = await readIfExists('trips.txt');
	const stopsTxt = await readIfExists('stops.txt');
	const shapesTxt = await readIfExists('shapes.txt');
	const stopTimesTxt = await readIfExists('stop_times.txt');
	const calendarTxt = await readIfExists('calendar.txt');

	log('Parsing CSVs...');
	const routesRows = routesTxt ? safeParseCSV(routesTxt) : [];
	const tripsRows = tripsTxt ? safeParseCSV(tripsTxt) : [];
	const stopsRows = stopsTxt ? safeParseCSV(stopsTxt) : [];
	const shapesRows = shapesTxt ? safeParseCSV(shapesTxt) : [];
	const stopTimesRows = stopTimesTxt ? safeParseCSV(stopTimesTxt) : [];
	const calendarRows = calendarTxt ? safeParseCSV(calendarTxt) : [];

	log('Checking calendar dates...');
	const earliestStart = getEarliestCalendarStartDate(calendarRows);
	const dateCheck = checkCalendarDateLocal(earliestStart);
	log(`[Calendar Check] ${dateCheck.reason}`);
	console.log('[Calendar Check]', dateCheck);

	log('Processing data...');
	const routes = processRoutes(routesRows);
	const { trips, shapeRouteMap } = processTrips(tripsRows);
	const stops = processStops(stopsRows);
	const shapes = processShapes(shapesRows);
	const stopTimesByRoute = processStopTimes(stopTimesRows, trips);

	log('Packaging output ZIP...');
	const outZip = new JSZip();
	outZip.file('routes.json', JSON.stringify(routes, null, 2));
	outZip.file('trips.json', JSON.stringify(trips));
	outZip.file('stops.json', JSON.stringify(stops, null, 2));
	outZip.file('shapes.json', JSON.stringify(shapes));
	outZip.file('shape-route-map.json', JSON.stringify(shapeRouteMap, null, 2));

	let totalStopTimesTrips = 0;
	Object.keys(stopTimesByRoute).forEach(routeId => {
		const routeStopTimes = stopTimesByRoute[routeId];
		totalStopTimesTrips += Object.keys(routeStopTimes).length;
		const safeRouteId = routeId.replace(/[^a-zA-Z0-9_-]/g, '_');
		outZip.file(`stop-times-route-${safeRouteId}.json`, JSON.stringify(routeStopTimes));
	});

	const metadata = {
		generated_at: new Date().toISOString(),
		source: file.name,
		stats: {
			routes: Object.keys(routes).length,
			trips: Object.keys(trips).length,
			stops: Object.keys(stops).length,
			shapes: Object.keys(shapes).length,
			stop_times_trips: totalStopTimesTrips,
			stop_times_route_files: Object.keys(stopTimesByRoute).length
		},
		stop_times_files: Object.keys(stopTimesByRoute).reduce((acc, routeId) => {
			const safeRouteId = routeId.replace(/[^a-zA-Z0-9_-]/g, '_');
			acc[routeId] = `stop-times-route-${safeRouteId}.json`;
			return acc;
		}, {})
	};

	outZip.file('metadata.json', JSON.stringify(metadata, null, 2));

	log('Generating download file...');
	const content = await outZip.generateAsync({ type: 'blob' });
	const url = URL.createObjectURL(content);
	const a = document.createElement('a');
	a.href = url;
	a.download = `gtfs-processed-${Date.now()}.zip`;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);

	log('Done — downloaded processed JSON bundle');
}

processBtn.addEventListener('click', async () => {
	outputEl.textContent = '';
	const file = fileInput.files[0];
	if (!file) { log('No file selected'); return; }
	try {
		await processZip(file);
	} catch (err) {
		log('Processing failed: ' + (err.message || err));
		console.error(err);
	}
});

// Check calendar only (fast): unzip and read calendar.txt, then show decision
async function checkCalendarOnly(file) {
	log('Checking calendar in ZIP...');
	const arrayBuffer = await file.arrayBuffer();
	const zip = await JSZip.loadAsync(arrayBuffer);

	const f = zip.file('calendar.txt') || zip.file('calendar.txt'.toLowerCase());
	if (!f) {
		log('calendar.txt not found in ZIP');
		console.log('calendar.txt not found in ZIP');
		return;
	}

	const txt = await f.async('string');
	const rows = safeParseCSV(txt);
	const earliestStart = getEarliestCalendarStartDate(rows);
	const dateCheck = checkCalendarDateLocal(earliestStart);

	log(`[Calendar Check] ${dateCheck.reason}`);
	console.log('[Calendar Check]', dateCheck);
}

checkCalendarBtn.addEventListener('click', async () => {
	outputEl.textContent = '';
	const file = fileInput.files[0];
	if (!file) { log('No GTFS ZIP selected'); return; }
	try {
		await checkCalendarOnly(file);
	} catch (err) {
		log('Calendar check failed: ' + (err.message || err));
		console.error(err);
	}
});

// --- Complete recorded trips using local data/ stop-times files ---
const recordingInput = document.getElementById('recordingFile');
const completeBtn = document.getElementById('completeBtn');
const completeStatus = document.getElementById('completeStatus');
const completeOutput = document.getElementById('completeOutput');

const clearBtn = document.getElementById('clearBtn');

// When a recording file is selected, show totals and unscheduled counts immediately
recordingInput.addEventListener('change', async () => {
	completeOutput.textContent = '';
	const file = recordingInput.files[0];
	if (!file) {
		completeStatus.textContent = 'Idle';
		return;
	}

	try {
		const text = await file.text();
		let obj = JSON.parse(text);
		const recordedData = obj && obj.recordedData ? obj.recordedData : obj;

		const totalTrips = Object.keys(recordedData || {}).length;
		let unscheduled = 0;
		for (const [tripId, trip] of Object.entries(recordedData || {})) {
			const stops = Object.values(trip.stops || {});
			if (stops.length > 0 && stops.every(s => !s.sch_arr && !s.sch_dep)) unscheduled++;
		}

		const msg = `Loaded ${file.name}: ${totalTrips} trips, ${unscheduled} without scheduled data`;
		completeStatus.textContent = msg;
		completeOutput.textContent += msg + '\n';
		console.log(msg);
	} catch (err) {
		const m = 'Failed to parse recording file: ' + (err.message || err);
		completeStatus.textContent = m;
		completeOutput.textContent += m + '\n';
		console.error(err);
	}
});

function setCompleteStatus(msg) {
	completeStatus.textContent = msg;
	completeOutput.textContent += msg + '\n';
}

function downloadBlob(filename, obj) {
	const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url; a.download = filename;
	document.body.appendChild(a); a.click(); a.remove();
	URL.revokeObjectURL(url);
}

async function completeRecordedFile(file) {
	setCompleteStatus('Reading recording file...');
	const text = await file.text();
	let obj;
	try { obj = JSON.parse(text); } catch (e) { throw new Error('Invalid JSON recording file'); }

	// Support either { recordedData: { ... } } or raw recordedData object
	let wrapper = null;
	let recordedData = null;
	if (obj && obj.recordedData) {
		wrapper = obj;
		recordedData = obj.recordedData;
	} else {
		recordedData = obj;
	}

	// Find trips without scheduled times
	const tripsWithoutSchedule = [];
	const routesToComplete = new Set();
	for (const [tripId, trip] of Object.entries(recordedData)) {
		const stops = Object.values(trip.stops || {});
		if (stops.length > 0 && stops.every(s => !s.sch_arr && !s.sch_dep)) {
			tripsWithoutSchedule.push(tripId);
			if (trip.rid) routesToComplete.add(trip.rid);
		}
	}

	setCompleteStatus(`Found ${tripsWithoutSchedule.length} trips without scheduled data across ${routesToComplete.size} routes`);

	if (tripsWithoutSchedule.length === 0) {
		return { updatedCount: 0, recordedWrapper: wrapper, recordedData };
	}

	// Load local metadata.json from data/
	setCompleteStatus('Loading local metadata.json from data/metadata.json...');
	let metadata;
	try {
		const resp = await fetch('./data/metadata.json');
		if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
		metadata = await resp.json();
	} catch (err) {
		throw new Error('Failed to load data/metadata.json. Ensure you open via http server or the file exists. ' + err.message);
	}

	// For each route, load file and apply to matching trips
	let appliedCount = 0;
	const appliedStops = []; // track which stops we applied so we convert only these

	for (const routeId of Array.from(routesToComplete)) {
		const filename = metadata.stop_times_files && metadata.stop_times_files[routeId];
		if (!filename) {
			setCompleteStatus(`No stop_times file mapping for route ${routeId} in metadata.json`);
			continue;
		}

		setCompleteStatus(`Loading ./data/${filename} for route ${routeId}...`);
		let resp;
		try {
			resp = await fetch(`./data/${filename}`);
			if (!resp.ok) { setCompleteStatus(`Failed to load ./data/${filename}: HTTP ${resp.status}`); continue; }
		} catch (err) {
			setCompleteStatus(`Fetch failed for ./data/${filename}: ${err.message}`);
			continue;
		}

		let stopTimesData;
		try { stopTimesData = await resp.json(); } catch (err) { setCompleteStatus(`Invalid JSON in ${filename}`); continue; }

		for (const tripId of tripsWithoutSchedule) {
			const trip = recordedData[tripId];
			if (!trip || trip.rid !== routeId) continue;
			const stopTimesForTrip = stopTimesData[tripId];
			if (!stopTimesForTrip) continue;

			// Apply scheduled times to each stop in recorded trip if available
			for (const [seqKey, stop] of Object.entries(trip.stops || {})) {
				const seq = parseInt(seqKey);
				const schedStop = stopTimesForTrip.find(s => Number(s.seq) === seq);
				if (schedStop) {
					const arr = schedStop.arr || null;
					const dep = schedStop.dep || null;
					if (arr || dep) {
						// Only set sch_arr/sch_dep if not already present
						if (!stop.sch_arr && (arr || dep)) {
							stop.sch_arr = arr || dep;
							appliedStops.push({ tripId, seq, field: 'sch_arr' });
						}
						if (!stop.sch_dep && dep && dep !== arr) {
							stop.sch_dep = dep;
							appliedStops.push({ tripId, seq, field: 'sch_dep' });
						}
						appliedCount++;
					}
				}
			}
		}
	}

	setCompleteStatus(`Applied scheduled strings to ${appliedCount} stops (will now convert newly-applied times to Toronto epoch)`);

	// Determine Toronto midnight from earliest arrival in recordedData (use existing arr values)
	let minArr = Infinity;
	for (const tripId in recordedData) {
		const stops = Object.values(recordedData[tripId].stops || {});
		for (const stop of stops) {
			if (stop.arr !== null && stop.arr !== undefined) {
				const t = Number(stop.arr);
				if (!Number.isNaN(t) && t < minArr) minArr = t;
			}
		}
	}

	let torontoMidnight = null;
	if (minArr !== Infinity) {
		const utcDate = new Date(minArr * 1000);
		const formatter = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'America/Toronto' });
		const parts = formatter.formatToParts(utcDate);
		const dateObj = {};
		parts.forEach(({ type, value }) => { dateObj[type] = parseInt(value); });
		torontoMidnight = Math.floor(Date.UTC(dateObj.year, dateObj.month - 1, dateObj.day, 0, 0, 0) / 1000);
	} else {
		setCompleteStatus('Cannot determine Toronto date because no arrival timestamps found in recording; skipping conversion.');
	}

	// Convert only newly-applied sch_* strings to epoch seconds (Toronto time)
	if (torontoMidnight !== null) {
		for (const applied of appliedStops) {
			const trip = recordedData[applied.tripId];
			if (!trip) continue;
			const stop = trip.stops && trip.stops[applied.seq];
			if (!stop) continue;

			if (applied.field === 'sch_arr' && typeof stop.sch_arr === 'string') {
				const p = stop.sch_arr.split(':').map(Number);
				if (p.length === 3 && p.every(n => !Number.isNaN(n))) {
					let seconds = p[0]*3600 + p[1]*60 + p[2];
					let epoch = torontoMidnight + seconds;
					if (stop.arr !== null && stop.arr !== undefined && (Number(stop.arr) - epoch) > 43200) {
						epoch += 86400;
					}
					stop.sch_arr = epoch;
				}
			}

			if (applied.field === 'sch_dep' && typeof stop.sch_dep === 'string') {
				const p = stop.sch_dep.split(':').map(Number);
				if (p.length === 3 && p.every(n => !Number.isNaN(n))) {
					let seconds = p[0]*3600 + p[1]*60 + p[2];
					let epoch = torontoMidnight + seconds;
					if (stop.arr !== null && stop.arr !== undefined && (Number(stop.arr) - epoch) > 43200) {
						epoch += 86400;
					}
					stop.sch_dep = epoch;
				}
			}
		}
	}

	// Build output object preserving original wrapper shape
	let outObj;
	if (wrapper) {
		wrapper.recordedData = recordedData;
		outObj = wrapper;
	} else {
		outObj = recordedData;
	}

	setCompleteStatus('Completed. Offering updated JSON for download.');
	const filename = `recording-completed-${Date.now()}.json`;
	downloadBlob(filename, outObj);

	return { updatedCount: appliedCount, recordedWrapper: outObj };
}

completeBtn.addEventListener('click', async () => {
	completeOutput.textContent = '';
	const file = recordingInput.files[0];
	if (!file) { setCompleteStatus('No recording file selected'); return; }
	try {
		await completeRecordedFile(file);
	} catch (err) {
		setCompleteStatus('Error: ' + (err.message || err));
		console.error(err);
	}
});

// Clear scheduled times from all stops in the selected recording file
async function clearScheduledTimesFile(file) {
	setCompleteStatus('Reading recording file to clear scheduled times...');
	const text = await file.text();
	let obj;
	try { obj = JSON.parse(text); } catch (e) { throw new Error('Invalid JSON recording file'); }

	let wrapper = null;
	let recordedData = null;
	if (obj && obj.recordedData) { wrapper = obj; recordedData = obj.recordedData; }
	else recordedData = obj;

	let totalStops = 0;
	let clearedCount = 0;

	for (const [tripId, trip] of Object.entries(recordedData || {})) {
		const stops = trip.stops || {};
		for (const [seqKey, stop] of Object.entries(stops)) {
			totalStops++;
			if (stop && ('sch_arr' in stop || 'sch_dep' in stop)) {
				if ('sch_arr' in stop) { delete stop.sch_arr; clearedCount++; }
				if ('sch_dep' in stop) { delete stop.sch_dep; clearedCount++; }
			}
		}
	}

	setCompleteStatus(`Cleared ${clearedCount} scheduled fields across ${totalStops} stops`);

	const outObj = wrapper ? (wrapper.recordedData = recordedData, wrapper) : recordedData;
	const filename = `recording-cleared-${Date.now()}.json`;
	downloadBlob(filename, outObj);
	setCompleteStatus('Download ready: ' + filename);
	return { clearedCount, totalStops };
}

clearBtn.addEventListener('click', async () => {
	completeOutput.textContent = '';
	const file = recordingInput.files[0];
	if (!file) { setCompleteStatus('No recording file selected'); return; }
	try {
		await clearScheduledTimesFile(file);
	} catch (err) {
		setCompleteStatus('Error: ' + (err.message || err));
		console.error(err);
	}
});
