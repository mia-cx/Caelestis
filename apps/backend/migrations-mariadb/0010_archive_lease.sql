CREATE TABLE "archive_lease" (
	"id" bigint PRIMARY KEY NOT NULL,
	"holder" varchar(64),
	"fence" bigint NOT NULL,
	"expires_at_ms" bigint NOT NULL,
	CONSTRAINT "archive_lease_single_row_check" CHECK("archive_lease"."id" = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;
INSERT INTO "archive_lease" ("id", "holder", "fence", "expires_at_ms") VALUES (1, NULL, 0, 0);
