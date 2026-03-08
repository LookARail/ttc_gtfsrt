# GTFS-RT Server

Express server that proxies TTC GTFS-RT feeds and records trip performance data.

## Endpoints

### RT Feed Proxies
- `GET /vehicles` - Vehicle positions (10s cache)
- `GET /trip-updates` - Trip updates (60s cache)

### Trip Recording
- `GET /export-trip-data` - Export all recorded trip data with statistics
- `POST /clear-trip-data` - Clear all recorded data and caches

## Environment Variables

### Required on Render
- `GITHUB_REPO` - Your GitHub username/repo (e.g., `username/GTFSRT`)
  - Used to fetch static GTFS `stop_times_*.json` files for scheduled times
  - Set in Render Dashboard → Environment → Add Environment Variable

### Optional
- `PORT` - Server port (default: 3000, Render sets automatically)

## Background Recording

The server continuously records trip data:
- Fetches trip updates every 60 seconds
- Loads route scheduled times on-demand (max 30 routes per cycle)
- Pre-populates all scheduled stops when route data loads
- Memory-optimized: ~170-190 MB with 24 hours of data

## Deployment

### Deploy to Render
1. Connect GitHub repo
2. Set environment variable: `GITHUB_REPO=yourusername/GTFSRT`
3. Deploy branch: `main`
4. Server will auto-start and begin recording

### Keep Alive
GitHub Actions pings server every 10 minutes to prevent spin-down (see `.github/workflows/keep-render-awake.yml`)

### Daily Export
GitHub Actions exports and clears data daily at 8 AM UTC (see `.github/workflows/export-trip-recordings.yml`)

## Testing

### Test Endpoints Manually
```bash
# Export data
curl https://ttc-gtfsrt.onrender.com/export-trip-data

# Clear data
curl -X POST https://ttc-gtfsrt.onrender.com/clear-trip-data
```

### Test Workflow
1. Go to GitHub → Actions → "Export RT Trip Recordings"
2. Click "Run workflow"
3. Leave "clearCache" unchecked for testing
4. Check `recordedRTData/` folder for exported file

## Memory Management

- **Base**: ~70 MB (Node.js + Express)
- **Per trip**: ~3 KB (metadata + stops + scheduled times)
- **Daily accumulation**: ~100-120 MB (1000 trips)
- **Peak with route loading**: ~190 MB (transient spikes)
- **After daily clear**: Back to base ~70 MB

Safe for Render free tier (512 MB limit) with daily exports.
