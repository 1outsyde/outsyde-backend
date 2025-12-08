CREATE TABLE "appointments" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" varchar(36) NOT NULL,
	"client_id" varchar(36) NOT NULL,
	"service_id" varchar(36) NOT NULL,
	"appointment_date" text NOT NULL,
	"appointment_time" text NOT NULL,
	"total_price" integer NOT NULL,
	"stripe_payment_intent_id" text,
	"status" text DEFAULT 'pending',
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "businesses" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" varchar(36) NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"description" text,
	"is_startup" boolean DEFAULT false,
	"years_in_business" text,
	"employee_count" text,
	"business_type" text,
	"has_physical_location" boolean DEFAULT true,
	"address" text,
	"city" text,
	"state" text,
	"zip_code" text,
	"website_url" text,
	"social_media" text,
	"cover_image" text,
	"logo_image" text,
	"rating" integer DEFAULT 0,
	"review_count" integer DEFAULT 0,
	"subscription_active" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE "cities" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"state" text NOT NULL,
	"business_count" integer DEFAULT 0,
	"image_url" text,
	"trending" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE "photographers" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"display_name" text NOT NULL,
	"bio" text,
	"city" text,
	"state" text,
	"portfolio_url" text,
	"hourly_rate" integer NOT NULL,
	"rating" integer DEFAULT 0,
	"review_count" integer DEFAULT 0,
	"stripe_account_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "service_businesses" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" varchar(36) NOT NULL,
	"business_name" text NOT NULL,
	"category" text NOT NULL,
	"description" text,
	"address" text,
	"city" text,
	"state" text,
	"stripe_account_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" varchar(36) NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"price" integer NOT NULL,
	"duration_minutes" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shoot_bookings" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"photographer_id" varchar(36) NOT NULL,
	"client_id" varchar(36) NOT NULL,
	"shoot_type" text NOT NULL,
	"date" text NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"duration_hours" integer NOT NULL,
	"location_type" text,
	"location_details" text,
	"total_price" integer NOT NULL,
	"stripe_payment_intent_id" text,
	"status" text DEFAULT 'pending',
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password" text NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"is_vendor" boolean DEFAULT false NOT NULL,
	"address" text,
	"city" text,
	"state" text,
	"zip_code" text,
	"age_range" text,
	"gender" text,
	"ethnicity" text,
	"nationality" text,
	"household_size" text,
	"income_range" text,
	"education" text,
	"occupation" text,
	"shopping_frequency" text,
	"selected_industries" jsonb DEFAULT '[]'::jsonb,
	"industry_niches" jsonb DEFAULT '{}'::jsonb,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_business_id_service_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."service_businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_client_id_users_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photographers" ADD CONSTRAINT "photographers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_businesses" ADD CONSTRAINT "service_businesses_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_business_id_service_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."service_businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shoot_bookings" ADD CONSTRAINT "shoot_bookings_photographer_id_photographers_id_fk" FOREIGN KEY ("photographer_id") REFERENCES "public"."photographers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shoot_bookings" ADD CONSTRAINT "shoot_bookings_client_id_users_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;