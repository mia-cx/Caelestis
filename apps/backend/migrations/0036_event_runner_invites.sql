PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_access_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`scope` text NOT NULL,
	`created_with_token` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`invite` integer DEFAULT false NOT NULL,
	CONSTRAINT "access_tokens_scope_check" CHECK("__new_access_tokens"."scope" IN ('read', 'report', 'event_runner', 'admin')),
	CONSTRAINT "access_tokens_invite_check" CHECK("__new_access_tokens"."invite" IN (0, 1) AND ("__new_access_tokens"."invite" = 0 OR "__new_access_tokens"."scope" = 'event_runner'))
);
--> statement-breakpoint
INSERT INTO `__new_access_tokens`("token_hash", "label", "scope", "created_with_token", "created_at_ms") SELECT "token_hash", "label", "scope", "created_with_token", "created_at_ms" FROM `access_tokens`;--> statement-breakpoint
DROP TABLE `access_tokens`;--> statement-breakpoint
ALTER TABLE `__new_access_tokens` RENAME TO `access_tokens`;--> statement-breakpoint
PRAGMA foreign_keys=ON;