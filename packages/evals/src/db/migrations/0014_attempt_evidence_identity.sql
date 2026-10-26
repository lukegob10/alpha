ALTER TABLE "artifacts" ADD COLUMN "capture_status" text;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "task_definition_identity" text;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "variant_identity" text;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "evidence_manifest" jsonb;