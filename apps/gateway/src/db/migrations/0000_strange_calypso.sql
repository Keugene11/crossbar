CREATE TABLE "endpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"model_id" text NOT NULL,
	"provider" text NOT NULL,
	"upstream_model_id" text NOT NULL,
	"base_url" text,
	"price_prompt_micro" integer NOT NULL,
	"price_completion_micro" integer NOT NULL,
	"price_cache_read_micro" integer,
	"price_cache_write_micro" integer,
	"context_length" integer NOT NULL,
	"max_output_tokens" integer NOT NULL,
	"supports_tools" boolean DEFAULT true NOT NULL,
	"supports_streaming" boolean DEFAULT true NOT NULL,
	"supports_vision" boolean DEFAULT false NOT NULL,
	"supports_reasoning" boolean DEFAULT false NOT NULL,
	"unsupported_params" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generations" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"key_id" text,
	"requested_model" text NOT NULL,
	"model_id" text,
	"endpoint_id" text,
	"provider" text,
	"streamed" boolean DEFAULT false NOT NULL,
	"finish_reason" text,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"reasoning_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micro" bigint DEFAULT 0 NOT NULL,
	"latency_ms" integer,
	"ttft_ms" integer,
	"attempts" jsonb NOT NULL,
	"error" jsonb
);
--> statement-breakpoint
CREATE TABLE "models" (
	"id" text PRIMARY KEY NOT NULL,
	"author" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"context_length" integer NOT NULL,
	"input_modalities" jsonb NOT NULL,
	"output_modalities" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "endpoints_model_id_idx" ON "endpoints" USING btree ("model_id");--> statement-breakpoint
CREATE INDEX "generations_created_at_idx" ON "generations" USING btree ("created_at");