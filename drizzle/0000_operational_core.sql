CREATE TABLE `canonical_events` (
	`id` text PRIMARY KEY NOT NULL,
	`hazard` text NOT NULL,
	`title` text NOT NULL,
	`lifecycle_status` text NOT NULL,
	`severity` text NOT NULL,
	`geometry_type` text NOT NULL,
	`latitude` real NOT NULL,
	`longitude` real NOT NULL,
	`location_quality` text NOT NULL,
	`location_accuracy_km` real NOT NULL,
	`confidence_score` integer NOT NULL,
	`occurred_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`observation_expires_at` text NOT NULL,
	`payload_json` text NOT NULL,
	`synced_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `canonical_events_hazard_status_idx` ON `canonical_events` (`hazard`,`lifecycle_status`);
--> statement-breakpoint
CREATE INDEX `canonical_events_updated_idx` ON `canonical_events` (`updated_at`);
--> statement-breakpoint
CREATE TABLE `event_evidence` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`master_event_id` text NOT NULL,
	`source` text NOT NULL,
	`source_url` text NOT NULL,
	`source_event_id` text NOT NULL,
	`observed_at` text NOT NULL,
	`role` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_evidence_source_event_uidx` ON `event_evidence` (`master_event_id`,`source`,`source_event_id`);
--> statement-breakpoint
CREATE INDEX `event_evidence_master_idx` ON `event_evidence` (`master_event_id`);
--> statement-breakpoint
CREATE TABLE `satellite_tasks` (
	`task_id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`master_event_id` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`priority` integer NOT NULL,
	`latitude` real NOT NULL,
	`longitude` real NOT NULL,
	`aoi_type` text NOT NULL,
	`aoi_json` text NOT NULL,
	`sensors_json` text NOT NULL,
	`imaging_start` text NOT NULL,
	`imaging_end` text NOT NULL,
	`aoi_approval` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`event_revision` text DEFAULT '' NOT NULL,
	`aoi_hash` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `satellite_tasks_status_priority_idx` ON `satellite_tasks` (`status`,`priority`);
--> statement-breakpoint
CREATE INDEX `satellite_tasks_event_idx` ON `satellite_tasks` (`master_event_id`);
--> statement-breakpoint
CREATE TABLE `task_status_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`changed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `task_status_history_task_idx` ON `task_status_history` (`task_id`,`changed_at`);
--> statement-breakpoint
CREATE TRIGGER `satellite_tasks_history_insert` AFTER INSERT ON `satellite_tasks` BEGIN INSERT INTO `task_status_history` (`task_id`,`from_status`,`to_status`,`note`) VALUES (NEW.`task_id`,NULL,NEW.`status`,'task created'); END;
--> statement-breakpoint
CREATE TRIGGER `satellite_tasks_history_update` AFTER UPDATE OF `status` ON `satellite_tasks` WHEN OLD.`status` != NEW.`status` BEGIN INSERT INTO `task_status_history` (`task_id`,`from_status`,`to_status`,`note`) VALUES (NEW.`task_id`,OLD.`status`,NEW.`status`,'status changed'); END;
--> statement-breakpoint
CREATE TABLE `event_tombstones` (
	`source` text NOT NULL,
	`source_event_id` text NOT NULL,
	`reason` text NOT NULL,
	`resolved_at` text NOT NULL,
	PRIMARY KEY(`source`,`source_event_id`)
);
--> statement-breakpoint
CREATE TABLE `event_source_claims` (
	`source` text NOT NULL,
	`source_event_id` text NOT NULL,
	`master_event_id` text NOT NULL,
	`hazard` text NOT NULL,
	`claimed_at` text NOT NULL,
	PRIMARY KEY(`source`,`source_event_id`)
);
--> statement-breakpoint
CREATE TABLE `event_quarantine` (
	`master_event_id` text PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`payload_json` text NOT NULL,
	`quarantined_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `operational_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`change_type` text NOT NULL,
	`master_event_id` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `operational_changes_created_idx` ON `operational_changes` (`created_at`,`id`);
