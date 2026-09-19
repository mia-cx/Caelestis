CREATE TABLE work_region_deletions (id varchar(256) PRIMARY KEY NOT NULL)
ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

-- A single-statement trigger also works with the preceding binary and migration runner.
CREATE TRIGGER work_regions_retired_insert BEFORE INSERT ON work_regions
FOR EACH ROW SET NEW.id = IF(EXISTS (SELECT 1 FROM work_region_deletions WHERE id = NEW.id LOCK IN SHARE MODE), NULL, NEW.id);

INSERT INTO work_region_deletions SELECT id FROM work_regions WHERE state = 'deleted';
DELETE FROM work_regions WHERE state = 'deleted';
