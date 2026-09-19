-- Missing-row locks disappear at READ COMMITTED. Both inserts must lock an existing row first.
CREATE TABLE work_region_deletion_guard (id tinyint PRIMARY KEY NOT NULL CHECK (id = 1)) ENGINE=InnoDB;
INSERT INTO work_region_deletion_guard VALUES (1);

CREATE TRIGGER work_region_deletions_fence BEFORE INSERT ON work_region_deletions
FOR EACH ROW SET NEW.id = IF((SELECT id FROM work_region_deletion_guard WHERE id = 1 FOR UPDATE) = 1, NEW.id, NULL);

CREATE TRIGGER work_regions_deletion_fence BEFORE INSERT ON work_regions
FOR EACH ROW PRECEDES work_regions_retired_insert
SET NEW.id = IF((SELECT id FROM work_region_deletion_guard WHERE id = 1 FOR UPDATE) = 1, NEW.id, NULL);
