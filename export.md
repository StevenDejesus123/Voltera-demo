# Phase 3.2: Export Module Documentation

## Overview

This module generates geospatial export artifacts from the ML ranking outputs. It joins model predictions with census tract/county/MSA geometries and exports to multiple formats for visualization and analysis.

**Module Location:** `src/exports/export_rankings.py`

---

## What This Module Does

1. **Loads ranking outputs** from `data/outputs/4Cs_AVCustomer_Rankings_AllLevels-refactored.xlsx`
2. **Joins rankings with spatial geometries** from shapefiles (Tract.shp, County.shp)
3. **Adds a Rank column** (1 = best site candidate, based on probability score)
4. **Generates MSA boundaries** by dissolving tract polygons using master geocode mapping
5. **Exports to multiple formats:**
   - CSV/Excel: Tabular data for spreadsheet analysis
   - GeoJSON: Full-resolution geospatial data for QGIS/ArcGIS/UI
   - KML/KMZ: Simplified geometries for Google Earth visualization

---

## How to Run

### Standalone Export (without full pipeline)

```bash
# Activate virtual environment
source venv/bin/activate  # macOS/Linux
# or: venv\Scripts\activate.bat  # Windows

# Run export module directly
python -c "
from pathlib import Path
from src.utils.config_utils import load_config
from src.exports.export_rankings import run_exports

config = load_config(Path('config/settings.yaml'))
result = run_exports(config)
print(f'Export complete: {result[\"total_files\"]} files')
print(f'Directory: {result[\"exports_dir\"]}')
"
```

### Full Pipeline (includes export)

```bash
# Run complete pipeline (ETL + ML Training + Export)
python run_full_refresh.py
```

The export step runs automatically after ML training (see `run_full_refresh.py` line 92-95).

---

## Output Files

All exports are saved to `data/exports/`

### File Inventory

| Level      | Records | CSV    | Excel  | GeoJSON | KML    | KMZ    |
|:-----------|--------:|-------:|-------:|--------:|-------:|-------:|
| **Tract**  |  85,072 |  11 MB | 7.3 MB |  3.1 GB | 133 MB |  22 MB |
| **County** |   3,183 | 358 KB | 297 KB |  410 MB | 7.9 MB | 2.1 MB |
| **MSA**    |     392 |  54 KB |  47 KB |  752 MB |  24 MB | 6.0 MB |

**Total: 15 files**

### Column Structure

Each export includes these columns:

| Column                                    | Description                                              |
|:------------------------------------------|:---------------------------------------------------------|
| `GEOID` / `Tract_GeoID` / `County_GeoID`  | Census geographic identifier                             |
| `Rank`                                    | 1 = highest probability (best site), ascending           |
| `P`                                       | Probability score (0.0 - 1.0) from logistic regression   |
| `Prediction-01`                           | Binary prediction (1 = likely good site, 0 = unlikely)   |
| `1-P`                                     | Complement probability                                   |
| `y_true`                                  | Actual target value (for model evaluation)               |
| `NAME` / `NAMELSAD`                       | Geographic area name                                     |
| `geometry`                                | Polygon geometry (GeoJSON/KML only)                      |

---

## KML Geometry Simplification

### The Problem

Google Earth has a **250,000 vertex limit** for KML imports. Census boundary polygons are highly detailed:

| Level    | Original Vertices | Google Earth Status |
|:---------|------------------:|:--------------------|
| Tract    |      66.7 million | Far exceeds limit   |
| County   |       8.7 million | Exceeds limit       |
| MSA      |      15.5 million | Exceeds limit       |

### The Solution

We apply **Douglas-Peucker simplification** before KML export using GeoPandas `simplify()`.

**Configuration** (`config/settings.yaml`):
```yaml
exports:
  simplification:
    kml_tolerance: 0.005  # ~500m precision
    preserve_topology: true
```

### Tolerance Selection

I tested different tolerance values on county data:

| Tolerance   | Precision  |  Vertices | Reduction | Google Earth    |
|:------------|:-----------|----------:|----------:|:----------------|
| 0.001       | ~111m      |   437,376 |     95.0% | Still too large |
| **0.005**   | **~555m**  | **138,746** | **98.4%** | **Works**     |
| 0.01        | ~1.1km     |    84,746 |     99.0% | Works           |

**Why 0.005?**
- Under 250K vertex limit for county-level data
- ~500m precision is adequate for regional visualization
- Preserves recognizable boundary shapes
- Good balance between file size and visual quality

### Simplification Results

| Level    | Original | Simplified | Reduction |
|:---------|---------:|-----------:|----------:|
| Tract    |    66.7M |       1.5M |     97.7% |
| County   |     8.7M |       139K |     98.4% |
| MSA      |    15.5M |       404K |     97.4% |

---

## Heat Map Coloring (KML)

KML exports use a **red-yellow-green gradient** based on probability score:

| Probability | Color  | Meaning                                 |
|:------------|:-------|:----------------------------------------|
| 0.0 - 0.3   | Red    | Low probability (poor site candidate)   |
| 0.3 - 0.7   | Yellow | Medium probability                      |
| 0.7 - 1.0   | Green  | High probability (good site candidate)  |

The color is embedded in each KML placemark's `<PolyStyle>` element.

---

## Testing & Visualization

### Google Earth (KML/KMZ files)

**Best for:** County-level visualization (under 250K vertex limit) and others too if needed. 

1. Download Google Earth Pro: https://www.google.com/earth/versions/#earth-pro
2. Open `data/exports/rankings_county.kml` (or .kmz)
3. Counties display with heat map colors
4. Click any polygon to see: Rank, ID, Probability, Prediction

**Limitations:**
- Tract and MSA files exceed vertex limit, slow but works.
- Use QGIS for those levels

### QGIS (GeoJSON files)

**Best for:** All levels, full-resolution analysis, professional mapping

1. Download QGIS: https://qgis.org/download/
2. Open QGIS, drag any `.geojson` file onto the map canvas
3. Style by Rank or Probability:
   - Right-click layer → Properties → Symbology
   - Change "Single Symbol" to "Graduated"
   - Value: `Rank` or `P`
   - Color ramp: `RdYlGn` (Red-Yellow-Green)
   - Click "Classify" → OK

**Useful QGIS Features:**
- Filter: Right-click → Filter → `"Rank" <= 100` (show top 100 only)
- Labels: Properties → Labels → Single Labels → Value: `Rank`
- Identify: Click `i` tool, then click any polygon for details
- Export: Right-click → Export → Save Features As (Shapefile, GeoPackage, etc.)

### Excel/CSV (Tabular analysis)

**Best for:** Data analysis, sorting, filtering, pivot tables

1. Open `rankings_county.xlsx` in Excel
2. Sort by `Rank` column (ascending) to see top sites
3. Filter by `Prediction-01 = 1` for predicted positive sites
4. Create pivot tables by state/region

## Code Architecture

### Module Structure

```
src/exports/
├── __init__.py              # Module init, exports run_exports()
└── export_rankings.py       # Main export logic (~780 lines)
```

### Key Functions

| Function                              | Purpose                                    |
|:--------------------------------------|:-------------------------------------------|
| `run_exports(config)`                 | Main entry point, orchestrates all exports |
| `_load_rankings(path)`                | Load MSA/County/Tract sheets from Excel    |
| `_load_spatial_files(dir)`            | Load Tract.shp and County.shp              |
| `_load_master_geocode(path)`          | Load tract-to-MSA mapping                  |
| `_join_rankings_with_geometry()`      | Merge rankings with spatial data           |
| `_dissolve_tracts_to_msa()`           | Create MSA polygons from tracts            |
| `_add_rank_column(df)`                | Add Rank column based on P                 |
| `_simplify_geometry(gdf)`             | Reduce vertices for KML                    |
| `_export_csv/excel/geojson/kml/kmz()` | Format-specific exporters                  |
| `_probability_to_kml_color(p)`        | Convert probability to ABGR color          |
| `_escape_xml(text)`                   | Escape special characters for KML          |

### Configuration

All export settings are in `config/settings.yaml`:

```yaml
exports:
  output_dir: "data/exports"
  formats:
    - csv
    - excel
    - geojson
    - kml
    - kmz
  simplification:
    kml_tolerance: 0.005
    preserve_topology: true
```

---

## Integration with Pipeline

The export module is called from `run_full_refresh.py` after ML training:

```python
# run_full_refresh.py (lines 92-95)
from src.exports.export_rankings import run_exports

log_step(logger, "Phase 3.2 — generating export artifacts...")
export_result = run_exports(config)
logger.info("Export generation complete. Files: %d", export_result["total_files"])
```

Export metadata is included in the archive (`data/outputs/archive/<run_id>/run_metadata.json`).

---

## Dependencies

Required Python packages (in `venv`):

```
geopandas>=0.14.0    # Spatial joins, geometry operations
pandas>=2.0.0        # DataFrame operations
openpyxl>=3.1.0      # Excel I/O
shapely>=2.0.0       # Geometry simplification (via geopandas)
```

---

## Troubleshooting

### Google Earth: "Too many vertices"

**Cause:** KML file exceeds 250K vertex limit
**Solution:** Use QGIS with GeoJSON, or increase `kml_tolerance` in config

### Slow export (>10 minutes)

**Cause:** Tract-level GeoJSON is 3.1GB with 85K polygons
**Solution:** This is expected. Consider running during off-hours or on a faster machine.

### QGIS crashes on large files

**Cause:** Insufficient RAM for tract-level GeoJSON
**Solution:** Start with county-level first, or use 64-bit QGIS with 16GB+ RAM
