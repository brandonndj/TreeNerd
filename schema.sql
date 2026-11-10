-- Cloudflare D1 schema for the trees app.
-- The pipeline loads data into *_new staging tables and then swaps them in
-- (see pipeline/build.py), so this file is also the source of truth for that.

CREATE TABLE IF NOT EXISTS species (
  id INTEGER PRIMARY KEY,           -- Trees.sg SPCS_CD / Flora&Fauna Web species id
  master_id INTEGER,
  scientific TEXT,
  common TEXT,
  aliases TEXT,                     -- JSON array of other common names (incl. Malay/Chinese)
  family TEXT,
  growth_form TEXT,
  native_distribution TEXT,
  conservation_status TEXT,
  native INTEGER,                   -- 1 native, 0 non-native, NULL unknown
  ffw_url TEXT,
  tree_count INTEGER,
  family_src TEXT,                  -- NULL = NParks; wcvp | wcvp-genus | nparks-genus | override
  native_src TEXT                   -- NULL = NParks; wcvp (native range entirely outside Asia) | override
);

CREATE TABLE IF NOT EXISTS places (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,               -- road | park | subzone | planning_area | pcn | constituency | heritage_road
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  alt TEXT,                         -- JSON array of alternative names
  tree_count INTEGER,
  species_count INTEGER,
  heritage_count INTEGER,
  carbon_kg REAL,
  bbox TEXT,                        -- JSON [minLng,minLat,maxLng,maxLat]
  top_species TEXT,                 -- JSON [[species_id,count],...]
  extra TEXT                        -- JSON
);

CREATE TABLE IF NOT EXISTS trees (
  id INTEGER PRIMARY KEY,           -- Trees.sg Public_treeid
  lng REAL NOT NULL,
  lat REAL NOT NULL,
  cell INTEGER NOT NULL,            -- ~220 m grid cell for proximity queries
  species_id INTEGER,
  girth_m REAL,
  girth_band TEXT,
  size TEXT,
  height_band TEXT,
  height_m INTEGER,                 -- upper bound of height band
  age INTEGER,
  category TEXT,                    -- street | park | botanic | user | conservation | heritage | other
  date_planted TEXT,
  incorrect INTEGER,
  road_id INTEGER,
  road_dist REAL,
  subzone_id INTEGER,
  pa_id INTEGER,
  park_id INTEGER,
  pcn_id INTEGER,
  ed_id INTEGER,
  hr_id INTEGER,
  tca TEXT,
  nature_way TEXT,
  land_use TEXT,
  ht_no TEXT,
  ht_url TEXT,
  ht_desc TEXT,
  carbon_kg REAL,                   -- estimate: Chave et al. 2014 allometry, 47% of biomass
  carbon_nparks REAL,               -- raw value from NParks Carbon_Storage table (units undocumented)
  last_edited TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_places_kind_slug ON places(kind, slug);
CREATE INDEX IF NOT EXISTS idx_trees_road ON trees(road_id);
CREATE INDEX IF NOT EXISTS idx_trees_park ON trees(park_id);
CREATE INDEX IF NOT EXISTS idx_trees_subzone ON trees(subzone_id);
CREATE INDEX IF NOT EXISTS idx_trees_pa ON trees(pa_id);
CREATE INDEX IF NOT EXISTS idx_trees_pcn ON trees(pcn_id);
CREATE INDEX IF NOT EXISTS idx_trees_ed ON trees(ed_id);
CREATE INDEX IF NOT EXISTS idx_trees_hr ON trees(hr_id);
CREATE INDEX IF NOT EXISTS idx_trees_species ON trees(species_id);
CREATE INDEX IF NOT EXISTS idx_trees_cell ON trees(cell);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
