CREATE TABLE work_regions (
  id text PRIMARY KEY NOT NULL,
  season bigint NOT NULL,
  surface_kind text NOT NULL,
  alliance_id bigint,
  template_id text,
  claimant_user_id bigint NOT NULL,
  claimant_name text NOT NULL,
  shape text,
  x bigint NOT NULL,
  y bigint NOT NULL,
  w bigint NOT NULL,
  h bigint NOT NULL,
  label text NOT NULL,
  created_at bigint NOT NULL,
  token_hash text
);
CREATE INDEX work_regions_scope_idx ON work_regions (season, surface_kind, alliance_id, template_id);
