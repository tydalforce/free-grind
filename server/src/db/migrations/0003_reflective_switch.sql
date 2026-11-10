CREATE TABLE "bans" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"type" text NOT NULL,
	"reason" text,
	"sub_reason" text,
	"automated" boolean DEFAULT false NOT NULL,
	"require_agreement" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp with time zone,
	"agreement_completed_at" timestamp with time zone,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lifted_at" timestamp with time zone,
	"lifted_by" text
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "banned_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bans" ADD CONSTRAINT "bans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bans_user_open_idx" ON "bans" USING btree ("user_id","created_at" DESC NULLS LAST) WHERE "bans"."lifted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "bans_expires_idx" ON "bans" USING btree ("expires_at") WHERE "bans"."lifted_at" IS NULL AND "bans"."type" = 'timed';