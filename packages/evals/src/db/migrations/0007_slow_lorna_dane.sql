CREATE TABLE "attempts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "attempts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"trial_id" integer NOT NULL,
	"attempt_number" integer NOT NULL,
	"phase" text DEFAULT 'created' NOT NULL,
	"terminal_status" text,
	"failure_code" text,
	"failure_detail" text,
	"version" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trials" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "trials_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"task_id" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"first_attempt_status" text,
	"retry_assisted" boolean DEFAULT false NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "trials_task_id_unique" UNIQUE("task_id")
);
--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_trial_id_trials_id_fk" FOREIGN KEY ("trial_id") REFERENCES "public"."trials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trials" ADD CONSTRAINT "trials_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attempts_trial_attempt_number_idx" ON "attempts" USING btree ("trial_id","attempt_number");