CREATE TABLE "auth_tokens" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"family_id" uuid NOT NULL,
	"user_id" bigint NOT NULL,
	"device_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_keys" (
	"key_id" text PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"device_id" text NOT NULL,
	"public_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"user_id" bigint NOT NULL,
	"device_id" text NOT NULL,
	"user_agent" text,
	"fcm_token" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_user_id_device_id_pk" PRIMARY KEY("user_id","device_id")
);
--> statement-breakpoint
CREATE TABLE "jwt_keys" (
	"kid" text PRIMARY KEY NOT NULL,
	"private_jwk" text NOT NULL,
	"public_jwk" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "third_party_identities" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"provider" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"prefixed_id" text NOT NULL,
	"email" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"email" text,
	"email_verified_at" timestamp with time zone,
	"password_hash" text,
	"birthday" timestamp with time zone NOT NULL,
	"opt_in" boolean DEFAULT false NOT NULL,
	"token_version" integer DEFAULT 0 NOT NULL,
	"location_seed" text DEFAULT encode(gen_random_bytes(32), 'hex') NOT NULL,
	"banned_at" timestamp with time zone,
	"ban_reason" text,
	"ban_sub_reason" text,
	"ban_expires_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target" text,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entitlement_profiles" (
	"profile" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlement_profiles_profile_key_pk" PRIMARY KEY("profile","key")
);
--> statement-breakpoint
CREATE TABLE "entitlement_usage" (
	"user_id" bigint NOT NULL,
	"key" text NOT NULL,
	"window" text NOT NULL,
	"used" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlement_usage_user_id_key_window_pk" PRIMARY KEY("user_id","key","window")
);
--> statement-breakpoint
CREATE TABLE "entitlement_user_overrides" (
	"user_id" bigint NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlement_user_overrides_user_id_key_pk" PRIMARY KEY("user_id","key")
);
--> statement-breakpoint
CREATE TABLE "flag_rules" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"flag_key" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"conditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"value" text,
	"variants" jsonb,
	"payload" jsonb
);
--> statement-breakpoint
CREATE TABLE "flag_user_overrides" (
	"user_id" bigint NOT NULL,
	"flag_key" text NOT NULL,
	"value" text NOT NULL,
	"payload" jsonb,
	CONSTRAINT "flag_user_overrides_user_id_flag_key_pk" PRIMARY KEY("user_id","flag_key")
);
--> statement-breakpoint
CREATE TABLE "flags" (
	"key" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"default_value" text DEFAULT 'off' NOT NULL,
	"payload" jsonb,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"user_id" bigint,
	"device_id" text,
	"ip" text,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"secret" boolean DEFAULT false NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" bigint NOT NULL,
	"role" text NOT NULL,
	"granted_by" text,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "user_roles_user_id_role_pk" PRIMARY KEY("user_id","role")
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"user_id" bigint PRIMARY KEY NOT NULL,
	"display_name" text,
	"about_me" text,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"location" geography(Point, 4326),
	"public_location" geography(Point, 4326),
	"geohash" text,
	"location_updated_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"incognito" boolean DEFAULT false NOT NULL,
	"show_on_map" boolean DEFAULT false NOT NULL,
	"map_fuzz_radius" integer,
	"approximate_distance" boolean DEFAULT false NOT NULL,
	"height_cm" real,
	"weight_grams" real,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_keys" ADD CONSTRAINT "device_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "third_party_identities" ADD CONSTRAINT "third_party_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_user_overrides" ADD CONSTRAINT "entitlement_user_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flag_rules" ADD CONSTRAINT "flag_rules_flag_key_flags_key_fk" FOREIGN KEY ("flag_key") REFERENCES "public"."flags"("key") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "flag_user_overrides" ADD CONSTRAINT "flag_user_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flag_user_overrides" ADD CONSTRAINT "flag_user_overrides_flag_key_flags_key_fk" FOREIGN KEY ("flag_key") REFERENCES "public"."flags"("key") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_tokens_hash_uq" ON "auth_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_tokens_family_idx" ON "auth_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "auth_tokens_user_idx" ON "auth_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "device_keys_user_idx" ON "device_keys" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "devices_fcm_token_uq" ON "devices" USING btree ("fcm_token") WHERE "devices"."fcm_token" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tpi_provider_user_uq" ON "third_party_identities" USING btree ("provider","provider_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tpi_prefixed_uq" ON "third_party_identities" USING btree ("prefixed_id");--> statement-breakpoint
CREATE INDEX "tpi_user_idx" ON "third_party_identities" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uq" ON "users" USING btree (lower("email")) WHERE "users"."email" IS NOT NULL AND "users"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "users_created_at_idx" ON "users" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_created_idx" ON "admin_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_target_idx" ON "admin_audit_log" USING btree ("target");--> statement-breakpoint
CREATE INDEX "eo_expires_idx" ON "entitlement_user_overrides" USING btree ("expires_at") WHERE "entitlement_user_overrides"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "flag_rules_flag_idx" ON "flag_rules" USING btree ("flag_key","position");--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox" USING btree ("available_at") WHERE "outbox"."processed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "security_events_created_idx" ON "security_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "security_events_user_idx" ON "security_events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_roles_expires_idx" ON "user_roles" USING btree ("expires_at") WHERE "user_roles"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "profiles_public_location_gist" ON "profiles" USING gist ("public_location");--> statement-breakpoint
CREATE INDEX "profiles_geohash_idx" ON "profiles" USING btree ("geohash" text_pattern_ops);--> statement-breakpoint
CREATE INDEX "profiles_last_seen_idx" ON "profiles" USING btree ("last_seen_at" DESC NULLS LAST);