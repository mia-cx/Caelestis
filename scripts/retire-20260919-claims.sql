-- Cloudflare incident #464. Run only after the new backend and region-deletion migration deploy.
-- From the repo root: pnpm --dir apps/backend exec wrangler d1 execute DB --remote --file ../../scripts/retire-20260919-claims.sql
-- A replacement guard permits tombstone insertion while blocking stale active inserts throughout.
CREATE TRIGGER IF NOT EXISTS incident_20260919_active_claims
BEFORE INSERT ON work_regions
WHEN NEW.state != 'deleted' AND NEW.id IN (
  '01a0b5c7-c8c4-7f3e-8185-1cc456d040ff',
  '01a0b5c7-c8c4-7f3e-8185-1cc456d04100',
  '01a0b5c7-c8c4-7f3e-8185-1cc456d04101'
)
BEGIN
  SELECT RAISE(IGNORE);
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS incident_20260919_retired_claims;
--> statement-breakpoint
-- Geometry and timestamps are placeholders for hidden terminal identities, never visible claims.
INSERT INTO work_regions (id, season, surface_kind, claimant_user_id, claimant_name, x, y, w, h, label, created_at, expires_at, state)
VALUES
  ('01a0b5c7-c8c4-7f3e-8185-1cc456d040ff', 0, 'world', 5592323, 'patch', 0, 0, 0, 0, '', 0, 0, 'deleted'),
  ('01a0b5c7-c8c4-7f3e-8185-1cc456d04100', 0, 'world', 5592323, 'patch', 0, 0, 0, 0, '', 0, 0, 'deleted'),
  ('01a0b5c7-c8c4-7f3e-8185-1cc456d04101', 0, 'world', 5592323, 'patch', 0, 0, 0, 0, '', 0, 0, 'deleted')
ON CONFLICT(id) DO UPDATE SET state = 'deleted', shape = NULL;
--> statement-breakpoint
DROP TRIGGER IF EXISTS incident_20260919_active_claims;
