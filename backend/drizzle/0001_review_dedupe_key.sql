ALTER TABLE "reviews" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_dedupe_key_unique" UNIQUE("dedupe_key");