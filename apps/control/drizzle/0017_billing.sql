CREATE TABLE "password_setups" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wave_billing" (
	"wave_id" text PRIMARY KEY NOT NULL,
	"subscription_id" text NOT NULL,
	"seats" integer NOT NULL,
	"state" text NOT NULL,
	"delete_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "password_setups" ADD CONSTRAINT "password_setups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wave_billing" ADD CONSTRAINT "wave_billing_wave_id_waves_id_fk" FOREIGN KEY ("wave_id") REFERENCES "public"."waves"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "password_setups_token_idx" ON "password_setups" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "password_setups_user_idx" ON "password_setups" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wave_billing_subscription_idx" ON "wave_billing" USING btree ("subscription_id");