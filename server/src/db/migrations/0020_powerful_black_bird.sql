ALTER TABLE "profiles" ADD COLUMN "home_auto" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "away_anchor" geography(Point, 4326);--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "away_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "is_visiting" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "profiles" SET "is_visiting" = ("visiting_mode" = 'ON' OR ("visiting_mode" = 'AUTO' AND "home_location" IS NOT NULL AND "location" IS NOT NULL AND ST_Distance("location", "home_location") > 50000));--> statement-breakpoint
UPDATE "profiles" SET "home_location" = "location", "home_auto" = true WHERE "home_location" IS NULL AND "location" IS NOT NULL;
