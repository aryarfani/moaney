CREATE TABLE `bills` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`amount` integer NOT NULL,
	`wallet_id` integer NOT NULL,
	`category_id` integer NOT NULL,
	`next_due` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`wallet_id`) REFERENCES `wallets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `capture_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`app` text NOT NULL,
	`label` text NOT NULL,
	`wallet_id` integer,
	`has_parser` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`wallet_id`) REFERENCES `wallets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `capture_sources_app_unique` ON `capture_sources` (`app`);--> statement-breakpoint
CREATE TABLE `devices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`last_seen_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_token_hash_unique` ON `devices` (`token_hash`);--> statement-breakpoint
CREATE TABLE `goals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`target` integer NOT NULL,
	`saved` integer DEFAULT 0 NOT NULL,
	`wallet_id` integer,
	`due_date` text,
	`archived` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`wallet_id`) REFERENCES `wallets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `holding_trades` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`holding_id` integer NOT NULL,
	`kind` text NOT NULL,
	`date` text NOT NULL,
	`units_e4` integer DEFAULT 0 NOT NULL,
	`amount` integer NOT NULL,
	FOREIGN KEY (`holding_id`) REFERENCES `holdings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `holdings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`kind` text NOT NULL,
	`unit_label` text DEFAULT 'units' NOT NULL,
	`units_e4` integer DEFAULT 0 NOT NULL,
	`cost` integer DEFAULT 0 NOT NULL,
	`price` integer,
	`price_date` text,
	`income_ytd` integer DEFAULT 0 NOT NULL,
	`note` text,
	`archived` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `holdings_symbol_unique` ON `holdings` (`symbol`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`app` text NOT NULL,
	`text` text NOT NULL,
	`received_at` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`kind` text,
	`direction` text,
	`amount` integer,
	`counterpart` text,
	`wallet_id` integer,
	`category_id` integer,
	`pair_id` integer,
	`bill_id` integer,
	`transaction_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notif_status_idx` ON `notifications` (`status`);--> statement-breakpoint
CREATE TABLE `rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pattern` text NOT NULL,
	`category_id` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`chosen` integer DEFAULT 0 NOT NULL,
	`uses` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rules_pattern_unique` ON `rules` (`pattern`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
