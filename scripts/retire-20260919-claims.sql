-- Cloudflare incident #464. Run after the region-deletion-guards migration deploys.
-- From the repo root: pnpm --dir apps/backend exec wrangler d1 execute DB --remote --file ../../scripts/retire-20260919-claims.sql
-- Keep the incident guard until the permanent database guard knows all retired IDs.
INSERT INTO work_region_deletions (id) VALUES
  ('01a0b5c7-c8c4-7f3e-8185-1cc456d040ff'),
  ('01a0b5c7-c8c4-7f3e-8185-1cc456d04100'),
  ('01a0b5c7-c8c4-7f3e-8185-1cc456d04101')
ON CONFLICT(id) DO NOTHING;
--> statement-breakpoint
DELETE FROM work_regions WHERE id IN (SELECT id FROM work_region_deletions);
--> statement-breakpoint
DROP TRIGGER IF EXISTS incident_20260919_retired_claims;
--> statement-breakpoint
DROP TRIGGER IF EXISTS incident_20260919_active_claims;
