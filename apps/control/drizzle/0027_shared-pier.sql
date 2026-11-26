ALTER TABLE "nodes" ADD COLUMN "shared_pier" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "waves" ADD COLUMN "pier_zone_mode" text DEFAULT 'shared' NOT NULL;--> statement-breakpoint
ALTER TABLE "waves" ADD COLUMN "shared_pier_name" text;--> statement-breakpoint
CREATE UNIQUE INDEX "nodes_one_shared_pier_idx" ON "nodes" USING btree ("shared_pier") WHERE "nodes"."shared_pier";--> statement-breakpoint
CREATE UNIQUE INDEX "waves_shared_pier_name_idx" ON "waves" USING btree ("shared_pier_name");--> statement-breakpoint
-- A wave that already holds names or has a pier keeps the zone it has: the
-- names and their certificates hang under `pier.<suffix>`.
UPDATE "waves" SET "pier_zone_mode" = 'own' WHERE EXISTS (SELECT 1 FROM "wave_piers" WHERE "wave_piers"."wave_id" = "waves"."id") OR EXISTS (SELECT 1 FROM "nodes" WHERE "nodes"."wave_id" = "waves"."id" AND ("nodes"."pier_ipv4" IS NOT NULL OR "nodes"."pier_ipv6" IS NOT NULL));
