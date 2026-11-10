CREATE TABLE "album_content" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "album_content_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"album_id" bigint NOT NULL,
	"media_hash" text NOT NULL,
	"position" integer NOT NULL,
	"is_fresh" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "album_content_views" (
	"album_id" bigint NOT NULL,
	"profile_id" bigint NOT NULL,
	"content_id" bigint NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "album_content_views_album_id_profile_id_content_id_pk" PRIMARY KEY("album_id","profile_id","content_id")
);
--> statement-breakpoint
CREATE TABLE "album_shares" (
	"album_id" bigint NOT NULL,
	"profile_id" bigint NOT NULL,
	"expiration_type" text DEFAULT 'INDEFINITE' NOT NULL,
	"shared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_viewed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"seen_version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "album_shares_album_id_profile_id_pk" PRIMARY KEY("album_id","profile_id")
);
--> statement-breakpoint
CREATE TABLE "albums" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "albums_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"owner_id" bigint NOT NULL,
	"name" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "album_content" ADD CONSTRAINT "album_content_album_id_albums_id_fk" FOREIGN KEY ("album_id") REFERENCES "public"."albums"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "album_content" ADD CONSTRAINT "album_content_media_hash_media_hash_fk" FOREIGN KEY ("media_hash") REFERENCES "public"."media"("hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "album_content_views" ADD CONSTRAINT "album_content_views_album_id_albums_id_fk" FOREIGN KEY ("album_id") REFERENCES "public"."albums"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "album_shares" ADD CONSTRAINT "album_shares_album_id_albums_id_fk" FOREIGN KEY ("album_id") REFERENCES "public"."albums"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "album_shares" ADD CONSTRAINT "album_shares_profile_id_users_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "albums" ADD CONSTRAINT "albums_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "album_content_album_media_uq" ON "album_content" USING btree ("album_id","media_hash");--> statement-breakpoint
CREATE INDEX "album_content_album_pos_idx" ON "album_content" USING btree ("album_id","position");--> statement-breakpoint
CREATE INDEX "album_shares_profile_idx" ON "album_shares" USING btree ("profile_id","shared_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "album_shares_expires_idx" ON "album_shares" USING btree ("expires_at") WHERE "album_shares"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "albums_owner_idx" ON "albums" USING btree ("owner_id","created_at");