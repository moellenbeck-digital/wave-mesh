CREATE TABLE "wave_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"wave_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_user_id" text,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "wave_invites" ADD CONSTRAINT "wave_invites_wave_id_waves_id_fk" FOREIGN KEY ("wave_id") REFERENCES "public"."waves"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wave_invites" ADD CONSTRAINT "wave_invites_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wave_invites" ADD CONSTRAINT "wave_invites_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wave_invites_token_idx" ON "wave_invites" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "wave_invites_wave_idx" ON "wave_invites" USING btree ("wave_id");--> statement-breakpoint
CREATE INDEX "wave_invites_email_idx" ON "wave_invites" USING btree ("email");