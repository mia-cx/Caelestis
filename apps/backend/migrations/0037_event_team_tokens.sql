PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_access_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`scope` text NOT NULL,
	`created_with_token` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`invite_hash` text,
	`revoked` integer DEFAULT false NOT NULL,
	`team` integer,
	CONSTRAINT "access_tokens_scope_check" CHECK("__new_access_tokens"."scope" IN ('read', 'report', 'event_runner', 'admin')),
	CONSTRAINT "access_tokens_invite_check" CHECK("__new_access_tokens"."invite_hash" IS NULL OR "__new_access_tokens"."scope" = 'event_runner'),
	CONSTRAINT "access_tokens_revoked_check" CHECK("__new_access_tokens"."revoked" IN (0, 1)),
	CONSTRAINT "access_tokens_team_check" CHECK("__new_access_tokens"."team" IS NULL OR ("__new_access_tokens"."team" IN (0, 1, 2, 3) AND "__new_access_tokens"."scope" <> 'admin'))
);
--> statement-breakpoint
INSERT INTO `__new_access_tokens`("token_hash", "label", "scope", "created_with_token", "created_at_ms", "invite_hash", "revoked") SELECT "token_hash", "label", "scope", "created_with_token", "created_at_ms", "invite_hash", "revoked" FROM `access_tokens`;--> statement-breakpoint
DROP TABLE `access_tokens`;--> statement-breakpoint
ALTER TABLE `__new_access_tokens` RENAME TO `access_tokens`;--> statement-breakpoint
PRAGMA foreign_keys=ON;