CREATE TABLE "legal_acceptances" (
	"user_id" bigint PRIMARY KEY NOT NULL,
	"terms_version" text,
	"terms_accepted_at" timestamp with time zone,
	"privacy_version" text,
	"privacy_accepted_at" timestamp with time zone,
	"consents" text[] DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_warnings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"warning" text NOT NULL,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "visiting_mode" text DEFAULT 'AUTO' NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "home_location" geography(Point, 4326);--> statement-breakpoint
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_warnings" ADD CONSTRAINT "user_warnings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_warnings_open_idx" ON "user_warnings" USING btree ("user_id","acknowledged_at");