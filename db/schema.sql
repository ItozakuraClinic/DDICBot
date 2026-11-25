# DDICBot canonical schema (PostgreSQL 18, Neon)
#
# Applied by db/migrate.ts against NEON_DATABASE_URL. Idempotent: safe to
# re-run. Target project late-paper-56442720, branch br-aged-salad-birsqdh2,
# PG 18.7, ap-southeast-1; pg_trgm + fuzzystrmatch are pre-enabled on the
# branch, the CREATE EXTENSION statements below are defensive no-ops.
#
# Conventions:
#   - ingredient_id is the canonical drug key: a STABLE DDInter drug id
#     (e.g. "DDInter1263"). DDInter 2.0 exposes one persistent id per drug
#     across all its CSV files, which is a better natural key than raw names
#     for the pair table.
#   - ddi_pairs stores each unordered pair once, with drug_a < drug_b
#     (lexicographic on ingredient_id).
#   - drug_names stores surface forms (one row per name/lang); the EN
#     synonyms come from RxNorm, ZH/JA from PubChem.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;

CREATE TABLE IF NOT EXISTS drugs (
  id             SERIAL PRIMARY KEY,
  ingredient_id  TEXT UNIQUE NOT NULL,
  canonical_en   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ddi_pairs (
  id                  BIGSERIAL PRIMARY KEY,
  drug_a_ingredient   TEXT NOT NULL,
  drug_b_ingredient   TEXT NOT NULL,
  severity            TEXT CHECK (severity IN ('Major', 'Moderate', 'Minor', 'Unknown')),
  mechanism_en        TEXT,
  source              TEXT NOT NULL DEFAULT 'DDInter 2.0',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (drug_a_ingredient, drug_b_ingredient)
);

CREATE TABLE IF NOT EXISTS drug_names (
  id            SERIAL PRIMARY KEY,
  ingredient_id TEXT NOT NULL REFERENCES drugs(ingredient_id),
  surface_name  TEXT NOT NULL,
  lang          TEXT NOT NULL CHECK (lang IN ('en', 'zh', 'ja')),
  source        TEXT NOT NULL DEFAULT 'RxNorm/PubChem',
  UNIQUE (ingredient_id, surface_name, lang)
);

-- Fuzzy search on surface names and canonical English names.
-- Index name aligns with the applied branch-DB state and
-- scripts/init-schema.ts (idx_drug_names_trgm); an earlier draft of this
-- file named it idx_drug_names_surface_trgm, which the schema lane
-- physically renamed on the branch to avoid a naming split.
CREATE INDEX IF NOT EXISTS idx_drug_names_trgm
  ON drug_names USING gin (surface_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_drugs_canonical_trgm
  ON drugs USING gin (canonical_en gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_drug_names_ingredient
  ON drug_names (ingredient_id);

-- Pair lookup is the hot path (bidirectional: query checks both directions).
CREATE INDEX IF NOT EXISTS idx_ddi_pairs_ab
  ON ddi_pairs (drug_a_ingredient, drug_b_ingredient);
CREATE INDEX IF NOT EXISTS idx_ddi_pairs_ba
  ON ddi_pairs (drug_b_ingredient, drug_a_ingredient);
