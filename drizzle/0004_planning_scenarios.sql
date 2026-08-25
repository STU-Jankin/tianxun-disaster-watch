CREATE TABLE `planning_scenarios` (
	`scenario_id` text PRIMARY KEY NOT NULL,
	`series_id` text NOT NULL,
	`version` integer NOT NULL,
	`parent_scenario_id` text,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`problem_fingerprint` text NOT NULL,
	`objective_score` integer NOT NULL,
	`assignment_count` integer NOT NULL,
	`conditional_assignment_count` integer NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `planning_scenarios_series_version_uidx` ON `planning_scenarios` (`series_id`,`version`);
--> statement-breakpoint
CREATE INDEX `planning_scenarios_owner_time_idx` ON `planning_scenarios` (`owner`,`created_at`);
