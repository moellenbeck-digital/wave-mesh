CREATE TABLE "wave_services" (
	"id" text PRIMARY KEY NOT NULL,
	"wave_id" text NOT NULL,
	"name" text NOT NULL,
	"via_node_id" text NOT NULL,
	"ipv4" text NOT NULL,
	"ipv6" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wave_services" ADD CONSTRAINT "wave_services_wave_id_waves_id_fk" FOREIGN KEY ("wave_id") REFERENCES "public"."waves"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wave_services" ADD CONSTRAINT "wave_services_via_node_id_nodes_id_fk" FOREIGN KEY ("via_node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wave_services_name_idx" ON "wave_services" USING btree ("wave_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "wave_services_ipv4_idx" ON "wave_services" USING btree ("wave_id","ipv4");--> statement-breakpoint
CREATE INDEX "wave_services_node_idx" ON "wave_services" USING btree ("via_node_id");