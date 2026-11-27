ALTER TABLE "access_tokens" ADD COLUMN "invite" bigint DEFAULT 0 NOT NULL;
ALTER TABLE "access_tokens" DROP CONSTRAINT "access_tokens_scope_check";
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_scope_check" CHECK("access_tokens"."scope" IN ('read', 'report', 'event_runner', 'admin'));
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_invite_check" CHECK("access_tokens"."invite" IN (0, 1) AND ("access_tokens"."invite" = 0 OR "access_tokens"."scope" = 'event_runner'));
