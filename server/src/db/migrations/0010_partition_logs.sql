-- Append-only log tables become monthly range partitions on created_at
-- (native Postgres partitioning; monthly partitions are created ahead and
-- dropped after retention by the worker, see src/db/partitions.ts).
-- A DEFAULT partition catches anything outside the prepared months.

ALTER TABLE "admin_audit_log" RENAME TO "admin_audit_log_old";--> statement-breakpoint
ALTER INDEX IF EXISTS "audit_created_idx" RENAME TO "audit_created_idx_old";--> statement-breakpoint
ALTER INDEX IF EXISTS "audit_target_idx" RENAME TO "audit_target_idx_old";--> statement-breakpoint
CREATE TABLE "admin_audit_log" (
	"id" bigserial NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target" text,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_audit_log_id_created_at_pk" PRIMARY KEY ("id", "created_at")
) PARTITION BY RANGE ("created_at");--> statement-breakpoint
CREATE TABLE "admin_audit_log_default" PARTITION OF "admin_audit_log" DEFAULT;--> statement-breakpoint
CREATE INDEX "audit_created_idx" ON "admin_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_target_idx" ON "admin_audit_log" USING btree ("target");--> statement-breakpoint
INSERT INTO "admin_audit_log" ("id", "actor", "action", "target", "before", "after", "created_at")
	SELECT "id", "actor", "action", "target", "before", "after", "created_at" FROM "admin_audit_log_old";--> statement-breakpoint
SELECT setval(pg_get_serial_sequence('admin_audit_log', 'id'), GREATEST((SELECT coalesce(max("id"), 0) FROM "admin_audit_log"), 1));--> statement-breakpoint
DROP TABLE "admin_audit_log_old";--> statement-breakpoint

ALTER TABLE "security_events" RENAME TO "security_events_old";--> statement-breakpoint
ALTER INDEX IF EXISTS "security_events_created_idx" RENAME TO "security_events_created_idx_old";--> statement-breakpoint
ALTER INDEX IF EXISTS "security_events_user_idx" RENAME TO "security_events_user_idx_old";--> statement-breakpoint
CREATE TABLE "security_events" (
	"id" bigserial NOT NULL,
	"kind" text NOT NULL,
	"user_id" bigint,
	"device_id" text,
	"ip" text,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_events_id_created_at_pk" PRIMARY KEY ("id", "created_at")
) PARTITION BY RANGE ("created_at");--> statement-breakpoint
CREATE TABLE "security_events_default" PARTITION OF "security_events" DEFAULT;--> statement-breakpoint
CREATE INDEX "security_events_created_idx" ON "security_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "security_events_user_idx" ON "security_events" USING btree ("user_id");--> statement-breakpoint
INSERT INTO "security_events" ("id", "kind", "user_id", "device_id", "ip", "detail", "created_at")
	SELECT "id", "kind", "user_id", "device_id", "ip", "detail", "created_at" FROM "security_events_old";--> statement-breakpoint
SELECT setval(pg_get_serial_sequence('security_events', 'id'), GREATEST((SELECT coalesce(max("id"), 0) FROM "security_events"), 1));--> statement-breakpoint
DROP TABLE "security_events_old";
