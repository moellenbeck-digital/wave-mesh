CREATE TABLE "account_links" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"auth_provider" text NOT NULL,
	"provider" text,
	"subject" text,
	"email" text,
	"target_user_id" text,
	"verified_at" timestamp with time zone,
	"password_at" timestamp with time zone,
	"code_attempts" integer DEFAULT 0 NOT NULL,
	"control_at" timestamp with time zone,
	"control_method" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_links" ADD CONSTRAINT "account_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_links" ADD CONSTRAINT "account_links_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_links_token_idx" ON "account_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "account_links_user_idx" ON "account_links" USING btree ("user_id");