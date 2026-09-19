CREATE TABLE `work_region_deletions` (
	`id` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER work_regions_retired_insert BEFORE INSERT ON work_regions
WHEN EXISTS (SELECT 1 FROM work_region_deletions WHERE id = NEW.id)
BEGIN SELECT RAISE(IGNORE); END;
--> statement-breakpoint
INSERT INTO work_region_deletions SELECT id FROM work_regions WHERE state = 'deleted';
--> statement-breakpoint
DELETE FROM work_regions WHERE state = 'deleted';
