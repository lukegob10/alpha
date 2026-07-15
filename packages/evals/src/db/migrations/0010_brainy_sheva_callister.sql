CREATE TABLE "baselines" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "baselines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"identity" text NOT NULL,
	"variant_identity" text NOT NULL,
	"task_set_identity" text NOT NULL,
	"report_digest" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "baselines_identity_unique" UNIQUE("identity")
);
--> statement-breakpoint
CREATE TABLE "experiment_pairs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "experiment_pairs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"experiment_id" integer NOT NULL,
	"pair_key" jsonb NOT NULL,
	"pair_digest" text NOT NULL,
	"control_trial_id" integer,
	"candidate_trial_id" integer,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experiment_reports" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "experiment_reports_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"experiment_id" integer NOT NULL,
	"report" jsonb NOT NULL,
	"digest" text NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "experiment_reports_experiment_id_unique" UNIQUE("experiment_id")
);
--> statement-breakpoint
CREATE TABLE "experiment_task_sets" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "experiment_task_sets_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"identity" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"digest" text NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "experiment_task_sets_identity_unique" UNIQUE("identity")
);
--> statement-breakpoint
CREATE TABLE "experiment_variants" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "experiment_variants_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"identity" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"digest" text NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "experiment_variants_identity_unique" UNIQUE("identity")
);
--> statement-breakpoint
CREATE TABLE "experiments" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "experiments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"identity" text NOT NULL,
	"template" text NOT NULL,
	"task_set_identity" text NOT NULL,
	"control_variant_identity" text NOT NULL,
	"candidate_variant_identity" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"digest" text NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "experiments_identity_unique" UNIQUE("identity")
);
--> statement-breakpoint
CREATE TABLE "promotions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "promotions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"baseline_identity" text NOT NULL,
	"rollback_baseline_identity" text NOT NULL,
	"experiment_identity" text NOT NULL,
	"policy_id" text NOT NULL,
	"reviewer" text NOT NULL,
	"rationale" text NOT NULL,
	"decision" text NOT NULL,
	"reasons" jsonb NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "experiment_pairs" ADD CONSTRAINT "experiment_pairs_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_pairs" ADD CONSTRAINT "experiment_pairs_control_trial_id_trials_id_fk" FOREIGN KEY ("control_trial_id") REFERENCES "public"."trials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_pairs" ADD CONSTRAINT "experiment_pairs_candidate_trial_id_trials_id_fk" FOREIGN KEY ("candidate_trial_id") REFERENCES "public"."trials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_reports" ADD CONSTRAINT "experiment_reports_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "experiment_pairs_identity_idx" ON "experiment_pairs" USING btree ("experiment_id","pair_digest");
--> statement-breakpoint
CREATE FUNCTION prevent_eval_governance_mutation() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'eval governance records are append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER experiment_task_sets_immutable BEFORE UPDATE OR DELETE ON "experiment_task_sets" FOR EACH ROW EXECUTE FUNCTION prevent_eval_governance_mutation();
--> statement-breakpoint
CREATE TRIGGER experiment_variants_immutable BEFORE UPDATE OR DELETE ON "experiment_variants" FOR EACH ROW EXECUTE FUNCTION prevent_eval_governance_mutation();
--> statement-breakpoint
CREATE TRIGGER experiments_immutable BEFORE UPDATE OR DELETE ON "experiments" FOR EACH ROW EXECUTE FUNCTION prevent_eval_governance_mutation();
--> statement-breakpoint
CREATE TRIGGER experiment_pairs_immutable BEFORE UPDATE OR DELETE ON "experiment_pairs" FOR EACH ROW EXECUTE FUNCTION prevent_eval_governance_mutation();
--> statement-breakpoint
CREATE TRIGGER experiment_reports_immutable BEFORE UPDATE OR DELETE ON "experiment_reports" FOR EACH ROW EXECUTE FUNCTION prevent_eval_governance_mutation();
--> statement-breakpoint
CREATE TRIGGER baselines_immutable BEFORE UPDATE OR DELETE ON "baselines" FOR EACH ROW EXECUTE FUNCTION prevent_eval_governance_mutation();
--> statement-breakpoint
CREATE TRIGGER promotions_immutable BEFORE UPDATE OR DELETE ON "promotions" FOR EACH ROW EXECUTE FUNCTION prevent_eval_governance_mutation();
