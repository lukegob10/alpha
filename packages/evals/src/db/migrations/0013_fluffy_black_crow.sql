ALTER TABLE "runs" ADD COLUMN "campaign_tier" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "campaign_hard_cap_usd" real;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "task_cost_cap_usd" real;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "estimated_cost_usd" real;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "high_cost_approved" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "model_fallback_allowed" boolean DEFAULT false NOT NULL;