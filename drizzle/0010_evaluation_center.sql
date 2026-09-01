CREATE TABLE `evaluation_benchmark_cases` (
	`case_id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`hazard` text NOT NULL,
	`occurred_at` text NOT NULL,
	`latitude` real NOT NULL,
	`longitude` real NOT NULL,
	`location_tolerance_km` real NOT NULL,
	`event_time_tolerance_hours` real NOT NULL,
	`accepted_lead_minutes` integer DEFAULT 0 NOT NULL,
	`detection_deadline_minutes` integer NOT NULL,
	`expected_severity` text,
	`required_source` text,
	`provenance_url` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`verification_status` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `evaluation_cases_hazard_time_idx` ON `evaluation_benchmark_cases` (`hazard`,`occurred_at`);
--> statement-breakpoint
CREATE INDEX `evaluation_cases_verification_time_idx` ON `evaluation_benchmark_cases` (`verification_status`,`occurred_at`);
--> statement-breakpoint
CREATE TABLE `evaluation_runs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`model_version` text NOT NULL,
	`case_count` integer NOT NULL,
	`eligible_count` integer NOT NULL,
	`detected_count` integer NOT NULL,
	`report_json` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `evaluation_runs_created_idx` ON `evaluation_runs` (`created_at`);
