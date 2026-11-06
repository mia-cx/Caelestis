-- token_hash is longtext here, so the index names its full 64-character prefix.
CREATE INDEX "work_regions_owner_idx" ON "work_regions" ("token_hash"(64), "claimant_user_id");