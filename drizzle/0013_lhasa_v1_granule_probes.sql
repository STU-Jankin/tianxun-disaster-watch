CREATE TABLE `lhasa_v1_granule_probes` (
	`case_id` text PRIMARY KEY NOT NULL,
	`product_date` text NOT NULL,
	`status` text NOT NULL,
	`collection_concept_id` text NOT NULL,
	`granule_concept_id` text,
	`producer_granule_id` text,
	`download_url` text,
	`granule_size_mb` real,
	`time_start` text,
	`time_end` text,
	`message` text NOT NULL,
	`checked_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `lhasa_v1_granule_probes_status_date_idx` ON `lhasa_v1_granule_probes` (`status`,`product_date`);
