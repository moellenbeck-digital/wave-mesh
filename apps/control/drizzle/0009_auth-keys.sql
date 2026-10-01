CREATE TABLE "wave_auth_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"wave_id" text NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"label" text,
	"reusable" boolean DEFAULT false NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "wave_auth_keys" ADD CONSTRAINT "wave_auth_keys_wave_id_waves_id_fk" FOREIGN KEY ("wave_id") REFERENCES "public"."waves"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wave_auth_keys" ADD CONSTRAINT "wave_auth_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wave_auth_keys_token_idx" ON "wave_auth_keys" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "wave_auth_keys_wave_idx" ON "wave_auth_keys" USING btree ("wave_id");