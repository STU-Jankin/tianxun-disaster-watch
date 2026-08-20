CREATE TABLE `task_revision_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`revision` integer NOT NULL,
	`owner` text NOT NULL,
	`actor` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`reason` text NOT NULL,
	`payload_json` text NOT NULL,
	`changed_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_revision_history_task_revision_uidx` ON `task_revision_history` (`task_id`,`revision`);
--> statement-breakpoint
CREATE INDEX `task_revision_history_owner_time_idx` ON `task_revision_history` (`owner`,`changed_at`);
