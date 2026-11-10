CREATE TABLE "profile_views" (
	"viewer_id" bigint NOT NULL,
	"viewed_id" bigint NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"last_viewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_views_viewer_id_viewed_id_pk" PRIMARY KEY("viewer_id","viewed_id")
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "reports_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"reporter_id" bigint NOT NULL,
	"profile_id" bigint NOT NULL,
	"reason" text,
	"comment" text,
	"locations" jsonb,
	"context" jsonb,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rightnow_posts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "rightnow_posts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"author_id" bigint NOT NULL,
	"status" text NOT NULL,
	"text" text,
	"hosting" boolean DEFAULT false NOT NULL,
	"share_location" text DEFAULT 'NONE' NOT NULL,
	"location_radius" integer,
	"offset_east" double precision DEFAULT 0 NOT NULL,
	"offset_north" double precision DEFAULT 0 NOT NULL,
	"anchor" geography(Point, 4326) NOT NULL,
	"is_discreet" text DEFAULT 'NOT_SELECTED' NOT NULL,
	"shared_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"media_ids" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
	"posted" timestamp with time zone,
	"expiration" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rightnow_requests" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "rightnow_requests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"post_id" bigint NOT NULL,
	"sender_id" bigint NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "taps" (
	"sender_id" bigint NOT NULL,
	"recipient_id" bigint NOT NULL,
	"tap_type" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "taps_sender_id_recipient_id_pk" PRIMARY KEY("sender_id","recipient_id")
);
--> statement-breakpoint
ALTER TABLE "profile_views" ADD CONSTRAINT "profile_views_viewer_id_users_id_fk" FOREIGN KEY ("viewer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_views" ADD CONSTRAINT "profile_views_viewed_id_users_id_fk" FOREIGN KEY ("viewed_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_profile_id_users_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rightnow_posts" ADD CONSTRAINT "rightnow_posts_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rightnow_requests" ADD CONSTRAINT "rightnow_requests_post_id_rightnow_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."rightnow_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rightnow_requests" ADD CONSTRAINT "rightnow_requests_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taps" ADD CONSTRAINT "taps_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taps" ADD CONSTRAINT "taps_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "profile_views_viewed_idx" ON "profile_views" USING btree ("viewed_id","last_viewed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "reports_reporter_profile_uq" ON "reports" USING btree ("reporter_id","profile_id");--> statement-breakpoint
CREATE INDEX "reports_status_idx" ON "reports" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "rightnow_posts_anchor_gist" ON "rightnow_posts" USING gist ("anchor") WHERE "rightnow_posts"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "rightnow_posts_expiration_idx" ON "rightnow_posts" USING btree ("expiration") WHERE "rightnow_posts"."status" IN ('ACTIVE', 'HIDDEN');--> statement-breakpoint
CREATE INDEX "rightnow_posts_author_idx" ON "rightnow_posts" USING btree ("author_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "rightnow_requests_post_sender_uq" ON "rightnow_requests" USING btree ("post_id","sender_id");--> statement-breakpoint
CREATE INDEX "rightnow_requests_sender_idx" ON "rightnow_requests" USING btree ("sender_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "taps_recipient_idx" ON "taps" USING btree ("recipient_id","created_at" DESC NULLS LAST);