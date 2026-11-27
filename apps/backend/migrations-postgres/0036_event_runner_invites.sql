ALTER TABLE "access_tokens" ADD COLUMN "invite_hash" text;
ALTER TABLE "access_tokens" ADD COLUMN "revoked" bigint DEFAULT 0 NOT NULL;
ALTER TABLE "access_tokens" DROP CONSTRAINT "access_tokens_scope_check";
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_scope_check" CHECK("access_tokens"."scope" IN ('read', 'report', 'event_runner', 'admin'));
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_invite_check" CHECK("access_tokens"."invite_hash" IS NULL OR "access_tokens"."scope" = 'event_runner');
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_revoked_check" CHECK("access_tokens"."revoked" IN (0, 1));
