CREATE TABLE `task_cancellation_intents` (
	`task_id` text PRIMARY KEY NOT NULL,
	`cancelled_at` text NOT NULL,
	`actor` text NOT NULL,
	`reason` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `task_cancellation_intents_time_idx` ON `task_cancellation_intents` (`cancelled_at`);
--> statement-breakpoint
CREATE TABLE `task_export_packages` (
	`package_id` text PRIMARY KEY NOT NULL,
	`format` text NOT NULL,
	`task_ids_json` text NOT NULL,
	`payload_sha256` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `task_export_packages_created_idx` ON `task_export_packages` (`created_at`);
--> statement-breakpoint
CREATE TABLE `satellite_orbits` (
	`norad_id` integer PRIMARY KEY NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`last_attempt_at` text NOT NULL,
	`last_success_at` text,
	`last_error` text
);
--> statement-breakpoint
CREATE INDEX `satellite_orbits_success_idx` ON `satellite_orbits` (`last_success_at`);
