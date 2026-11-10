CREATE TABLE "catalog_items" (
	"type" text NOT NULL,
	"item_id" integer NOT NULL,
	"key" text,
	"parent_id" integer,
	"sort" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_items_type_item_id_pk" PRIMARY KEY("type","item_id")
);
--> statement-breakpoint
CREATE TABLE "catalog_translations" (
	"type" text NOT NULL,
	"item_id" integer NOT NULL,
	"locale" text NOT NULL,
	"label" text NOT NULL,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_translations_type_item_id_locale_pk" PRIMARY KEY("type","item_id","locale")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_items_tag_key_uq" ON "catalog_items" USING btree ("type","key");