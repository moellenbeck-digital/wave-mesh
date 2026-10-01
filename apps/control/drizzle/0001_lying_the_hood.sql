CREATE TABLE "auth_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"machine_key" text NOT NULL,
	"node_key" text NOT NULL,
	"disco_key" text NOT NULL,
	"hostname" text NOT NULL,
	"os" text NOT NULL,
	"poll_secret_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"node_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"wave_id" text NOT NULL,
	"user_id" text NOT NULL,
	"machine_key" text NOT NULL,
	"node_key" text NOT NULL,
	"disco_key" text NOT NULL,
	"hostname" text NOT NULL,
	"os" text NOT NULL,
	"ipv4" text NOT NULL,
	"ipv6" text NOT NULL,
	"candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approved" boolean DEFAULT true NOT NULL,
	"ephemeral" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"key_expires_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "waves" ADD COLUMN "netmap_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_requests" ADD CONSTRAINT "auth_requests_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_wave_id_waves_id_fk" FOREIGN KEY ("wave_id") REFERENCES "public"."waves"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_requests_poll_secret_idx" ON "auth_requests" USING btree ("poll_secret_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "nodes_machine_key_idx" ON "nodes" USING btree ("machine_key");--> statement-breakpoint
CREATE UNIQUE INDEX "nodes_wave_ipv4_idx" ON "nodes" USING btree ("wave_id","ipv4");--> statement-breakpoint
CREATE UNIQUE INDEX "nodes_wave_hostname_idx" ON "nodes" USING btree ("wave_id","hostname");--> statement-breakpoint
CREATE INDEX "nodes_wave_idx" ON "nodes" USING btree ("wave_id");