CREATE TABLE "chat_drawer" (
	"owner_id" bigint NOT NULL,
	"media_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_drawer_owner_id_media_hash_pk" PRIMARY KEY("owner_id","media_hash")
);
--> statement-breakpoint
CREATE TABLE "chat_media_usage" (
	"owner_id" bigint NOT NULL,
	"conversation_id" text NOT NULL,
	"media_hash" text NOT NULL,
	CONSTRAINT "chat_media_usage_owner_id_conversation_id_media_hash_pk" PRIMARY KEY("owner_id","conversation_id","media_hash")
);
--> statement-breakpoint
CREATE TABLE "conversation_members" (
	"conversation_id" text NOT NULL,
	"user_id" bigint NOT NULL,
	"other_id" bigint NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"last_read_at" bigint,
	"last_activity_at" timestamp with time zone,
	"preview_message_id" text,
	"cleared_at" timestamp with time zone,
	CONSTRAINT "conversation_members_conversation_id_user_id_pk" PRIMARY KEY("conversation_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_low" bigint NOT NULL,
	"user_high" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"sender_id" bigint NOT NULL,
	"recipient_id" bigint NOT NULL,
	"type" text NOT NULL,
	"body" jsonb,
	"media_hash" text,
	"reply_to_id" text,
	"unsent" boolean DEFAULT false NOT NULL,
	"reactions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hidden_for" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
	"views_used" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "messages_id_created_at_pk" PRIMARY KEY("id","created_at")
) PARTITION BY RANGE ("created_at");
--> statement-breakpoint
-- Monthly partitions are created ahead by src/db/partitions.ts; DEFAULT catches the rest.
CREATE TABLE "messages_default" PARTITION OF "messages" DEFAULT;
--> statement-breakpoint
CREATE TABLE "saved_phrases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" bigint NOT NULL,
	"text" text NOT NULL,
	"frequency" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_drawer" ADD CONSTRAINT "chat_drawer_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_media_usage" ADD CONSTRAINT "chat_media_usage_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_low_users_id_fk" FOREIGN KEY ("user_low") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_high_users_id_fk" FOREIGN KEY ("user_high") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_phrases" ADD CONSTRAINT "saved_phrases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_drawer_owner_created_idx" ON "chat_drawer" USING btree ("owner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "conv_members_inbox_idx" ON "conversation_members" USING btree ("user_id","pinned" DESC NULLS LAST,"last_activity_at" DESC NULLS LAST) INCLUDE ("unread_count") WHERE "conversation_members"."last_activity_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_conv_created_idx" ON "messages" USING btree ("conversation_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "messages_sender_created_idx" ON "messages" USING btree ("sender_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "saved_phrases_user_idx" ON "saved_phrases" USING btree ("user_id","created_at");