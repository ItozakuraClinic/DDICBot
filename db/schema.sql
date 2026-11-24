CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;

CREATE TABLE IF NOT EXISTS drugs (
  ingredient_id TEXT PRIMARY KEY,      -- canonical id (RxNorm IN/PIN or DDInter-mapped)
  generic_name  TEXT NOT NULL,
  smiles        TEXT,
  atc           TEXT
);

CREATE TABLE IF NOT EXISTS drug_names (
  name_norm     TEXT PRIMARY KEY,       -- lowercased/stripped surface form
  ingredient_id TEXT NOT NULL REFERENCES drugs(ingredient_id),
  lang          TEXT NOT NULL,          -- 'en' | 'zh' | 'ja'
  source        TEXT NOT NULL           -- 'rxnorm' | 'pubchem' | ...
);

CREATE TABLE IF NOT EXISTS ddi_pairs (
  id_a         TEXT NOT NULL,
  id_b         TEXT NOT NULL,
  severity     TEXT NOT NULL,           -- Major|Moderate|Minor|Unknown
  mechanism    TEXT,                    -- English source text
  management   TEXT,
  PRIMARY KEY (id_a, id_b)
);

CREATE INDEX IF NOT EXISTS idx_drug_names_trgm ON drug_names USING gin (name_norm gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_ddi_pairs_ab ON ddi_pairs (id_a, id_b);
