CREATE TABLE `event_reviews` (
	`master_event_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`assignee` text DEFAULT '' NOT NULL,
	`conclusion` text DEFAULT '' NOT NULL,
	`exposure_index` integer,
	`exposure_basis` text,
	`vulnerability_index` integer,
	`vulnerability_basis` text,
	`alert_acknowledged_at` text,
	`alert_acknowledged_by` text,
	`alert_acknowledged_version` text,
	`event_revision` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `event_reviews_status_time_idx` ON `event_reviews` (`status`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `event_reviews_assignee_status_idx` ON `event_reviews` (`assignee`,`status`);
--> statement-breakpoint
CREATE TABLE `event_review_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`master_event_id` text NOT NULL,
	`revision` integer NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`payload_json` text NOT NULL,
	`changed_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_review_history_event_revision_uidx` ON `event_review_history` (`master_event_id`,`revision`);
--> statement-breakpoint
CREATE INDEX `event_review_history_event_time_idx` ON `event_review_history` (`master_event_id`,`changed_at`);
