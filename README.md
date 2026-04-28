# TTC GTFS Data Repository

Pre-processed GTFS static data and real-time recording data for TTC transit.

## Data Directory

**`data/`** - GTFS static data files in JSON format
- `routes.json` - Route information
- `stops.json` - Stop locations and details
- `shapes.json` - Route geometries with coordinates
- `stop-times-route-*.json` - Stop times indexed by route
- `shape-route-map.json` - Shape to route mapping
- `metadata.json` - Processing metadata

**`recordedRTData/`** - Archived real-time transit data by date

## Usage

External applications access data files directly from this repository.
