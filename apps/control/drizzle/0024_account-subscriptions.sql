CREATE TABLE "account_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"subscription_id" text NOT NULL,
	"account_id" text NOT NULL,
	"seats" integer NOT NULL,
	"state" text NOT NULL,
	"state_as_of" bigint,
	"delete_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_subscriptions" ADD CONSTRAINT "account_subscriptions_account_id_customer_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."customer_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_subscriptions_subscription_idx" ON "account_subscriptions" USING btree ("subscription_id");--> statement-breakpoint
CREATE INDEX "account_subscriptions_account_idx" ON "account_subscriptions" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_subscriptions_one_live_idx" ON "account_subscriptions" USING btree ("account_id") WHERE "account_subscriptions"."state" <> 'ended';