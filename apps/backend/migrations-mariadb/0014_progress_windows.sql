ALTER TABLE nodes ADD COLUMN progress_start_seconds BIGINT;
ALTER TABLE nodes ADD COLUMN progress_end_seconds BIGINT;
ALTER TABLE templates ADD COLUMN progress_start_seconds BIGINT;
ALTER TABLE templates ADD COLUMN progress_end_seconds BIGINT;
