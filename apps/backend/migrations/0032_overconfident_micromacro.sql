CREATE TABLE `archive_lease` (
	`id` integer PRIMARY KEY NOT NULL,
	`holder` text,
	`fence` integer NOT NULL,
	`expires_at_ms` integer NOT NULL,
	CONSTRAINT "archive_lease_single_row_check" CHECK("archive_lease"."id" = 1)
);
INSERT INTO `archive_lease` (`id`, `holder`, `fence`, `expires_at_ms`) VALUES (1, NULL, 0, 0);
