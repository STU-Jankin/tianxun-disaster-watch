ALTER TABLE `satellite_tasks` ADD `owner` text DEFAULT 'legacy' NOT NULL;
--> statement-breakpoint
ALTER TABLE `task_cancellation_intents` ADD `owner` text DEFAULT 'legacy' NOT NULL;
--> statement-breakpoint
CREATE INDEX `satellite_tasks_owner_status_idx` ON `satellite_tasks` (`owner`,`status`);
--> statement-breakpoint
CREATE INDEX `task_cancellation_intents_owner_time_idx` ON `task_cancellation_intents` (`owner`,`cancelled_at`);
