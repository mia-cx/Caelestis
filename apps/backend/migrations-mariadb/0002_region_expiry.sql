ALTER TABLE work_regions ADD COLUMN expires_at bigint;
UPDATE work_regions SET expires_at = UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000 + 2592000000;
CREATE INDEX work_regions_expiry_idx ON work_regions (expires_at);
