CREATE TABLE "wave_piers" (
	"id" text PRIMARY KEY NOT NULL,
	"wave_id" text NOT NULL,
	"node_id" text NOT NULL,
	"name" text NOT NULL,
	"port" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "pier_allowed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "pier_ipv4" text;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "pier_ipv6" text;--> statement-breakpoint
ALTER TABLE "wave_piers" ADD CONSTRAINT "wave_piers_wave_id_waves_id_fk" FOREIGN KEY ("wave_id") REFERENCES "public"."waves"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wave_piers" ADD CONSTRAINT "wave_piers_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wave_piers_name_idx" ON "wave_piers" USING btree ("wave_id","name");--> statement-breakpoint
CREATE INDEX "wave_piers_node_idx" ON "wave_piers" USING btree ("node_id");