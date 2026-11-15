CREATE TABLE "signup_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "signup_verifications_token_idx" ON "signup_verifications" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "signup_verifications_email_idx" ON "signup_verifications" USING btree ("email");