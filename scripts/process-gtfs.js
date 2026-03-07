#!/usr/bin/env node

/**
 * GTFS Static Data Processing Script
 * 
 * Downloads, unzips, and processes GTFS static data files into optimized JSON
 * for direct consumption by the client application.
 * 
 * Outputs:
 * - data/routes.json
 * - data/trips.json
 * - data/stops.json
 * - data/shapes.json
 * - data/shape-route-map.json
 * - data/stop-times-index.json
 * - data/metadata.json
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { parse } = require('csv-parse/sync');
const unzipper = require('unzipper');
const { promisify } = require('util');
const stream = require('stream');
const pipeline = promisify(stream.pipeline);

const GTFS_URL = 'https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/bd4809dd-e289-4de8-bbde-c5c00dafbf4f/resource/28514055-d011-4ed7-8bb0-97961dfe2b66/download/SurfaceGTFS.zip';
const OUTPUT_DIR = path.join(__dirname, '..', 'data');
const TEMP_DIR = path.join(__dirname, '..', 'temp');

// Ensure directories exist
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

/**
 * Download a file from URL
 */
async function downloadFile(url, outputPath) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    
    client.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // Handle redirects
        downloadFile(response.headers.location, outputPath)
          .then(resolve)
          .catch(reject);
        return;
      }
      
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      
      const fileStream = fs.createWriteStream(outputPath);
      response.pipe(fileStream);
      
      fileStream.on('finish', () => {
        fileStream.close();
        resolve();
      });
      
      fileStream.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Unzip GTFS file
 */
async function unzipGTFS(zipPath, extractPath) {
  console.log('Unzipping GTFS data...');
  
  await fs.createReadStream(zipPath)
    .pipe(unzipper.Extract({ path: extractPath }))
    .promise();
  
  console.log('✓ Unzipped successfully');
}

/**
 * Parse CSV file to array of objects
 */
function parseCsvFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    trim: true
  });
}

/**
 * Process routes.txt
 */
function processRoutes(gtfsDir) {
  console.log('Processing routes.txt...');
  const routesFile = path.join(gtfsDir, 'routes.txt');
  if (!fs.existsSync(routesFile)) {
    console.warn('⚠ routes.txt not found');
    return {};
  }
  
  const rows = parseCsvFile(routesFile);
  const routes = {};
  
  rows.forEach(r => {
    routes[r.route_id] = {
      route_id: r.route_id,
      route_short_name: r.route_short_name || '',
      route_long_name: r.route_long_name || '',
      route_type: parseInt(r.route_type) || 0,
      route_color: r.route_color || ''
    };
  });
  
  console.log(`✓ Processed ${Object.keys(routes).length} routes`);
  return routes;
}

/**
 * Process trips.txt
 */
function processTrips(gtfsDir) {
  console.log('Processing trips.txt...');
  const tripsFile = path.join(gtfsDir, 'trips.txt');
  if (!fs.existsSync(tripsFile)) {
    console.warn('⚠ trips.txt not found');
    return { trips: {}, shapeRouteMap: {} };
  }
  
  const rows = parseCsvFile(tripsFile);
  const trips = {};
  const shapeRouteMap = {};
  
  rows.forEach(t => {
    trips[t.trip_id] = {
      trip_id: t.trip_id,
      route_id: t.route_id,
      service_id: t.service_id,
      trip_headsign: t.trip_headsign || '',
      direction_id: parseInt(t.direction_id) || 0,
      block_id: t.block_id || '',
      shape_id: t.shape_id || ''
    };
    
    // Build shape -> route mapping (first trip wins per shape)
    if (t.shape_id && !shapeRouteMap[t.shape_id]) {
      shapeRouteMap[t.shape_id] = t.route_id;
    }
  });
  
  console.log(`✓ Processed ${Object.keys(trips).length} trips`);
  return { trips, shapeRouteMap };
}

/**
 * Process stops.txt
 */
function processStops(gtfsDir) {
  console.log('Processing stops.txt...');
  const stopsFile = path.join(gtfsDir, 'stops.txt');
  if (!fs.existsSync(stopsFile)) {
    console.warn('⚠ stops.txt not found');
    return {};
  }
  
  const rows = parseCsvFile(stopsFile);
  const stops = {};
  
  rows.forEach(s => {
    stops[s.stop_id] = {
      stop_id: s.stop_id,
      stop_name: s.stop_name || '',
      stop_lat: parseFloat(s.stop_lat) || 0,
      stop_lon: parseFloat(s.stop_lon) || 0
    };
  });
  
  console.log(`✓ Processed ${Object.keys(stops).length} stops`);
  return stops;
}

/**
 * Process shapes.txt
 */
function processShapes(gtfsDir) {
  console.log('Processing shapes.txt...');
  const shapesFile = path.join(gtfsDir, 'shapes.txt');
  if (!fs.existsSync(shapesFile)) {
    console.warn('⚠ shapes.txt not found');
    return {};
  }
  
  const rows = parseCsvFile(shapesFile);
  const shapes = {};
  
  rows.forEach(s => {
    if (!shapes[s.shape_id]) {
      shapes[s.shape_id] = [];
    }
    shapes[s.shape_id].push({
      lat: parseFloat(s.shape_pt_lat) || 0,
      lon: parseFloat(s.shape_pt_lon) || 0,
      sequence: parseInt(s.shape_pt_sequence) || 0
    });
  });
  
  // Sort each shape by sequence
  Object.keys(shapes).forEach(shapeId => {
    shapes[shapeId].sort((a, b) => a.sequence - b.sequence);
  });
  
  console.log(`✓ Processed ${Object.keys(shapes).length} shapes`);
  return shapes;
}

/**
 * Build stop_times index (trip_id -> array of row data)
 * This allows selective extraction without parsing the entire file client-side
 */
function processStopTimesIndexByRoute(gtfsDir, trips) {
  console.log('Processing stop_times.txt (building index by route)...');
  const stopTimesFile = path.join(gtfsDir, 'stop_times.txt');
  if (!fs.existsSync(stopTimesFile)) {
    console.warn('⚠ stop_times.txt not found');
    return {};
  }
  
  const rows = parseCsvFile(stopTimesFile);
  
  // First pass: build trip_id -> stop_times mapping
  const tripIndex = {};
  rows.forEach(st => {
    const tripId = st.trip_id;
    if (!tripId) return;
    
    if (!tripIndex[tripId]) {
      tripIndex[tripId] = [];
    }
    
    // Optimize: Remove redundant trip_id, use short field names, omit defaults
    const stopTime = {
      sid: st.stop_id || '',  // stop_id
      seq: parseInt(st.stop_sequence) || 0,  // stop_sequence
      arr: st.arrival_time || '',  // arrival_time
      dep: st.departure_time || ''  // departure_time
    };
    
    // Only include optional fields if they have non-default values
    if (st.stop_headsign) stopTime.hs = st.stop_headsign;
    if (st.pickup_type && st.pickup_type !== '0') stopTime.pu = parseInt(st.pickup_type);
    if (st.drop_off_type && st.drop_off_type !== '0') stopTime.do = parseInt(st.drop_off_type);
    
    tripIndex[tripId].push(stopTime);
  });
  
  // Sort each trip's stop_times by stop_sequence
  Object.keys(tripIndex).forEach(tripId => {
    tripIndex[tripId].sort((a, b) => a.seq - b.seq);
  });
  
  console.log(`✓ Indexed stop_times for ${Object.keys(tripIndex).length} trips`);
  
  // Second pass: group by route_id
  console.log('Grouping stop_times by route...');
  const routeIndex = {};
  let tripsWithoutRoute = 0;
  
  Object.keys(tripIndex).forEach(tripId => {
    const trip = trips[tripId];
    if (!trip || !trip.route_id) {
      tripsWithoutRoute++;
      return;
    }
    
    const routeId = trip.route_id;
    if (!routeIndex[routeId]) {
      routeIndex[routeId] = {};
    }
    
    routeIndex[routeId][tripId] = tripIndex[tripId];
  });
  
  if (tripsWithoutRoute > 0) {
    console.warn(`⚠ ${tripsWithoutRoute} trips without route_id`);
  }
  console.log(`✓ Grouped into ${Object.keys(routeIndex).length} routes`);
  
  return routeIndex;
}

/**
 * Write JSON file
 */
function writeJsonFile(filename, data, minify = false) {
  const outputPath = path.join(OUTPUT_DIR, filename);
  // Use minified JSON for large files, pretty JSON for others
  const jsonString = minify ? JSON.stringify(data) : JSON.stringify(data, null, 2);
  fs.writeFileSync(outputPath, jsonString);
  
  const sizeKB = (fs.statSync(outputPath).size / 1024).toFixed(2);
  console.log(`✓ Written ${filename} (${sizeKB} KB)`);
}

/**
 * Clean up old stop-times files
 */
function cleanupOldStopTimesFiles() {
  console.log('Cleaning up old stop-times files...');
  if (!fs.existsSync(OUTPUT_DIR)) {
    return;
  }
  
  const files = fs.readdirSync(OUTPUT_DIR);
  const stopTimesFiles = files.filter(f => f.startsWith('stop-times-') && f.endsWith('.json'));
  
  stopTimesFiles.forEach(file => {
    fs.unlinkSync(path.join(OUTPUT_DIR, file));
  });
  
  if (stopTimesFiles.length > 0) {
    console.log(`✓ Removed ${stopTimesFiles.length} old stop-times files`);
  } else {
    console.log('✓ No old stop-times files to remove');
  }
}

/**
 * Main processing function
 */
async function processGTFS() {
  console.log('=== GTFS Static Data Processing ===\n');
  
  const startTime = Date.now();
  const zipPath = path.join(TEMP_DIR, 'gtfs.zip');
  const gtfsDir = path.join(TEMP_DIR, 'gtfs');
  
  try {
    // Step 1: Download GTFS ZIP
    console.log('Downloading GTFS ZIP...');
    await downloadFile(GTFS_URL, zipPath);
    console.log('✓ Download complete\n');
    
    // Step 2: Unzip
    if (!fs.existsSync(gtfsDir)) {
      fs.mkdirSync(gtfsDir, { recursive: true });
    }
    await unzipGTFS(zipPath, gtfsDir);
    console.log('');
    
    // Step 3: Process each file
    const routes = processRoutes(gtfsDir);
    const { trips, shapeRouteMap } = processTrips(gtfsDir);
    const stops = processStops(gtfsDir);
    const shapes = processShapes(gtfsDir);
    const stopTimesByRoute = processStopTimesIndexByRoute(gtfsDir, trips);
    
    console.log('');
    
    // Step 4: Clean up old stop-times files before writing new ones
    cleanupOldStopTimesFiles();
    console.log('');
    
    // Step 5: Write output files
    console.log('Writing output files...');
    writeJsonFile('routes.json', routes);
    writeJsonFile('trips.json', trips, true);  // Minify large file
    writeJsonFile('stops.json', stops);
    writeJsonFile('shapes.json', shapes, true);  // Minify large file
    writeJsonFile('shape-route-map.json', shapeRouteMap);
    
    // Write per-route stop-times files
    let totalStopTimesTrips = 0;
    Object.keys(stopTimesByRoute).forEach(routeId => {
      const routeStopTimes = stopTimesByRoute[routeId];
      totalStopTimesTrips += Object.keys(routeStopTimes).length;
      // Sanitize route_id for filename (remove special characters)
      const safeRouteId = routeId.replace(/[^a-zA-Z0-9_-]/g, '_');
      writeJsonFile(`stop-times-route-${safeRouteId}.json`, routeStopTimes, true);
    });
    console.log(`✓ Written ${Object.keys(stopTimesByRoute).length} stop-times files for ${totalStopTimesTrips} trips`);
    
    // Write metadata
    const metadata = {
      generated_at: new Date().toISOString(),
      source_url: GTFS_URL,
      stats: {
        routes: Object.keys(routes).length,
        trips: Object.keys(trips).length,
        stops: Object.keys(stops).length,
        shapes: Object.keys(shapes).length,
        stop_times_trips: totalStopTimesTrips,
        stop_times_route_files: Object.keys(stopTimesByRoute).length
      },
      // Map of route_id to filename for easy lookup
      stop_times_files: Object.keys(stopTimesByRoute).reduce((acc, routeId) => {
        const safeRouteId = routeId.replace(/[^a-zA-Z0-9_-]/g, '_');
        acc[routeId] = `stop-times-route-${safeRouteId}.json`;
        return acc;
      }, {})
    };
    writeJsonFile('metadata.json', metadata);
    
    // Step 6: Cleanup temp files
    console.log('\nCleaning up temporary files...');
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    console.log('✓ Cleanup complete');
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n=== Processing Complete (${duration}s) ===`);
    
  } catch (error) {
    console.error('\n❌ Error processing GTFS:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  processGTFS();
}

module.exports = { processGTFS };
