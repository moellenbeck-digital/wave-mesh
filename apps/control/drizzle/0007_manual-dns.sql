ALTER TABLE "dns_credentials" ALTER COLUMN "token_sealed" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "certificate_orders" ADD COLUMN "challenges" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "certificate_orders" ADD COLUMN "acme_order_url" text;