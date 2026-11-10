CREATE TABLE "blocks" (
	"owner_id" bigint NOT NULL,
	"target_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blocks_owner_id_target_id_pk" PRIMARY KEY("owner_id","target_id")
);
--> statement-breakpoint
CREATE TABLE "favorites" (
	"owner_id" bigint NOT NULL,
	"target_id" bigint NOT NULL,
	"notes" text,
	"phone_number" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "favorites_owner_id_target_id_pk" PRIMARY KEY("owner_id","target_id")
);
--> statement-breakpoint
CREATE TABLE "hides" (
	"owner_id" bigint NOT NULL,
	"target_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hides_owner_id_target_id_pk" PRIMARY KEY("owner_id","target_id")
);
--> statement-breakpoint
CREATE TABLE "media" (
	"hash" text PRIMARY KEY NOT NULL,
	"owner_id" bigint NOT NULL,
	"media_id" bigint GENERATED ALWAYS AS IDENTITY (sequence name "media_media_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"purpose" text NOT NULL,
	"state" text DEFAULT 'processing' NOT NULL,
	"mime" text NOT NULL,
	"bytes" bigint NOT NULL,
	"width" integer,
	"height" integer,
	"duration_ms" integer,
	"poster_hash" text,
	"thumb_coords" jsonb,
	"taken_on_grindr" boolean DEFAULT false NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "profile_media" (
	"user_id" bigint NOT NULL,
	"media_hash" text NOT NULL,
	"position" smallint NOT NULL,
	CONSTRAINT "profile_media_user_id_media_hash_pk" PRIMARY KEY("user_id","media_hash")
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "show_age" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "show_distance" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "show_position" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "show_tribes" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "nsfw" smallint;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "body_type" smallint;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "ethnicity" smallint;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "hiv_status" smallint;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "last_tested_date" bigint;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "relationship_status" smallint;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "sexual_position" smallint;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "genders" smallint[] DEFAULT '{}'::smallint[] NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "pronouns" smallint[] DEFAULT '{}'::smallint[] NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "tribes" smallint[] DEFAULT '{}'::smallint[] NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "tribes_im_into" smallint[] DEFAULT '{}'::smallint[] NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "looking_for" smallint[] DEFAULT '{}'::smallint[] NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "meet_at" smallint[] DEFAULT '{}'::smallint[] NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "vaccines" smallint[] DEFAULT '{}'::smallint[] NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "sexual_health" smallint[] DEFAULT '{}'::smallint[] NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "profile_tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "primary_media_hash" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "has_face" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "fuzz_cell" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "fuzz_rolled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "online_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "hide_viewed_me" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "location_search_opt_out" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "view_right_now_nsfw" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "prep_reminder_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "prep_reminder_time" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_target_id_users_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_target_id_users_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hides" ADD CONSTRAINT "hides_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hides" ADD CONSTRAINT "hides_target_id_users_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_media" ADD CONSTRAINT "profile_media_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_media" ADD CONSTRAINT "profile_media_media_hash_media_hash_fk" FOREIGN KEY ("media_hash") REFERENCES "public"."media"("hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blocks_target_idx" ON "blocks" USING btree ("target_id","owner_id");--> statement-breakpoint
CREATE INDEX "favorites_target_idx" ON "favorites" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "media_owner_created_idx" ON "media" USING btree ("owner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "media_processing_idx" ON "media" USING btree ("created_at") WHERE "media"."state" = 'processing';--> statement-breakpoint
CREATE INDEX "media_media_id_idx" ON "media" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "profile_media_user_pos_idx" ON "profile_media" USING btree ("user_id","position");--> statement-breakpoint
CREATE INDEX "profiles_online_until_idx" ON "profiles" USING btree ("online_until" DESC NULLS LAST) WHERE "profiles"."incognito" = false;--> statement-breakpoint
CREATE INDEX "profiles_tribes_gin" ON "profiles" USING gin ("tribes");--> statement-breakpoint
CREATE INDEX "profiles_looking_for_gin" ON "profiles" USING gin ("looking_for");--> statement-breakpoint
CREATE INDEX "profiles_genders_gin" ON "profiles" USING gin ("genders");--> statement-breakpoint
CREATE INDEX "profiles_tags_gin" ON "profiles" USING gin ("profile_tags");