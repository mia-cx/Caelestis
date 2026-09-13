CREATE TABLE work_regions (
  id varchar(256) PRIMARY KEY NOT NULL,
  season bigint NOT NULL,
  surface_kind varchar(256) NOT NULL,
  alliance_id bigint,
  template_id varchar(256),
  claimant_user_id bigint NOT NULL,
  claimant_name longtext NOT NULL,
  shape longtext,
  x bigint NOT NULL,
  y bigint NOT NULL,
  w bigint NOT NULL,
  h bigint NOT NULL,
  label longtext NOT NULL,
  created_at bigint NOT NULL,
  token_hash longtext
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;
CREATE INDEX work_regions_scope_idx ON work_regions (season, surface_kind, alliance_id, template_id);
