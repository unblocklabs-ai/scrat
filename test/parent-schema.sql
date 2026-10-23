CREATE TABLE `events` (
	`id` integer PRIMARY KEY,
	`created_at` text NOT NULL,
	`type` text NOT NULL,
	`operation_id` text,
	`item_id` text,
	`task_id` text,
	`run_id` text,
	`data` text NOT NULL,
	CONSTRAINT `fk_events_item_id_items_id_fk` FOREIGN KEY (`item_id`) REFERENCES `items`(`id`),
	CONSTRAINT `fk_events_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`),
	CONSTRAINT `fk_events_run_id_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`)
);
CREATE TABLE `items` (
	`id` text PRIMARY KEY,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`kind` text NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`workspace_id` text,
	`self_repair_count` integer DEFAULT 0 NOT NULL,
	`payload` text NOT NULL,
	CONSTRAINT `fk_items_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`),
	CONSTRAINT `items_source_external_id_unique` UNIQUE(`source`,`external_id`)
);
CREATE TABLE `runs` (
	`id` text PRIMARY KEY,
	`task_id` text NOT NULL,
	`sequence` integer,
	`retry_of_run_id` text,
	`inference_from_run_id` text,
	`input` text DEFAULT '{}' NOT NULL,
	`context` text,
	`skill` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`thinking_level` text NOT NULL,
	`pi_session_id` text,
	`pi_session_file` text,
	`workspace_id` text,
	`main_sha` text,
	`head_sha` text,
	`stage` text DEFAULT 'preparing' NOT NULL,
	`started_at` text,
	`finished_at` text,
	`reviewers` text DEFAULT '[]' NOT NULL,
	`agent_checkpoint` text,
	`verification` text,
	`result` text,
	`error` text,
	`publication` text NOT NULL,
	CONSTRAINT `fk_runs_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`),
	CONSTRAINT `fk_runs_retry_of_run_id_runs_id_fk` FOREIGN KEY (`retry_of_run_id`) REFERENCES `runs`(`id`),
	CONSTRAINT `fk_runs_inference_from_run_id_runs_id_fk` FOREIGN KEY (`inference_from_run_id`) REFERENCES `runs`(`id`),
	CONSTRAINT `fk_runs_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`)
);
CREATE TABLE `slack_threads` (
	`item_id` text NOT NULL UNIQUE,
	`channel` text NOT NULL,
	`ts` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_slack_threads_item_id_items_id_fk` FOREIGN KEY (`item_id`) REFERENCES `items`(`id`)
);
CREATE TABLE `source_cursors` (
	`repository` text NOT NULL,
	`action` text NOT NULL,
	`branch` text NOT NULL,
	`sha` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `source_cursors_pk` PRIMARY KEY(`repository`, `action`, `branch`)
);
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY,
	`item_id` text NOT NULL,
	`action` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`reason` text NOT NULL,
	`input` text NOT NULL,
	`retry_mode` text DEFAULT 'repair' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_tasks_item_id_items_id_fk` FOREIGN KEY (`item_id`) REFERENCES `items`(`id`)
);
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY,
	`repository_path` text NOT NULL,
	`branch` text NOT NULL,
	`path` text NOT NULL UNIQUE,
	`base_ref` text NOT NULL,
	`base_sha` text NOT NULL,
	`created_at` text NOT NULL,
	`removed_at` text
);
CREATE UNIQUE INDEX `runs_sequence_unique` ON `runs` (`sequence`);
CREATE UNIQUE INDEX `tasks_queued_item_action_unique` ON `tasks` (`item_id`,`action`) WHERE "tasks"."status" = 'queued';
