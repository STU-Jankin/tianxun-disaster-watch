ALTER TABLE `evaluation_benchmark_cases` ADD `outcome` text DEFAULT 'event' NOT NULL;
--> statement-breakpoint
ALTER TABLE `evaluation_benchmark_cases` ADD `calibration_group` text;
--> statement-breakpoint
CREATE TABLE `forecast_raster_products` (
	`product_id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`product_time` text NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text NOT NULL,
	`source_url` text NOT NULL,
	`payload_sha256` text NOT NULL,
	`storage_key` text NOT NULL,
	`storage_backend` text NOT NULL,
	`content_type` text NOT NULL,
	`byte_length` integer NOT NULL,
	`source_width` integer NOT NULL,
	`source_height` integer NOT NULL,
	`group_pixels` integer NOT NULL,
	`grid_width` integer NOT NULL,
	`grid_height` integer NOT NULL,
	`summary_json` text NOT NULL,
	`archived_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forecast_raster_products_source_time_uidx` ON `forecast_raster_products` (`source_id`,`product_time`);
--> statement-breakpoint
CREATE INDEX `forecast_raster_products_time_idx` ON `forecast_raster_products` (`product_time`,`source_id`);
