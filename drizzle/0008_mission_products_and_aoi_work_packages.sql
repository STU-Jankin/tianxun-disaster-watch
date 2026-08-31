CREATE TABLE `mission_execution_receipts` (
	`receipt_id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`master_event_id` text NOT NULL,
	`owner` text NOT NULL,
	`provider` text NOT NULL,
	`external_task_id` text NOT NULL,
	`from_status` text NOT NULL,
	`to_status` text NOT NULL,
	`task_revision` integer NOT NULL,
	`occurred_at` text NOT NULL,
	`received_at` text NOT NULL,
	`actor` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`payload_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mission_execution_receipts_task_time_idx` ON `mission_execution_receipts` (`task_id`,`occurred_at`);
--> statement-breakpoint
CREATE INDEX `mission_execution_receipts_provider_external_idx` ON `mission_execution_receipts` (`provider`,`external_task_id`);
--> statement-breakpoint
CREATE TABLE `observation_products` (
	`item_id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`master_event_id` text NOT NULL,
	`owner` text NOT NULL,
	`collection_id` text NOT NULL,
	`product_level` text NOT NULL,
	`quality_status` text NOT NULL,
	`acquired_at` text NOT NULL,
	`geometry_json` text NOT NULL,
	`bbox_json` text NOT NULL,
	`stac_json` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `observation_products_task_time_idx` ON `observation_products` (`task_id`,`acquired_at`);
--> statement-breakpoint
CREATE INDEX `observation_products_event_time_idx` ON `observation_products` (`master_event_id`,`acquired_at`);
--> statement-breakpoint
CREATE INDEX `observation_products_owner_quality_idx` ON `observation_products` (`owner`,`quality_status`);
--> statement-breakpoint
CREATE TABLE `aoi_work_packages` (
	`package_id` text PRIMARY KEY NOT NULL,
	`master_event_id` text NOT NULL,
	`source_task_id` text NOT NULL,
	`owner` text NOT NULL,
	`title` text NOT NULL,
	`geometry_json` text NOT NULL,
	`aoi_hash` text NOT NULL,
	`status` text NOT NULL,
	`assignee` text DEFAULT '' NOT NULL,
	`reviewer` text DEFAULT '' NOT NULL,
	`priority` integer NOT NULL,
	`review_note` text DEFAULT '' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `aoi_work_packages_task_status_idx` ON `aoi_work_packages` (`source_task_id`,`status`);
--> statement-breakpoint
CREATE INDEX `aoi_work_packages_owner_status_idx` ON `aoi_work_packages` (`owner`,`status`);
--> statement-breakpoint
CREATE INDEX `aoi_work_packages_assignee_status_idx` ON `aoi_work_packages` (`assignee`,`status`);
--> statement-breakpoint
CREATE TABLE `aoi_work_package_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`package_id` text NOT NULL,
	`revision` integer NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`payload_json` text NOT NULL,
	`changed_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `aoi_work_package_history_revision_uidx` ON `aoi_work_package_history` (`package_id`,`revision`);
--> statement-breakpoint
CREATE INDEX `aoi_work_package_history_time_idx` ON `aoi_work_package_history` (`package_id`,`changed_at`);
