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
  native_src TEXT,                  -- NULL = NParks; wcvp (native range entirely outside Asia) | override
  wood_density REAL,                -- g/cm3, Global Wood Density Database v.2; NULL = the build's average is used
  wood_density_src TEXT             -- species | genus
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
  last_edited TEXT,
  measure_flag INTEGER,             -- 1 = recorded girth and height can't both be right (see build.py)
  carbon_skip TEXT                  -- why there is no carbon estimate: flag | palm | wide (see build.py); NULL = estimated
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_places_kind_slug ON places(kind, slug);
-- Cost note: D1 bills every row written, and an index entry counts as a row. The whole database is
-- rewritten on each data update, so each index on trees costs up to ~890,000 writes per update.
-- Columns that are empty for most trees use partial indexes (only the rows that have a value), and
-- there is no index on girth: the few widest trunks are stored in top_trees instead.
CREATE INDEX IF NOT EXISTS idx_trees_road ON trees(road_id) WHERE road_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trees_park ON trees(park_id) WHERE park_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trees_subzone ON trees(subzone_id);
CREATE INDEX IF NOT EXISTS idx_trees_pa ON trees(pa_id);
CREATE INDEX IF NOT EXISTS idx_trees_pcn ON trees(pcn_id) WHERE pcn_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trees_ed ON trees(ed_id);
CREATE INDEX IF NOT EXISTS idx_trees_hr ON trees(hr_id) WHERE hr_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trees_species ON trees(species_id);
CREATE INDEX IF NOT EXISTS idx_trees_cell ON trees(cell);

-- The trees with the widest recorded trunks (the "widest trunks" ranking), widest first.
CREATE TABLE IF NOT EXISTS top_trees (
  rank INTEGER PRIMARY KEY,
  tree_id INTEGER NOT NULL
);

-- Trees added to / no longer in NParks' records, per build that noticed (rolling ~6 months).
CREATE TABLE IF NOT EXISTS changes (
  tree_id INTEGER NOT NULL,
  change TEXT NOT NULL,             -- added | removed
  seen TEXT NOT NULL,               -- date of the build that noticed
  since TEXT,                       -- date of the build it was compared with
  lng REAL,
  lat REAL,
  common TEXT,
  scientific TEXT,
  girth_m REAL,
  road_id INTEGER,
  park_id INTEGER,
  subzone_id INTEGER,
  pa_id INTEGER,
  ed_id INTEGER,
  PRIMARY KEY (tree_id, change, seen)
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
