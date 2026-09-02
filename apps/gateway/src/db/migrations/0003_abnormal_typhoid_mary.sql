CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"hash" text NOT NULL,
	"label" text,
	"credit_micro" bigint,
	"spent_micro" bigint DEFAULT 0 NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "api_keys_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE INDEX "api_keys_hash_idx" ON "api_keys" USING btree ("hash");