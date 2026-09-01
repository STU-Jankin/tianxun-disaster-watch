CREATE TABLE `regional_landslide_forecast_cells` (
	`snapshot_id` text PRIMARY KEY NOT NULL,
	`cycle_at` text NOT NULL,
	`model_version` text NOT NULL,
	`region_id` text NOT NULL,
	`cell_id` text NOT NULL,
	`cell_mode` text NOT NULL,
	`parent_cell_id` text,
	`lead_hours` integer NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text NOT NULL,
	`trigger_level` text NOT NULL,
	`screening_index` integer,
	`latitude` real NOT NULL,
	`longitude` real NOT NULL,
	`radius_km` real NOT NULL,
	`geometry_json` text,
	`inputs_json` text NOT NULL,
	`land_cover_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `regional_landslide_cycle_cell_lead_uidx` ON `regional_landslide_forecast_cells` (`cycle_at`,`cell_id`,`lead_hours`);
--> statement-breakpoint
CREATE INDEX `regional_landslide_region_time_idx` ON `regional_landslide_forecast_cells` (`region_id`,`cycle_at`);
--> statement-breakpoint
CREATE INDEX `regional_landslide_validity_idx` ON `regional_landslide_forecast_cells` (`valid_from`,`valid_to`);
