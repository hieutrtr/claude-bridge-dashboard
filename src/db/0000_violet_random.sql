-- Current sql file was generated after introspecting the database
-- If you want to run this migration please uncomment this code before executing migrations
/*
CREATE TABLE `agents` (
	`name` text NOT NULL,
	`project_dir` text NOT NULL,
	`session_id` text NOT NULL,
	`agent_file` text NOT NULL,
	`purpose` text,
	`state` text DEFAULT 'created',
	`created_at` numeric DEFAULT (CURRENT_TIMESTAMP),
	`last_task_at` numeric,
	`total_tasks` integer DEFAULT 0,
	`model` text DEFAULT 'sonnet',
	PRIMARY KEY(`name`, `project_dir`)
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`session_id` text NOT NULL,
	`prompt` text NOT NULL,
	`status` text DEFAULT 'pending',
	`pid` integer,
	`result_file` text,
	`result_summary` text,
	`cost_usd` real,
	`duration_ms` integer,
	`num_turns` integer,
	`exit_code` integer,
	`error_message` text,
	`created_at` numeric DEFAULT (CURRENT_TIMESTAMP),
	`started_at` numeric,
	`completed_at` numeric,
	`reported` integer DEFAULT 0,
	`position` integer,
	`model` text,
	`task_type` text DEFAULT 'standard',
	`parent_task_id` integer,
	`channel` text DEFAULT 'cli',
	`channel_chat_id` text,
	`channel_message_id` text,
	`user_id` text DEFAULT (NULL),
	FOREIGN KEY (`parent_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `agents`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_tasks_parent` ON `tasks` (`parent_task_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_unreported` ON `tasks` (`status`,`reported`);--> statement-breakpoint
CREATE INDEX `idx_tasks_session` ON `tasks` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_status` ON `tasks` (`status`);--> statement-breakpoint
CREATE TABLE `permissions` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`command` text,
	`description` text,
	`status` text DEFAULT 'pending',
	`response` text,
	`created_at` numeric DEFAULT (CURRENT_TIMESTAMP),
	`responded_at` numeric,
	`timeout_seconds` integer DEFAULT 300
);
--> statement-breakpoint
CREATE INDEX `idx_permissions_status` ON `permissions` (`status`);--> statement-breakpoint
CREATE TABLE `teams` (
	`name` text PRIMARY KEY,
	`lead_agent` text NOT NULL,
	`created_at` numeric DEFAULT (CURRENT_TIMESTAMP)
);
--> statement-breakpoint
CREATE TABLE `team_members` (
	`team_name` text NOT NULL,
	`agent_name` text NOT NULL,
	PRIMARY KEY(`team_name`, `agent_name`),
	FOREIGN KEY (`team_name`) REFERENCES `teams`(`name`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`task_id` integer,
	`channel` text NOT NULL,
	`chat_id` text NOT NULL,
	`message` text NOT NULL,
	`status` text DEFAULT 'pending',
	`created_at` numeric DEFAULT (CURRENT_TIMESTAMP),
	`sent_at` numeric,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_notifications_status` ON `notifications` (`status`);--> statement-breakpoint
CREATE TABLE `loops` (
	`loop_id` text PRIMARY KEY,
	`agent` text NOT NULL,
	`project` text NOT NULL,
	`goal` text NOT NULL,
	`done_when` text NOT NULL,
	`loop_type` text DEFAULT 'bridge' NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`max_iterations` integer DEFAULT 10 NOT NULL,
	`max_consecutive_failures` integer DEFAULT 3 NOT NULL,
	`current_iteration` integer DEFAULT 0 NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`total_cost_usd` real DEFAULT 0 NOT NULL,
	`max_cost_usd` real,
	`pending_approval` integer DEFAULT 0 NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`finish_reason` text,
	`current_task_id` text,
	`channel` text,
	`channel_chat_id` text,
	`user_id` text,
	`plan` text,
	`plan_enabled` integer DEFAULT 0 NOT NULL,
	`pass_threshold` integer DEFAULT 1 NOT NULL,
	`consecutive_passes` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_loops_agent` ON `loops` (`agent`);--> statement-breakpoint
CREATE INDEX `idx_loops_status` ON `loops` (`status`);--> statement-breakpoint
CREATE TABLE `loop_iterations` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`loop_id` text NOT NULL,
	`iteration_num` integer NOT NULL,
	`task_id` text,
	`prompt` text,
	`result_summary` text,
	`done_check_passed` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`status` text DEFAULT 'running' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_loop_iterations_loop` ON `loop_iterations` (`loop_id`);--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`name` text NOT NULL,
	`agent_name` text NOT NULL,
	`prompt` text NOT NULL,
	`interval_minutes` integer,
	`cron_expr` text,
	`run_once` integer DEFAULT 0,
	`enabled` integer DEFAULT 1,
	`run_count` integer DEFAULT 0,
	`consecutive_errors` integer DEFAULT 0,
	`last_run_at` numeric,
	`next_run_at` numeric,
	`last_error` text,
	`channel` text DEFAULT 'cli',
	`channel_chat_id` text,
	`user_id` text,
	`created_at` numeric DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` numeric DEFAULT (CURRENT_TIMESTAMP)
);
--> statement-breakpoint
CREATE INDEX `idx_schedules_next_run` ON `schedules` (`next_run_at`,`enabled`);
*/