CREATE TABLE `event_exposure_assessments` (
	`master_event_id` text PRIMARY KEY NOT NULL,
	`event_revision` text NOT NULL,
	`aoi_hash` text NOT NULL,
	`status` text NOT NULL,
	`payload_json` text NOT NULL,
	`computed_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`updated_by` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `event_exposure_assessments_expiry_idx` ON `event_exposure_assessments` (`expires_at`,`computed_at`);
--> statement-breakpoint
CREATE INDEX `event_exposure_assessments_status_idx` ON `event_exposure_assessments` (`status`,`computed_at`);
