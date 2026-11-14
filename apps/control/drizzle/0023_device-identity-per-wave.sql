DROP INDEX "nodes_machine_key_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "nodes_wave_machine_key_idx" ON "nodes" USING btree ("wave_id","machine_key");--> statement-breakpoint
CREATE INDEX "nodes_machine_key_idx" ON "nodes" USING btree ("machine_key");