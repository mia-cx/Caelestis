CREATE TABLE work_region_deletions (id text PRIMARY KEY NOT NULL);

CREATE FUNCTION reject_retired_work_region() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Serialize insertion with retirement before checking visibility at READ COMMITTED.
  PERFORM pg_advisory_xact_lock(hashtext('work_region_deletions'), hashtext(NEW.id));
  IF TG_TABLE_NAME = 'work_regions' AND EXISTS (SELECT 1 FROM work_region_deletions WHERE id = NEW.id) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER work_regions_retired_insert BEFORE INSERT ON work_regions
FOR EACH ROW EXECUTE FUNCTION reject_retired_work_region();
CREATE TRIGGER work_region_deletions_lock BEFORE INSERT ON work_region_deletions
FOR EACH ROW EXECUTE FUNCTION reject_retired_work_region();

INSERT INTO work_region_deletions SELECT id FROM work_regions WHERE state = 'deleted';
DELETE FROM work_regions WHERE state = 'deleted';
