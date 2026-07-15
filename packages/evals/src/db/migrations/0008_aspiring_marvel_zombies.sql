CREATE TABLE "graderResults" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "graderResults_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"attempt_id" integer NOT NULL,
	"grader_id" text NOT NULL,
	"grader_version" integer NOT NULL,
	"grader_type" text NOT NULL,
	"status" text NOT NULL,
	"hard_gate" boolean NOT NULL,
	"failure_class" text NOT NULL,
	"started_at" timestamp NOT NULL,
	"finished_at" timestamp NOT NULL,
	"duration_ms" integer NOT NULL,
	"diagnostics" jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"error" text,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "graderResults" ADD CONSTRAINT "graderResults_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "grader_results_attempt_identity_idx" ON "graderResults" USING btree ("attempt_id","grader_id","grader_version");