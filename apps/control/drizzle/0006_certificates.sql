CREATE TABLE "acme_accounts" (
	"directory_url" text PRIMARY KEY NOT NULL,
	"private_key_pem" text NOT NULL,
	"account_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "certificate_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"wave_id" text NOT NULL,
	"node_id" text NOT NULL,
	"names" jsonb NOT NULL,
	"csr" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"chain_pem" text,
	"error" text,
	"renew_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "dns_credentials" (
	"wave_id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"token_sealed" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "certificate_orders" ADD CONSTRAINT "certificate_orders_wave_id_waves_id_fk" FOREIGN KEY ("wave_id") REFERENCES "public"."waves"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificate_orders" ADD CONSTRAINT "certificate_orders_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_credentials" ADD CONSTRAINT "dns_credentials_wave_id_waves_id_fk" FOREIGN KEY ("wave_id") REFERENCES "public"."waves"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "certificate_orders_node_idx" ON "certificate_orders" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "certificate_orders_wave_idx" ON "certificate_orders" USING btree ("wave_id");