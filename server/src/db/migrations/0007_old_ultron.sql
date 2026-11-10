CREATE TABLE "profile_notes" (
	"owner_id" bigint NOT NULL,
	"target_id" bigint NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"phone_number" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_notes_owner_id_target_id_pk" PRIMARY KEY("owner_id","target_id")
);
--> statement-breakpoint
ALTER TABLE "profile_notes" ADD CONSTRAINT "profile_notes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_notes" ADD CONSTRAINT "profile_notes_target_id_users_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;