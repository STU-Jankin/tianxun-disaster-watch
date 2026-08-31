CREATE TABLE `osm_query_cache` (
	`cache_key` text PRIMARY KEY NOT NULL,
	`query_kind` text NOT NULL,
	`data_profile` text NOT NULL,
	`payload_json` text NOT NULL,
	`fetched_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`osm_base_timestamp` text
);
--> statement-breakpoint
CREATE INDEX `osm_query_cache_kind_profile_idx` ON `osm_query_cache` (`query_kind`,`data_profile`,`fetched_at`);
--> statement-breakpoint
CREATE INDEX `osm_query_cache_expiry_idx` ON `osm_query_cache` (`expires_at`);
