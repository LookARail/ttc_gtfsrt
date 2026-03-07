# GTFS Static Data Processing

This repository contains automated workflows and scripts to process TTC GTFS static data for efficient client-side consumption.

## Overview

Instead of downloading and processing a large GTFS ZIP file client-side, this system:
1. **Downloads** GTFS ZIP via GitHub Actions (runs daily)
2. **Processes** all GTFS files into optimized JSON
3. **Commits** processed files to the repository
4. **Serves** processed data directly to clients via GitHub's CDN

## Benefits

✅ **Instant Load** - No client-side unzipping/parsing  
✅ **Better Performance** - Works on low-end devices  
✅ **Smaller Payload** - Optimized JSON files  
✅ **Automatic Updates** - Daily processing via GitHub Actions  
✅ **Free Hosting** - GitHub serves files through their CDN  

## Directory Structure

```
.github/
  workflows/
    update_gtfs_static.yml    # GitHub Actions workflow

scripts/
  process-gtfs.js             # Processing script
  package.json                # Dependencies

data/                         # Auto-generated (committed by workflow)
  routes.json                 # All routes
  trips.json                  # All trips
  stops.json                  # All stops
  shapes.json                 # All shapes with coordinates
  shape-route-map.json        # Derived shape_id → route_id mapping
  stop-times-index.json       # Indexed stop_times by trip_id
  metadata.json               # Processing metadata
```

## Setup Instructions

### 1. Initial Setup (One-time)

1. **Install dependencies** for the processing script:
   ```bash
   cd scripts
   npm install
   ```

2. **Test locally** (optional):
   ```bash
   npm run process
   ```
   This downloads, processes, and outputs data to `data/` folder.

### 2. GitHub Actions Setup

The workflow is already configured in `.github/workflows/update_gtfs_static.yml`.

**To enable it:**

1. Push this repository to GitHub
2. The workflow will automatically run:
   - **Daily at 2 AM UTC** (9 PM Toronto time)
   - **On demand** via Actions tab → "Update GTFS Static Data" → "Run workflow"

**Important:** Make sure your repository has write permissions for GitHub Actions:
- Go to: Settings → Actions → General → Workflow permissions
- Select: "Read and write permissions"
- Click "Save"

### 3. Update Your Main Application

Update the `GITHUB_REPO` constant in your main.js:

```javascript
// main.js (around line 8)
const GITHUB_REPO = "YOUR_USERNAME/YOUR_REPO"; // e.g., "johndoe/gtfs-processed-data"
```

Replace `YOUR_USERNAME/YOUR_REPO` with your actual GitHub username and repository name.

## Workflow Details

### Schedule
- Runs daily at 2 AM UTC (9 PM Toronto EST/EDT)
- Can be triggered manually from Actions tab

### Process
1. Download GTFS ZIP from TTC Open Data Portal
2. Unzip and parse all CSV files
3. Convert to optimized JSON format
4. Build indexes and derived data structures
5. Commit processed files if changes detected
6. Clean up temporary files

### Failure Handling
- Retries are not automatic (to avoid loops)
- Check Actions tab for error logs
- Manually re-run failed workflows from Actions tab

## Data Files

### routes.json
```json
{
  "route_id": {
    "route_id": "1",
    "route_short_name": "1",
    "route_long_name": "Yonge",
    "route_type": 0,
    "route_color": "E31837"
  }
}
```

### trips.json
```json
{
  "trip_id": {
    "trip_id": "123456",
    "route_id": "1",
    "service_id": "WD",
    "trip_headsign": "Southbound",
    "direction_id": 0,
    "block_id": "",
    "shape_id": "shape_1"
  }
}
```

### stop-times-index.json
```json
{
  "trip_id": [
    {
      "trip_id": "123456",
      "arrival_time": "08:00:00",
      "departure_time": "08:00:00",
      "stop_id": "1234",
      "stop_sequence": 1,
      "stop_headsign": "",
      "pickup_type": 0,
      "drop_off_type": 0
    }
  ]
}
```

## Maintenance

### Updating Processing Logic

1. Edit `scripts/process-gtfs.js`
2. Test locally: `cd scripts && npm run process`
3. Commit and push changes
4. Workflow will use updated script on next run

### Manual Trigger

1. Go to Actions tab on GitHub
2. Select "Update GTFS Static Data"
3. Click "Run workflow"
4. Select branch (usually `main`)
5. Click "Run workflow" button

### Check Last Update

View `data/metadata.json` for processing timestamp:
```json
{
  "generated_at": "2026-03-06T02:00:00.000Z",
  "source_url": "https://...",
  "stats": {
    "routes": 213,
    "trips": 45678,
    "stops": 8901,
    "shapes": 456
  }
}
```

## Troubleshooting

### Workflow Fails
- Check Actions tab for error logs
- Common issues:
  - Network timeout downloading GTFS ZIP
  - Invalid CSV format in GTFS data
  - Out of memory (unlikely with current data size)

### Client Can't Load Data
- Verify `GITHUB_REPO` is set correctly in main.js
- Check browser console for 404 errors
- Ensure data files exist in repository
- Check if repository is public or private
  - Private repos: May need authentication for raw files
  - Solution: Make repository public or use GitHub Pages

### Data Seems Outdated
- Check last workflow run in Actions tab
- Verify GTFS source URL is still valid
- Manually trigger workflow to force update

## Cost Considerations

✅ **Free for Public Repositories**
- Unlimited GitHub Actions minutes
- Free CDN hosting via GitHub raw files
- Free bandwidth for serving files

⚠️ **Private Repositories**
- 2000 free Actions minutes/month
- Each workflow run uses ~5 minutes
- 30 days × 1 run/day = 150 minutes/month
- Well within free tier

## Performance Notes

**Before (Client-side processing):**
- Download 15-30 MB ZIP file
- ~3-5 seconds to unzip and parse
- High memory usage
- Slow on mobile devices

**After (GitHub Actions processing):**
- Download ~5-10 MB JSON files (compressed)
- Instant parsing (native JSON)
- Low memory usage
- Fast on all devices

## License

Same as parent project.
