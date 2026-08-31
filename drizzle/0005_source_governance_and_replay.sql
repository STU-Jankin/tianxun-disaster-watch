CREATE TABLE `source_registry` (
	`source_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`tier` text NOT NULL,
	`role` text NOT NULL,
	`authority_class` text NOT NULL,
	`setup_url` text NOT NULL,
	`poll_interval_minutes` integer NOT NULL,
	`latency_slo_minutes` integer NOT NULL,
	`update_semantics` text NOT NULL,
	`geometry_semantics` text NOT NULL,
	`license_note` text NOT NULL,
	`state` text NOT NULL,
	`last_attempt_at` text NOT NULL,
	`last_success_at` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`last_duration_ms` integer DEFAULT 0 NOT NULL,
	`last_count` integer DEFAULT 0 NOT NULL,
	`last_message` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `source_registry_state_idx` ON `source_registry` (`state`,`last_attempt_at`);
--> statement-breakpoint
CREATE INDEX `source_registry_success_idx` ON `source_registry` (`last_success_at`);
--> statement-breakpoint
CREATE TABLE `source_payloads` (
	`payload_sha256` text PRIMARY KEY NOT NULL,
	`content_type` text NOT NULL,
	`body_text` text NOT NULL,
	`byte_length` integer NOT NULL,
	`stored_byte_length` integer NOT NULL,
	`truncated` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `source_fetch_runs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`refresh_id` text NOT NULL,
	`source_id` text NOT NULL,
	`requested_url` text NOT NULL,
	`fetched_at` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`http_status` integer,
	`ok` integer NOT NULL,
	`payload_sha256` text,
	`error_message` text
);
--> statement-breakpoint
CREATE INDEX `source_fetch_runs_source_time_idx` ON `source_fetch_runs` (`source_id`,`fetched_at`);
--> statement-breakpoint
CREATE INDEX `source_fetch_runs_refresh_idx` ON `source_fetch_runs` (`refresh_id`);
--> statement-breakpoint
CREATE TABLE `ingestion_snapshots` (
	`snapshot_id` text PRIMARY KEY NOT NULL,
	`refresh_id` text NOT NULL,
	`captured_at` text NOT NULL,
	`payload_sha256` text NOT NULL,
	`event_count` integer NOT NULL,
	`source_count` integer NOT NULL,
	`payload_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ingestion_snapshots_payload_idx` ON `ingestion_snapshots` (`payload_sha256`);
--> statement-breakpoint
CREATE INDEX `ingestion_snapshots_captured_idx` ON `ingestion_snapshots` (`captured_at`);
