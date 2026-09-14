ALTER TABLE work_regions ADD COLUMN expires_at bigint;
UPDATE work_regions SET expires_at = (EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint + 2592000000;
CREATE INDEX work_regions_expiry_idx ON work_regions (expires_at);
