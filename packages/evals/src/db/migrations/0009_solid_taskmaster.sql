CREATE TABLE "artifacts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "artifacts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"attempt_id" integer NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"content_id" text NOT NULL,
	"kind" text NOT NULL,
	"digest" text NOT NULL,
	"media_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"access" text NOT NULL,
	"retention" text NOT NULL,
	"upload_state" text NOT NULL,
	"storage_key" text NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "eval_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"attempt_id" integer NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"sequence" integer NOT NULL,
	"timestamp" timestamp NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_digest" text NOT NULL,
	"redaction_version" text NOT NULL,
	"late" boolean DEFAULT false NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_definitions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "task_definitions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"identity" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"manifest" jsonb NOT NULL,
	"manifest_digest" text NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "task_definitions_identity_unique" UNIQUE("identity")
);
--> statement-breakpoint
CREATE TABLE "variants" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "variants_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"identity" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"manifest" jsonb NOT NULL,
	"manifest_digest" text NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "variants_identity_unique" UNIQUE("identity")
);
--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "evidence_status" text DEFAULT 'legacy_missing' NOT NULL;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "evidence_bundle_digest" text;--> statement-breakpoint
ALTER TABLE "trials" ADD COLUMN "task_definition_identity" text;--> statement-breakpoint
ALTER TABLE "trials" ADD COLUMN "variant_identity" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_events" ADD CONSTRAINT "eval_events_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_attempt_kind_digest_idx" ON "artifacts" USING btree ("attempt_id","kind","digest");--> statement-breakpoint
CREATE UNIQUE INDEX "eval_events_attempt_sequence_idx" ON "eval_events" USING btree ("attempt_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "task_definitions_digest_idx" ON "task_definitions" USING btree ("manifest_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "variants_digest_idx" ON "variants" USING btree ("manifest_digest");