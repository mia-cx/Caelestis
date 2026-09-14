ALTER TABLE work_regions ADD COLUMN expires_at INTEGER;
UPDATE work_regions SET expires_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 2592000000;
CREATE INDEX work_regions_expiry_idx ON work_regions (expires_at);
