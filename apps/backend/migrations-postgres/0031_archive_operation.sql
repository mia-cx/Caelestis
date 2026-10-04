CREATE TABLE "archive_operation" (
	"id" bigint PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"operation_id" text NOT NULL,
	"started_at_ms" bigint NOT NULL,
	"position" bigint NOT NULL,
	"state_json" text NOT NULL,
	CONSTRAINT "archive_operation_single_row_check" CHECK("archive_operation"."id" = 1),
	CONSTRAINT "archive_operation_kind_check" CHECK("archive_operation"."kind" IN ('export', 'import'))
);
