CREATE TABLE "ban_appeals" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"ban_id" bigint,
	"source" text NOT NULL,
	"user_email" text,
	"user_device" text,
	"user_location" text,
	"country_code" text,
	"user_vpn" boolean,
	"description" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"decision_note" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_bans" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"user_id" bigint,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lifted_at" timestamp with time zone,
	"lifted_by" text
);
--> statement-breakpoint
CREATE TABLE "network_bans" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"cidr" "cidr" NOT NULL,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"lifted_at" timestamp with time zone,
	"lifted_by" text
);
--> statement-breakpoint
ALTER TABLE "ban_appeals" ADD CONSTRAINT "ban_appeals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ban_appeals" ADD CONSTRAINT "ban_appeals_ban_id_bans_id_fk" FOREIGN KEY ("ban_id") REFERENCES "public"."bans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_bans" ADD CONSTRAINT "device_bans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ban_appeals_status_idx" ON "ban_appeals" USING btree ("status","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ban_appeals_user_idx" ON "ban_appeals" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "device_bans_open_uq" ON "device_bans" USING btree ("device_id") WHERE "device_bans"."lifted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "network_bans_open_idx" ON "network_bans" USING gist ("cidr" inet_ops) WHERE "network_bans"."lifted_at" IS NULL;