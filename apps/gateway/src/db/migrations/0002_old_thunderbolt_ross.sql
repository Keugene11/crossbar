CREATE TABLE "providers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"may_train_on_data" boolean DEFAULT false NOT NULL,
	"privacy_policy_url" text,
	"terms_url" text,
	"status_page_url" text
);
--> statement-breakpoint
ALTER TABLE "endpoints" ADD COLUMN "quantization" text;--> statement-breakpoint
ALTER TABLE "endpoints" ADD COLUMN "data_collection" text DEFAULT 'deny' NOT NULL;