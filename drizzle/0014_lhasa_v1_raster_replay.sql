ALTER TABLE `lhasa_v1_granule_probes` ADD `read_status` text DEFAULT 'not_started' NOT NULL;
--> statement-breakpoint
ALTER TABLE `lhasa_v1_granule_probes` ADD `storage_key` text;
--> statement-breakpoint
ALTER TABLE `lhasa_v1_granule_probes` ADD `storage_backend` text;
--> statement-breakpoint
ALTER TABLE `lhasa_v1_granule_probes` ADD `payload_sha256` text;
--> statement-breakpoint
ALTER TABLE `lhasa_v1_granule_probes` ADD `byte_length` integer;
--> statement-breakpoint
ALTER TABLE `lhasa_v1_granule_probes` ADD `read_json` text;
--> statement-breakpoint
ALTER TABLE `lhasa_v1_granule_probes` ADD `read_message` text;
--> statement-breakpoint
ALTER TABLE `lhasa_v1_granule_probes` ADD `read_at` text;
