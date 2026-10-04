CREATE TABLE "archive_operation" (
	"id" bigint PRIMARY KEY NOT NULL,
	"kind" varchar(16) NOT NULL,
	"operation_id" varchar(64) NOT NULL,
	"started_at_ms" bigint NOT NULL,
	"position" bigint NOT NULL,
	"state_json" longtext NOT NULL,
	CONSTRAINT "archive_operation_single_row_check" CHECK("archive_operation"."id" = 1),
	CONSTRAINT "archive_operation_kind_check" CHECK("archive_operation"."kind" IN ('export', 'import'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;
