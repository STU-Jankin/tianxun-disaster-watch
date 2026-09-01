ALTER TABLE `evaluation_benchmark_cases` ADD `objective` text DEFAULT 'event_detection' NOT NULL;
--> statement-breakpoint
ALTER TABLE `evaluation_benchmark_cases` ADD `hazard_subtype` text;
--> statement-breakpoint
ALTER TABLE `evaluation_benchmark_cases` ADD `minimum_forecast_risk_percent` real;
