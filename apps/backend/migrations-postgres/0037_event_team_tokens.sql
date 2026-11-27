ALTER TABLE "access_tokens" ADD COLUMN "team" bigint;
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_team_check" CHECK("access_tokens"."team" IS NULL OR ("access_tokens"."team" IN (0, 1, 2, 3) AND "access_tokens"."scope" <> 'admin'));
