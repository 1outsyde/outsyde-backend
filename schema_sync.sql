-- Complete schema sync: ALTER TABLE IF NOT EXISTS for all columns
-- Run in Neon SQL Editor. Safe to run multiple times (IF NOT EXISTS).


-- users
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_image_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS cover_media_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS cover_media_type TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_vendor BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_photographer BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_influencer BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_oauth_user BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS wants_to_sell_products BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS wants_to_offer_services BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS wants_to_promote_as_influencer BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_monetize BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS apt_unit TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS state TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS zip_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS country TEXT DEFAULT 'United States';
ALTER TABLE users ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;
ALTER TABLE users ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_address JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_same_as_home BOOLEAN DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_street TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_apt_unit TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_city TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_state TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_zip TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_country TEXT DEFAULT 'United States';
ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS gender TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ethnicity TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS nationality TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS household_size TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS income_range TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS education TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS occupation TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS shopping_frequency TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS selected_industries JSONB DEFAULT '[]'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS industry_niches JSONB DEFAULT '{}'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS industry_values JSONB DEFAULT '{}'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS loyalty_points INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by VARCHAR(36);
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS expo_push_token TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS push_token_type TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS username_last_changed_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name_last_changed_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_code_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_code_expires_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_code_attempts INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- cities
ALTER TABLE cities ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE cities ADD COLUMN IF NOT EXISTS state TEXT;
ALTER TABLE cities ADD COLUMN IF NOT EXISTS business_count INTEGER DEFAULT 0;
ALTER TABLE cities ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE cities ADD COLUMN IF NOT EXISTS trending BOOLEAN DEFAULT false;

-- refresh_tokens
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS user_id VARCHAR(36);
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS token_hash TEXT;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMP;

-- businesses
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS owner_id VARCHAR(36);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS is_startup BOOLEAN DEFAULT false;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS years_in_business TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS employee_count TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS business_type TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS has_physical_location BOOLEAN DEFAULT true;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS state TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS zip_code TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS country TEXT DEFAULT 'United States';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS website_url TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS social_media TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS cover_image TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS cover_media_type TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS logo_image TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS rating INTEGER DEFAULT 0;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS review_count INTEGER DEFAULT 0;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS subscription_active BOOLEAN DEFAULT false;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS tagline TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS hours_of_operation JSONB;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS contact_email TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS contact_phone TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS brand_colors JSONB;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS known_for JSONB DEFAULT '[]'::jsonb;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS has_products BOOLEAN DEFAULT false;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS has_services BOOLEAN DEFAULT false;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS stripe_account_id TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS stripe_onboarding_complete BOOLEAN DEFAULT false;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS stripe_onboarding_url TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS billing_address JSONB;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS approval_status TEXT DEFAULT 'pending';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS approval_notes TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS approved_by VARCHAR(36);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS is_demo BOOLEAN DEFAULT false;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS auto_accept_bookings BOOLEAN DEFAULT true;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- vendor_products
ALTER TABLE vendor_products ADD COLUMN IF NOT EXISTS business_id VARCHAR(36);
ALTER TABLE vendor_products ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE vendor_products ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE vendor_products ADD COLUMN IF NOT EXISTS price INTEGER;
ALTER TABLE vendor_products ADD COLUMN IF NOT EXISTS compare_at_price INTEGER;
ALTER TABLE vendor_products ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE vendor_products ADD COLUMN IF NOT EXISTS images JSONB DEFAULT '[]'::jsonb;
ALTER TABLE vendor_products ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE vendor_products ADD COLUMN IF NOT EXISTS tags TEXT[];
ALTER TABLE vendor_products ADD COLUMN IF NOT EXISTS inventory INTEGER DEFAULT 0;
ALTER TABLE vendor_products ADD COLUMN IF NOT EXISTS track_inventory BOOLEAN DEFAULT true;
ALTER TABLE vendor_products ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
ALTER TABLE vendor_products ADD COLUMN IF NOT EXISTS is_featured BOOLEAN DEFAULT false;
ALTER TABLE vendor_products ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'draft';
ALTER TABLE vendor_products ADD COLUMN IF NOT EXISTS stripe_product_id TEXT;
ALTER TABLE vendor_products ADD COLUMN IF NOT EXISTS stripe_price_id TEXT;
ALTER TABLE vendor_products ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- vendor_services
ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS business_id VARCHAR(36);
ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS price INTEGER;
ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS duration_minutes INTEGER;
ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS is_featured BOOLEAN DEFAULT false;
ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'draft';
ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS stripe_product_id TEXT;
ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS stripe_price_id TEXT;
ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- business_availability
ALTER TABLE business_availability ADD COLUMN IF NOT EXISTS business_id VARCHAR(36);
ALTER TABLE business_availability ADD COLUMN IF NOT EXISTS date TEXT;
ALTER TABLE business_availability ADD COLUMN IF NOT EXISTS start_time TEXT;
ALTER TABLE business_availability ADD COLUMN IF NOT EXISTS end_time TEXT;
ALTER TABLE business_availability ADD COLUMN IF NOT EXISTS slot_type TEXT DEFAULT 'available';
ALTER TABLE business_availability ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE business_availability ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE business_availability ADD COLUMN IF NOT EXISTS appointment_id VARCHAR(36);
ALTER TABLE business_availability ADD COLUMN IF NOT EXISTS is_recurring BOOLEAN DEFAULT false;
ALTER TABLE business_availability ADD COLUMN IF NOT EXISTS recurring_day_of_week INTEGER;
ALTER TABLE business_availability ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- staff_members
ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS business_id VARCHAR(36);
ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS user_id VARCHAR(36);
ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS profile_image_url TEXT;
ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS service_ids JSONB DEFAULT '[]'::jsonb;
ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS specialties TEXT[];
ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'staff';
ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS rating INTEGER DEFAULT 0;
ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS review_count INTEGER DEFAULT 0;
ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS stripe_account_id TEXT;
ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS stripe_onboarding_complete BOOLEAN DEFAULT false;
ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS stripe_onboarding_url TEXT;
ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS hours_of_operation JSONB;
ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- staff_availability
ALTER TABLE staff_availability ADD COLUMN IF NOT EXISTS staff_member_id VARCHAR(36);
ALTER TABLE staff_availability ADD COLUMN IF NOT EXISTS business_id VARCHAR(36);
ALTER TABLE staff_availability ADD COLUMN IF NOT EXISTS date TEXT;
ALTER TABLE staff_availability ADD COLUMN IF NOT EXISTS start_time TEXT;
ALTER TABLE staff_availability ADD COLUMN IF NOT EXISTS end_time TEXT;
ALTER TABLE staff_availability ADD COLUMN IF NOT EXISTS slot_type TEXT DEFAULT 'available';
ALTER TABLE staff_availability ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE staff_availability ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE staff_availability ADD COLUMN IF NOT EXISTS appointment_id VARCHAR(36);
ALTER TABLE staff_availability ADD COLUMN IF NOT EXISTS is_recurring BOOLEAN DEFAULT false;
ALTER TABLE staff_availability ADD COLUMN IF NOT EXISTS recurring_day_of_week INTEGER;
ALTER TABLE staff_availability ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- staff_invites
ALTER TABLE staff_invites ADD COLUMN IF NOT EXISTS business_id VARCHAR(36);
ALTER TABLE staff_invites ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE staff_invites ADD COLUMN IF NOT EXISTS invite_code TEXT;
ALTER TABLE staff_invites ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE staff_invites ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'staff';
ALTER TABLE staff_invites ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
ALTER TABLE staff_invites ADD COLUMN IF NOT EXISTS invited_by_user_id VARCHAR(36);
ALTER TABLE staff_invites ADD COLUMN IF NOT EXISTS accepted_by_user_id VARCHAR(36);
ALTER TABLE staff_invites ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;
ALTER TABLE staff_invites ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMP;
ALTER TABLE staff_invites ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- photographers
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS user_id VARCHAR(36);
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS state TEXT;
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS portfolio_url TEXT;
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS hourly_rate INTEGER;
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS rating INTEGER DEFAULT 0;
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS review_count INTEGER DEFAULT 0;
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS stripe_account_id TEXT;
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS stripe_onboarding_complete BOOLEAN DEFAULT false;
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS stripe_onboarding_url TEXT;
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS specialties TEXT[];
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS cover_image TEXT;
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS cover_media_type TEXT;
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS logo_image TEXT;
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS brand_colors JSONB;
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS hours_of_operation JSONB;
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS billing_address JSONB;
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS travel_buffer_minutes INTEGER DEFAULT 30;
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS service_radius_miles INTEGER DEFAULT 25;
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS service_locations JSONB;
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS shoot_location TEXT[];
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS studio_name TEXT;
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS studio_address TEXT;
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS uses_shared_studio BOOLEAN DEFAULT false;
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS travel_radius TEXT;
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS pricing_type TEXT;
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS starting_price INTEGER;
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS minimum_booking TEXT;
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS additional_services TEXT[];
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS experience_level TEXT;
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS equipment_level TEXT;
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS delivery_time TEXT;
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS is_demo BOOLEAN DEFAULT false;
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS auto_accept_bookings BOOLEAN DEFAULT true;
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS visibility_status TEXT DEFAULT 'public';
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS admin_notes TEXT;
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

-- photographer_blackout_dates
ALTER TABLE photographer_blackout_dates ADD COLUMN IF NOT EXISTS photographer_id VARCHAR(36);
ALTER TABLE photographer_blackout_dates ADD COLUMN IF NOT EXISTS date TEXT;
ALTER TABLE photographer_blackout_dates ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE photographer_blackout_dates ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- photographer_availability
ALTER TABLE photographer_availability ADD COLUMN IF NOT EXISTS photographer_id VARCHAR(36);
ALTER TABLE photographer_availability ADD COLUMN IF NOT EXISTS date TEXT;
ALTER TABLE photographer_availability ADD COLUMN IF NOT EXISTS start_time TEXT;
ALTER TABLE photographer_availability ADD COLUMN IF NOT EXISTS end_time TEXT;
ALTER TABLE photographer_availability ADD COLUMN IF NOT EXISTS slot_type TEXT DEFAULT 'available';
ALTER TABLE photographer_availability ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE photographer_availability ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE photographer_availability ADD COLUMN IF NOT EXISTS shoot_booking_id VARCHAR(36);
ALTER TABLE photographer_availability ADD COLUMN IF NOT EXISTS is_recurring BOOLEAN DEFAULT false;
ALTER TABLE photographer_availability ADD COLUMN IF NOT EXISTS recurring_day_of_week INTEGER;
ALTER TABLE photographer_availability ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- photographer_services
ALTER TABLE photographer_services ADD COLUMN IF NOT EXISTS photographer_id VARCHAR(36);
ALTER TABLE photographer_services ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE photographer_services ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE photographer_services ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE photographer_services ADD COLUMN IF NOT EXISTS pricing_model TEXT DEFAULT 'package';
ALTER TABLE photographer_services ADD COLUMN IF NOT EXISTS hourly_rate_cents INTEGER;
ALTER TABLE photographer_services ADD COLUMN IF NOT EXISTS price_cents INTEGER;
ALTER TABLE photographer_services ADD COLUMN IF NOT EXISTS package_hours INTEGER;
ALTER TABLE photographer_services ADD COLUMN IF NOT EXISTS is_contact_for_pricing BOOLEAN DEFAULT false;
ALTER TABLE photographer_services ADD COLUMN IF NOT EXISTS estimated_duration_minutes INTEGER;
ALTER TABLE photographer_services ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
ALTER TABLE photographer_services ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'draft';
ALTER TABLE photographer_services ADD COLUMN IF NOT EXISTS stripe_product_id TEXT;
ALTER TABLE photographer_services ADD COLUMN IF NOT EXISTS stripe_price_id TEXT;
ALTER TABLE photographer_services ADD COLUMN IF NOT EXISTS stripe_connected_product_id TEXT;
ALTER TABLE photographer_services ADD COLUMN IF NOT EXISTS stripe_connected_price_id TEXT;
ALTER TABLE photographer_services ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- shoot_bookings
ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS photographer_id VARCHAR(36);
ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS client_id VARCHAR(36);
ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS service_id VARCHAR(36);
ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS shoot_type TEXT;
ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS date TEXT;
ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS start_time TEXT;
ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS end_time TEXT;
ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS duration_hours INTEGER;
ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS location_type TEXT;
ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS location_details TEXT;
ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS special_requests TEXT;
ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS total_price INTEGER;
ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS platform_fee INTEGER DEFAULT 0;
ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS vendor_net INTEGER DEFAULT 0;
ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT;
ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS stripe_checkout_session_id TEXT;
ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'checkout_session';
ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS capture_method TEXT;
ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS stripe_refund_id TEXT;
ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMP;
ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS refund_amount INTEGER;
ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'draft';
ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS draft_expires_at TIMESTAMP;
ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS pending_provider_expires_at TIMESTAMP;
ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMP;
ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS canceled_by VARCHAR(36);
ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS declined_at TIMESTAMP;
ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS declined_by VARCHAR(36);
ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS decline_reason TEXT;
ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS state_changed_at TIMESTAMP;
ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS state_changed_by VARCHAR(36);
ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS previous_state TEXT;
ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;
ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

-- appointments
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS business_id VARCHAR(36);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS client_id VARCHAR(36);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS service_id VARCHAR(36);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS staff_member_id VARCHAR(36);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS appointment_date TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS appointment_time TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS appointment_end_time TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS duration_minutes INTEGER;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS total_price INTEGER;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS platform_fee INTEGER DEFAULT 0;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS vendor_net INTEGER DEFAULT 0;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS staff_payout INTEGER DEFAULT 0;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS stripe_checkout_session_id TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'checkout_session';
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS capture_method TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS stripe_refund_id TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMP;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS refund_amount INTEGER;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'draft';
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS draft_expires_at TIMESTAMP;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS pending_provider_expires_at TIMESTAMP;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMP;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS canceled_by VARCHAR(36);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS declined_at TIMESTAMP;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS declined_by VARCHAR(36);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS decline_reason TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS state_changed_at TIMESTAMP;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS state_changed_by VARCHAR(36);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS previous_state TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

-- order_groups
ALTER TABLE order_groups ADD COLUMN IF NOT EXISTS customer_id VARCHAR(36);
ALTER TABLE order_groups ADD COLUMN IF NOT EXISTS total_vendors INTEGER;
ALTER TABLE order_groups ADD COLUMN IF NOT EXISTS completed_vendors INTEGER DEFAULT 0;
ALTER TABLE order_groups ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
ALTER TABLE order_groups ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- orders
ALTER TABLE orders ADD COLUMN IF NOT EXISTS business_id VARCHAR(36);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_id VARCHAR(36);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_group_id VARCHAR(36);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS items JSONB;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS total_amount INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS platform_fee INTEGER DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS vendor_net INTEGER DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS consumer_service_fee INTEGER DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS influencer_commission INTEGER DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS gross_charge_amount INTEGER DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS outsyde_gross_revenue INTEGER DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stripe_fee_amount INTEGER DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_amount INTEGER DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS attributed_influencer_id VARCHAR(36);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS influencer_code_used TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS influencer_transfer_status TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS commission_status TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fee_model_version TEXT DEFAULT 'v2';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stripe_checkout_session_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_address TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

-- reviews
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS target_type TEXT;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS target_id VARCHAR(36);
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS reviewer_id VARCHAR(36);
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS booking_type TEXT;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS booking_id VARCHAR(36);
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS rating INTEGER;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS comment TEXT;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT true;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- point_transactions
ALTER TABLE point_transactions ADD COLUMN IF NOT EXISTS user_id VARCHAR(36);
ALTER TABLE point_transactions ADD COLUMN IF NOT EXISTS type TEXT;
ALTER TABLE point_transactions ADD COLUMN IF NOT EXISTS points INTEGER;
ALTER TABLE point_transactions ADD COLUMN IF NOT EXISTS dollar_amount_cents INTEGER;
ALTER TABLE point_transactions ADD COLUMN IF NOT EXISTS business_id VARCHAR(36);
ALTER TABLE point_transactions ADD COLUMN IF NOT EXISTS business_name TEXT;
ALTER TABLE point_transactions ADD COLUMN IF NOT EXISTS reference_type TEXT;
ALTER TABLE point_transactions ADD COLUMN IF NOT EXISTS reference_id VARCHAR(36);
ALTER TABLE point_transactions ADD COLUMN IF NOT EXISTS balance_after INTEGER;
ALTER TABLE point_transactions ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE point_transactions ADD COLUMN IF NOT EXISTS capped BOOLEAN DEFAULT false;
ALTER TABLE point_transactions ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- referrals
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS referrer_id VARCHAR(36);
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS referred_user_id VARCHAR(36);
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS referrer_bonus_points INTEGER DEFAULT 500;
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS referred_bonus_points INTEGER DEFAULT 250;
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS referrer_bonus_paid_at TIMESTAMP;
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS referred_bonus_paid_at TIMESTAMP;
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS first_transaction_id VARCHAR(36);
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS first_transaction_type TEXT;
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- booking_audit_log
ALTER TABLE booking_audit_log ADD COLUMN IF NOT EXISTS booking_type TEXT;
ALTER TABLE booking_audit_log ADD COLUMN IF NOT EXISTS booking_id VARCHAR(36);
ALTER TABLE booking_audit_log ADD COLUMN IF NOT EXISTS from_state TEXT;
ALTER TABLE booking_audit_log ADD COLUMN IF NOT EXISTS to_state TEXT;
ALTER TABLE booking_audit_log ADD COLUMN IF NOT EXISTS triggered_by VARCHAR(36);
ALTER TABLE booking_audit_log ADD COLUMN IF NOT EXISTS trigger_source TEXT;
ALTER TABLE booking_audit_log ADD COLUMN IF NOT EXISTS metadata JSONB;
ALTER TABLE booking_audit_log ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- conversations
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS participant1_id VARCHAR(36);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS participant2_id VARCHAR(36);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMP;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_message_preview TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- messages
ALTER TABLE messages ADD COLUMN IF NOT EXISTS conversation_id VARCHAR(36);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_id VARCHAR(36);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS content TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT false;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMP;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- push_subscriptions
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS user_id VARCHAR(36);
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS endpoint TEXT;
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS p256dh TEXT;
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS auth TEXT;
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

-- notifications
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS user_id VARCHAR(36);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS type TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS message TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS reference_type TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS reference_id VARCHAR(36);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT false;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS read_at TIMESTAMP;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS metadata JSONB;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- follows
ALTER TABLE follows ADD COLUMN IF NOT EXISTS follower_user_id VARCHAR(36);
ALTER TABLE follows ADD COLUMN IF NOT EXISTS target_user_id VARCHAR(36);
ALTER TABLE follows ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- cart_items
ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS user_id VARCHAR(36);
ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS product_id VARCHAR(36);
ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS product_name TEXT;
ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS product_image TEXT;
ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS price_in_cents INTEGER;
ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS quantity INTEGER DEFAULT 1;
ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS business_id VARCHAR(36);
ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS business_name TEXT;
ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;
ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

-- subscription_tiers
ALTER TABLE subscription_tiers ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE subscription_tiers ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE subscription_tiers ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE subscription_tiers ADD COLUMN IF NOT EXISTS price_in_cents INTEGER;
ALTER TABLE subscription_tiers ADD COLUMN IF NOT EXISTS platform_fee_bps INTEGER;
ALTER TABLE subscription_tiers ADD COLUMN IF NOT EXISTS features JSONB DEFAULT '[]'::jsonb;
ALTER TABLE subscription_tiers ADD COLUMN IF NOT EXISTS ala_carte_discount_percent INTEGER DEFAULT 0;
ALTER TABLE subscription_tiers ADD COLUMN IF NOT EXISTS stripe_product_id TEXT;
ALTER TABLE subscription_tiers ADD COLUMN IF NOT EXISTS stripe_price_id TEXT;
ALTER TABLE subscription_tiers ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;
ALTER TABLE subscription_tiers ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
ALTER TABLE subscription_tiers ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- tier_benefits
ALTER TABLE tier_benefits ADD COLUMN IF NOT EXISTS tier_id VARCHAR(36);
ALTER TABLE tier_benefits ADD COLUMN IF NOT EXISTS benefit_type TEXT;
ALTER TABLE tier_benefits ADD COLUMN IF NOT EXISTS benefit_name TEXT;
ALTER TABLE tier_benefits ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE tier_benefits ADD COLUMN IF NOT EXISTS monthly_allowance INTEGER;
ALTER TABLE tier_benefits ADD COLUMN IF NOT EXISTS is_unlimited BOOLEAN DEFAULT false;
ALTER TABLE tier_benefits ADD COLUMN IF NOT EXISTS cycle_type TEXT DEFAULT 'monthly';
ALTER TABLE tier_benefits ADD COLUMN IF NOT EXISTS included_quantity INTEGER DEFAULT 0;
ALTER TABLE tier_benefits ADD COLUMN IF NOT EXISTS requires_admin_fulfillment BOOLEAN DEFAULT false;
ALTER TABLE tier_benefits ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- vendor_subscriptions
ALTER TABLE vendor_subscriptions ADD COLUMN IF NOT EXISTS vendor_id VARCHAR(36);
ALTER TABLE vendor_subscriptions ADD COLUMN IF NOT EXISTS business_id VARCHAR(36);
ALTER TABLE vendor_subscriptions ADD COLUMN IF NOT EXISTS tier_id VARCHAR(36);
ALTER TABLE vendor_subscriptions ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
ALTER TABLE vendor_subscriptions ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE vendor_subscriptions ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
ALTER TABLE vendor_subscriptions ADD COLUMN IF NOT EXISTS current_period_start TIMESTAMP;
ALTER TABLE vendor_subscriptions ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMP;
ALTER TABLE vendor_subscriptions ADD COLUMN IF NOT EXISTS current_quarter_start TIMESTAMP;
ALTER TABLE vendor_subscriptions ADD COLUMN IF NOT EXISTS current_quarter_end TIMESTAMP;
ALTER TABLE vendor_subscriptions ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;
ALTER TABLE vendor_subscriptions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

-- benefit_allowances
ALTER TABLE benefit_allowances ADD COLUMN IF NOT EXISTS subscription_id VARCHAR(36);
ALTER TABLE benefit_allowances ADD COLUMN IF NOT EXISTS benefit_id VARCHAR(36);
ALTER TABLE benefit_allowances ADD COLUMN IF NOT EXISTS monthly_allowance INTEGER;
ALTER TABLE benefit_allowances ADD COLUMN IF NOT EXISTS used_this_month INTEGER DEFAULT 0;
ALTER TABLE benefit_allowances ADD COLUMN IF NOT EXISTS is_unlimited BOOLEAN DEFAULT false;
ALTER TABLE benefit_allowances ADD COLUMN IF NOT EXISTS period_start TIMESTAMP;
ALTER TABLE benefit_allowances ADD COLUMN IF NOT EXISTS period_end TIMESTAMP;
ALTER TABLE benefit_allowances ADD COLUMN IF NOT EXISTS cycle_start TIMESTAMP;
ALTER TABLE benefit_allowances ADD COLUMN IF NOT EXISTS cycle_end TIMESTAMP;
ALTER TABLE benefit_allowances ADD COLUMN IF NOT EXISTS is_expired BOOLEAN DEFAULT false;
ALTER TABLE benefit_allowances ADD COLUMN IF NOT EXISTS expired_at TIMESTAMP;
ALTER TABLE benefit_allowances ADD COLUMN IF NOT EXISTS used_quantity INTEGER DEFAULT 0;
ALTER TABLE benefit_allowances ADD COLUMN IF NOT EXISTS remaining_quantity INTEGER DEFAULT 0;
ALTER TABLE benefit_allowances ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;
ALTER TABLE benefit_allowances ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

-- benefit_usage
ALTER TABLE benefit_usage ADD COLUMN IF NOT EXISTS allowance_id VARCHAR(36);
ALTER TABLE benefit_usage ADD COLUMN IF NOT EXISTS vendor_id VARCHAR(36);
ALTER TABLE benefit_usage ADD COLUMN IF NOT EXISTS benefit_type TEXT;
ALTER TABLE benefit_usage ADD COLUMN IF NOT EXISTS quantity_used INTEGER DEFAULT 1;
ALTER TABLE benefit_usage ADD COLUMN IF NOT EXISTS used_at TIMESTAMP;
ALTER TABLE benefit_usage ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE benefit_usage ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- fulfillment_tasks
ALTER TABLE fulfillment_tasks ADD COLUMN IF NOT EXISTS vendor_id VARCHAR(36);
ALTER TABLE fulfillment_tasks ADD COLUMN IF NOT EXISTS business_id VARCHAR(36);
ALTER TABLE fulfillment_tasks ADD COLUMN IF NOT EXISTS task_type TEXT;
ALTER TABLE fulfillment_tasks ADD COLUMN IF NOT EXISTS task_name TEXT;
ALTER TABLE fulfillment_tasks ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE fulfillment_tasks ADD COLUMN IF NOT EXISTS source_type TEXT;
ALTER TABLE fulfillment_tasks ADD COLUMN IF NOT EXISTS source_id VARCHAR(36);
ALTER TABLE fulfillment_tasks ADD COLUMN IF NOT EXISTS vendor_notes TEXT;
ALTER TABLE fulfillment_tasks ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
ALTER TABLE fulfillment_tasks ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 0;
ALTER TABLE fulfillment_tasks ADD COLUMN IF NOT EXISTS is_priority BOOLEAN DEFAULT false;
ALTER TABLE fulfillment_tasks ADD COLUMN IF NOT EXISTS due_date TIMESTAMP;
ALTER TABLE fulfillment_tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP;
ALTER TABLE fulfillment_tasks ADD COLUMN IF NOT EXISTS metadata JSONB;
ALTER TABLE fulfillment_tasks ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;
ALTER TABLE fulfillment_tasks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

-- ala_carte_services
ALTER TABLE ala_carte_services ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE ala_carte_services ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE ala_carte_services ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE ala_carte_services ADD COLUMN IF NOT EXISTS base_price_in_cents INTEGER;
ALTER TABLE ala_carte_services ADD COLUMN IF NOT EXISTS stripe_product_id TEXT;
ALTER TABLE ala_carte_services ADD COLUMN IF NOT EXISTS stripe_price_id TEXT;
ALTER TABLE ala_carte_services ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
ALTER TABLE ala_carte_services ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- ala_carte_purchases
ALTER TABLE ala_carte_purchases ADD COLUMN IF NOT EXISTS vendor_id VARCHAR(36);
ALTER TABLE ala_carte_purchases ADD COLUMN IF NOT EXISTS business_id VARCHAR(36);
ALTER TABLE ala_carte_purchases ADD COLUMN IF NOT EXISTS service_id VARCHAR(36);
ALTER TABLE ala_carte_purchases ADD COLUMN IF NOT EXISTS price_in_cents INTEGER;
ALTER TABLE ala_carte_purchases ADD COLUMN IF NOT EXISTS platform_fee_in_cents INTEGER;
ALTER TABLE ala_carte_purchases ADD COLUMN IF NOT EXISTS stripe_checkout_session_id TEXT;
ALTER TABLE ala_carte_purchases ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT;
ALTER TABLE ala_carte_purchases ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
ALTER TABLE ala_carte_purchases ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE ala_carte_purchases ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;
ALTER TABLE ala_carte_purchases ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

-- availability_slots
ALTER TABLE availability_slots ADD COLUMN IF NOT EXISTS provider_type TEXT;
ALTER TABLE availability_slots ADD COLUMN IF NOT EXISTS provider_id VARCHAR(36);
ALTER TABLE availability_slots ADD COLUMN IF NOT EXISTS day_of_week INTEGER;
ALTER TABLE availability_slots ADD COLUMN IF NOT EXISTS start_time TEXT;
ALTER TABLE availability_slots ADD COLUMN IF NOT EXISTS end_time TEXT;
ALTER TABLE availability_slots ADD COLUMN IF NOT EXISTS is_recurring BOOLEAN DEFAULT true;
ALTER TABLE availability_slots ADD COLUMN IF NOT EXISTS specific_date TEXT;
ALTER TABLE availability_slots ADD COLUMN IF NOT EXISTS is_available BOOLEAN DEFAULT true;
ALTER TABLE availability_slots ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- weekly_availability
ALTER TABLE weekly_availability ADD COLUMN IF NOT EXISTS provider_type TEXT;
ALTER TABLE weekly_availability ADD COLUMN IF NOT EXISTS provider_id VARCHAR(36);
ALTER TABLE weekly_availability ADD COLUMN IF NOT EXISTS staff_member_id VARCHAR(36);
ALTER TABLE weekly_availability ADD COLUMN IF NOT EXISTS day_of_week INTEGER;
ALTER TABLE weekly_availability ADD COLUMN IF NOT EXISTS start_time TEXT;
ALTER TABLE weekly_availability ADD COLUMN IF NOT EXISTS end_time TEXT;
ALTER TABLE weekly_availability ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
ALTER TABLE weekly_availability ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;
ALTER TABLE weekly_availability ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

-- provider_blocks
ALTER TABLE provider_blocks ADD COLUMN IF NOT EXISTS provider_type TEXT;
ALTER TABLE provider_blocks ADD COLUMN IF NOT EXISTS provider_id VARCHAR(36);
ALTER TABLE provider_blocks ADD COLUMN IF NOT EXISTS staff_member_id VARCHAR(36);
ALTER TABLE provider_blocks ADD COLUMN IF NOT EXISTS start_at TIMESTAMP;
ALTER TABLE provider_blocks ADD COLUMN IF NOT EXISTS end_at TIMESTAMP;
ALTER TABLE provider_blocks ADD COLUMN IF NOT EXISTS block_type TEXT DEFAULT 'custom';
ALTER TABLE provider_blocks ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE provider_blocks ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE provider_blocks ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;
ALTER TABLE provider_blocks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

-- booking_holds
ALTER TABLE booking_holds ADD COLUMN IF NOT EXISTS provider_type TEXT;
ALTER TABLE booking_holds ADD COLUMN IF NOT EXISTS provider_id VARCHAR(36);
ALTER TABLE booking_holds ADD COLUMN IF NOT EXISTS staff_member_id VARCHAR(36);
ALTER TABLE booking_holds ADD COLUMN IF NOT EXISTS user_id VARCHAR(36);
ALTER TABLE booking_holds ADD COLUMN IF NOT EXISTS service_id VARCHAR(36);
ALTER TABLE booking_holds ADD COLUMN IF NOT EXISTS service_name TEXT;
ALTER TABLE booking_holds ADD COLUMN IF NOT EXISTS service_price_cents INTEGER;
ALTER TABLE booking_holds ADD COLUMN IF NOT EXISTS duration_minutes INTEGER;
ALTER TABLE booking_holds ADD COLUMN IF NOT EXISTS hold_date TEXT;
ALTER TABLE booking_holds ADD COLUMN IF NOT EXISTS start_time TEXT;
ALTER TABLE booking_holds ADD COLUMN IF NOT EXISTS end_time TEXT;
ALTER TABLE booking_holds ADD COLUMN IF NOT EXISTS start_at TIMESTAMP;
ALTER TABLE booking_holds ADD COLUMN IF NOT EXISTS end_at TIMESTAMP;
ALTER TABLE booking_holds ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
ALTER TABLE booking_holds ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;
ALTER TABLE booking_holds ADD COLUMN IF NOT EXISTS converted_to_booking_id VARCHAR(36);
ALTER TABLE booking_holds ADD COLUMN IF NOT EXISTS converted_to_booking_type TEXT;
ALTER TABLE booking_holds ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;
ALTER TABLE booking_holds ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

-- scheduling
ALTER TABLE scheduling ADD COLUMN IF NOT EXISTS provider_type TEXT;
ALTER TABLE scheduling ADD COLUMN IF NOT EXISTS provider_id VARCHAR(36);
ALTER TABLE scheduling ADD COLUMN IF NOT EXISTS client_id VARCHAR(36);
ALTER TABLE scheduling ADD COLUMN IF NOT EXISTS service_id VARCHAR(36);
ALTER TABLE scheduling ADD COLUMN IF NOT EXISTS service_name TEXT;
ALTER TABLE scheduling ADD COLUMN IF NOT EXISTS service_price INTEGER;
ALTER TABLE scheduling ADD COLUMN IF NOT EXISTS scheduled_date TEXT;
ALTER TABLE scheduling ADD COLUMN IF NOT EXISTS scheduled_time TEXT;
ALTER TABLE scheduling ADD COLUMN IF NOT EXISTS duration_minutes INTEGER;
ALTER TABLE scheduling ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE scheduling ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
ALTER TABLE scheduling ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;
ALTER TABLE scheduling ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

-- refund_requests
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS requester_id VARCHAR(36);
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS requester_type TEXT;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS target_type TEXT;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS target_id VARCHAR(36);
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS amount INTEGER;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS admin_notes TEXT;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS admin_notified_at TIMESTAMP;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS resolved_by VARCHAR(36);
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

-- feed_posts
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS author_id VARCHAR(36);
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS author_type TEXT;
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS post_type TEXT DEFAULT 'text';
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS post_intent TEXT DEFAULT 'social';
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS display_layout TEXT;
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS feed_surface TEXT;
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS content TEXT;
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS media_url TEXT;
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS media_type TEXT;
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS thumbnail_url TEXT;
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS media_width INTEGER;
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS media_height INTEGER;
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS aspect_ratio DOUBLE PRECISION;
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS tagged_business_id VARCHAR(36);
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS tagged_photographer_id VARCHAR(36);
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS product_id VARCHAR(36);
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS service_id VARCHAR(36);
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS photographer_service_id VARCHAR(36);
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS likes_count INTEGER DEFAULT 0;
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS comments_count INTEGER DEFAULT 0;
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

-- post_likes
ALTER TABLE post_likes ADD COLUMN IF NOT EXISTS post_id VARCHAR(36);
ALTER TABLE post_likes ADD COLUMN IF NOT EXISTS user_id VARCHAR(36);
ALTER TABLE post_likes ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- post_comments
ALTER TABLE post_comments ADD COLUMN IF NOT EXISTS post_id VARCHAR(36);
ALTER TABLE post_comments ADD COLUMN IF NOT EXISTS user_id VARCHAR(36);
ALTER TABLE post_comments ADD COLUMN IF NOT EXISTS content TEXT;
ALTER TABLE post_comments ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- pulse_engagements
ALTER TABLE pulse_engagements ADD COLUMN IF NOT EXISTS user_id VARCHAR(36);
ALTER TABLE pulse_engagements ADD COLUMN IF NOT EXISTS post_id VARCHAR(36);
ALTER TABLE pulse_engagements ADD COLUMN IF NOT EXISTS watch_time_ms INTEGER DEFAULT 0;
ALTER TABLE pulse_engagements ADD COLUMN IF NOT EXISTS completion_rate DOUBLE PRECISION DEFAULT 0;
ALTER TABLE pulse_engagements ADD COLUMN IF NOT EXISTS rewatch_count INTEGER DEFAULT 0;
ALTER TABLE pulse_engagements ADD COLUMN IF NOT EXISTS shared BOOLEAN DEFAULT false;
ALTER TABLE pulse_engagements ADD COLUMN IF NOT EXISTS saved BOOLEAN DEFAULT false;
ALTER TABLE pulse_engagements ADD COLUMN IF NOT EXISTS impression_at TIMESTAMP;
ALTER TABLE pulse_engagements ADD COLUMN IF NOT EXISTS last_interaction_at TIMESTAMP;
ALTER TABLE pulse_engagements ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;
ALTER TABLE pulse_engagements ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

-- post_distribution
ALTER TABLE post_distribution ADD COLUMN IF NOT EXISTS post_id VARCHAR(36);
ALTER TABLE post_distribution ADD COLUMN IF NOT EXISTS current_tier INTEGER DEFAULT 1;
ALTER TABLE post_distribution ADD COLUMN IF NOT EXISTS impressions_tier1 INTEGER DEFAULT 0;
ALTER TABLE post_distribution ADD COLUMN IF NOT EXISTS impressions_tier2 INTEGER DEFAULT 0;
ALTER TABLE post_distribution ADD COLUMN IF NOT EXISTS impressions_tier3 INTEGER DEFAULT 0;
ALTER TABLE post_distribution ADD COLUMN IF NOT EXISTS impressions_tier4 INTEGER DEFAULT 0;
ALTER TABLE post_distribution ADD COLUMN IF NOT EXISTS avg_watch_time_ms INTEGER DEFAULT 0;
ALTER TABLE post_distribution ADD COLUMN IF NOT EXISTS avg_completion_rate DOUBLE PRECISION DEFAULT 0;
ALTER TABLE post_distribution ADD COLUMN IF NOT EXISTS total_rewatches INTEGER DEFAULT 0;
ALTER TABLE post_distribution ADD COLUMN IF NOT EXISTS total_shares INTEGER DEFAULT 0;
ALTER TABLE post_distribution ADD COLUMN IF NOT EXISTS total_saves INTEGER DEFAULT 0;
ALTER TABLE post_distribution ADD COLUMN IF NOT EXISTS tier_advanced_at TIMESTAMP;
ALTER TABLE post_distribution ADD COLUMN IF NOT EXISTS cold_start_ends_at TIMESTAMP;
ALTER TABLE post_distribution ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
ALTER TABLE post_distribution ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;
ALTER TABLE post_distribution ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

-- user_interests
ALTER TABLE user_interests ADD COLUMN IF NOT EXISTS user_id VARCHAR(36);
ALTER TABLE user_interests ADD COLUMN IF NOT EXISTS interest_vector JSONB DEFAULT '{}'::jsonb;
ALTER TABLE user_interests ADD COLUMN IF NOT EXISTS recent_engagements JSONB DEFAULT '[]'::jsonb;
ALTER TABLE user_interests ADD COLUMN IF NOT EXISTS total_watched INTEGER DEFAULT 0;
ALTER TABLE user_interests ADD COLUMN IF NOT EXISTS total_skipped INTEGER DEFAULT 0;
ALTER TABLE user_interests ADD COLUMN IF NOT EXISTS total_shared INTEGER DEFAULT 0;
ALTER TABLE user_interests ADD COLUMN IF NOT EXISTS total_saved INTEGER DEFAULT 0;
ALTER TABLE user_interests ADD COLUMN IF NOT EXISTS last_updated TIMESTAMP;
ALTER TABLE user_interests ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- profile_comments
ALTER TABLE profile_comments ADD COLUMN IF NOT EXISTS target_type TEXT;
ALTER TABLE profile_comments ADD COLUMN IF NOT EXISTS target_id VARCHAR(36);
ALTER TABLE profile_comments ADD COLUMN IF NOT EXISTS user_id VARCHAR(36);
ALTER TABLE profile_comments ADD COLUMN IF NOT EXISTS content TEXT;
ALTER TABLE profile_comments ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- shipments
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS order_id VARCHAR(36);
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS business_id VARCHAR(36);
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS carrier TEXT;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS tracking_number TEXT;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'shipped';
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS shipped_at TIMESTAMP;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS estimated_delivery TIMESTAMP;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

-- audit_logs
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_id VARCHAR(36);
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_type TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS action TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS target_type TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS target_id VARCHAR(36);
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS before_state JSONB;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS after_state JSONB;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS metadata JSONB;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS ip_address TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_agent TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- user_blocks
ALTER TABLE user_blocks ADD COLUMN IF NOT EXISTS blocker_id VARCHAR(36);
ALTER TABLE user_blocks ADD COLUMN IF NOT EXISTS blocked_id VARCHAR(36);
ALTER TABLE user_blocks ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE user_blocks ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- message_reports
ALTER TABLE message_reports ADD COLUMN IF NOT EXISTS reporter_id VARCHAR(36);
ALTER TABLE message_reports ADD COLUMN IF NOT EXISTS message_id VARCHAR(36);
ALTER TABLE message_reports ADD COLUMN IF NOT EXISTS conversation_id VARCHAR(36);
ALTER TABLE message_reports ADD COLUMN IF NOT EXISTS reported_user_id VARCHAR(36);
ALTER TABLE message_reports ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE message_reports ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
ALTER TABLE message_reports ADD COLUMN IF NOT EXISTS admin_notes TEXT;
ALTER TABLE message_reports ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP;
ALTER TABLE message_reports ADD COLUMN IF NOT EXISTS resolved_by VARCHAR(36);
ALTER TABLE message_reports ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- influencer_profiles
ALTER TABLE influencer_profiles ADD COLUMN IF NOT EXISTS user_id VARCHAR(36);
ALTER TABLE influencer_profiles ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE influencer_profiles ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE influencer_profiles ADD COLUMN IF NOT EXISTS promo_code TEXT;
ALTER TABLE influencer_profiles ADD COLUMN IF NOT EXISTS instagram_url TEXT;
ALTER TABLE influencer_profiles ADD COLUMN IF NOT EXISTS tiktok_url TEXT;
ALTER TABLE influencer_profiles ADD COLUMN IF NOT EXISTS youtube_url TEXT;
ALTER TABLE influencer_profiles ADD COLUMN IF NOT EXISTS twitter_url TEXT;
ALTER TABLE influencer_profiles ADD COLUMN IF NOT EXISTS follower_count INTEGER DEFAULT 0;
ALTER TABLE influencer_profiles ADD COLUMN IF NOT EXISTS stripe_account_id TEXT;
ALTER TABLE influencer_profiles ADD COLUMN IF NOT EXISTS stripe_onboarding_complete BOOLEAN DEFAULT false;
ALTER TABLE influencer_profiles ADD COLUMN IF NOT EXISTS stripe_onboarding_url TEXT;
ALTER TABLE influencer_profiles ADD COLUMN IF NOT EXISTS total_earnings INTEGER DEFAULT 0;
ALTER TABLE influencer_profiles ADD COLUMN IF NOT EXISTS pending_earnings INTEGER DEFAULT 0;
ALTER TABLE influencer_profiles ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;
ALTER TABLE influencer_profiles ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

-- influencer_applications
ALTER TABLE influencer_applications ADD COLUMN IF NOT EXISTS user_id VARCHAR(36);
ALTER TABLE influencer_applications ADD COLUMN IF NOT EXISTS instagram_url TEXT;
ALTER TABLE influencer_applications ADD COLUMN IF NOT EXISTS tiktok_url TEXT;
ALTER TABLE influencer_applications ADD COLUMN IF NOT EXISTS youtube_url TEXT;
ALTER TABLE influencer_applications ADD COLUMN IF NOT EXISTS twitter_url TEXT;
ALTER TABLE influencer_applications ADD COLUMN IF NOT EXISTS follower_count INTEGER;
ALTER TABLE influencer_applications ADD COLUMN IF NOT EXISTS content_niche TEXT;
ALTER TABLE influencer_applications ADD COLUMN IF NOT EXISTS why_influencer TEXT;
ALTER TABLE influencer_applications ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
ALTER TABLE influencer_applications ADD COLUMN IF NOT EXISTS admin_notes TEXT;
ALTER TABLE influencer_applications ADD COLUMN IF NOT EXISTS reviewed_by VARCHAR(36);
ALTER TABLE influencer_applications ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP;
ALTER TABLE influencer_applications ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- influencer_campaigns
ALTER TABLE influencer_campaigns ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE influencer_campaigns ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE influencer_campaigns ADD COLUMN IF NOT EXISTS created_by_vendor_id VARCHAR(36);
ALTER TABLE influencer_campaigns ADD COLUMN IF NOT EXISTS created_by_admin_id VARCHAR(36);
ALTER TABLE influencer_campaigns ADD COLUMN IF NOT EXISTS payout_type TEXT;
ALTER TABLE influencer_campaigns ADD COLUMN IF NOT EXISTS flat_amount_cents INTEGER DEFAULT 0;
ALTER TABLE influencer_campaigns ADD COLUMN IF NOT EXISTS commission_bps INTEGER DEFAULT 0;
ALTER TABLE influencer_campaigns ADD COLUMN IF NOT EXISTS target_product_ids JSONB DEFAULT '[]'::jsonb;
ALTER TABLE influencer_campaigns ADD COLUMN IF NOT EXISTS target_service_ids JSONB DEFAULT '[]'::jsonb;
ALTER TABLE influencer_campaigns ADD COLUMN IF NOT EXISTS start_date TIMESTAMP;
ALTER TABLE influencer_campaigns ADD COLUMN IF NOT EXISTS end_date TIMESTAMP;
ALTER TABLE influencer_campaigns ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'draft';
ALTER TABLE influencer_campaigns ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;
ALTER TABLE influencer_campaigns ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

-- influencer_campaign_assignments
ALTER TABLE influencer_campaign_assignments ADD COLUMN IF NOT EXISTS campaign_id VARCHAR(36);
ALTER TABLE influencer_campaign_assignments ADD COLUMN IF NOT EXISTS influencer_id VARCHAR(36);
ALTER TABLE influencer_campaign_assignments ADD COLUMN IF NOT EXISTS negotiated_flat_amount_cents INTEGER;
ALTER TABLE influencer_campaign_assignments ADD COLUMN IF NOT EXISTS negotiated_commission_bps INTEGER;
ALTER TABLE influencer_campaign_assignments ADD COLUMN IF NOT EXISTS goals TEXT;
ALTER TABLE influencer_campaign_assignments ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'assigned';
ALTER TABLE influencer_campaign_assignments ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP;
ALTER TABLE influencer_campaign_assignments ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- influencer_referral_events
ALTER TABLE influencer_referral_events ADD COLUMN IF NOT EXISTS influencer_id VARCHAR(36);
ALTER TABLE influencer_referral_events ADD COLUMN IF NOT EXISTS campaign_id VARCHAR(36);
ALTER TABLE influencer_referral_events ADD COLUMN IF NOT EXISTS order_id VARCHAR(36);
ALTER TABLE influencer_referral_events ADD COLUMN IF NOT EXISTS order_group_id VARCHAR(36);
ALTER TABLE influencer_referral_events ADD COLUMN IF NOT EXISTS booking_id VARCHAR(36);
ALTER TABLE influencer_referral_events ADD COLUMN IF NOT EXISTS order_total_cents INTEGER DEFAULT 0;
ALTER TABLE influencer_referral_events ADD COLUMN IF NOT EXISTS commission_bps INTEGER DEFAULT 0;
ALTER TABLE influencer_referral_events ADD COLUMN IF NOT EXISTS commission_earned_cents INTEGER DEFAULT 0;
ALTER TABLE influencer_referral_events ADD COLUMN IF NOT EXISTS promo_code_used TEXT;
ALTER TABLE influencer_referral_events ADD COLUMN IF NOT EXISTS credited_at TIMESTAMP;
ALTER TABLE influencer_referral_events ADD COLUMN IF NOT EXISTS ledger_entry_id VARCHAR(36);
ALTER TABLE influencer_referral_events ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- influencer_earning_ledger
ALTER TABLE influencer_earning_ledger ADD COLUMN IF NOT EXISTS influencer_id VARCHAR(36);
ALTER TABLE influencer_earning_ledger ADD COLUMN IF NOT EXISTS source_type TEXT;
ALTER TABLE influencer_earning_ledger ADD COLUMN IF NOT EXISTS source_ref_id VARCHAR(36);
ALTER TABLE influencer_earning_ledger ADD COLUMN IF NOT EXISTS amount_cents INTEGER;
ALTER TABLE influencer_earning_ledger ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE influencer_earning_ledger ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
ALTER TABLE influencer_earning_ledger ADD COLUMN IF NOT EXISTS stripe_transfer_id TEXT;
ALTER TABLE influencer_earning_ledger ADD COLUMN IF NOT EXISTS payout_id VARCHAR(36);
ALTER TABLE influencer_earning_ledger ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;
ALTER TABLE influencer_earning_ledger ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP;

-- influencer_payouts
ALTER TABLE influencer_payouts ADD COLUMN IF NOT EXISTS influencer_id VARCHAR(36);
ALTER TABLE influencer_payouts ADD COLUMN IF NOT EXISTS amount_cents INTEGER;
ALTER TABLE influencer_payouts ADD COLUMN IF NOT EXISTS ledger_ids JSONB DEFAULT '[]'::jsonb;
ALTER TABLE influencer_payouts ADD COLUMN IF NOT EXISTS stripe_transfer_id TEXT;
ALTER TABLE influencer_payouts ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
ALTER TABLE influencer_payouts ADD COLUMN IF NOT EXISTS initiated_at TIMESTAMP;
ALTER TABLE influencer_payouts ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP;
ALTER TABLE influencer_payouts ADD COLUMN IF NOT EXISTS failed_at TIMESTAMP;
ALTER TABLE influencer_payouts ADD COLUMN IF NOT EXISTS failure_reason TEXT;

-- influencer_tracking_events
ALTER TABLE influencer_tracking_events ADD COLUMN IF NOT EXISTS influencer_id VARCHAR(36);
ALTER TABLE influencer_tracking_events ADD COLUMN IF NOT EXISTS campaign_id VARCHAR(36);
ALTER TABLE influencer_tracking_events ADD COLUMN IF NOT EXISTS event_type TEXT;
ALTER TABLE influencer_tracking_events ADD COLUMN IF NOT EXISTS attributed_user_id VARCHAR(36);
ALTER TABLE influencer_tracking_events ADD COLUMN IF NOT EXISTS order_id VARCHAR(36);
ALTER TABLE influencer_tracking_events ADD COLUMN IF NOT EXISTS order_total_cents INTEGER;
ALTER TABLE influencer_tracking_events ADD COLUMN IF NOT EXISTS utm_source TEXT;
ALTER TABLE influencer_tracking_events ADD COLUMN IF NOT EXISTS utm_medium TEXT;
ALTER TABLE influencer_tracking_events ADD COLUMN IF NOT EXISTS utm_campaign TEXT;
ALTER TABLE influencer_tracking_events ADD COLUMN IF NOT EXISTS ref_code TEXT;
ALTER TABLE influencer_tracking_events ADD COLUMN IF NOT EXISTS device_type TEXT;
ALTER TABLE influencer_tracking_events ADD COLUMN IF NOT EXISTS platform TEXT;
ALTER TABLE influencer_tracking_events ADD COLUMN IF NOT EXISTS user_agent TEXT;
ALTER TABLE influencer_tracking_events ADD COLUMN IF NOT EXISTS ip_address TEXT;
ALTER TABLE influencer_tracking_events ADD COLUMN IF NOT EXISTS points_awarded INTEGER DEFAULT 0;
ALTER TABLE influencer_tracking_events ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- influencer_attributions
ALTER TABLE influencer_attributions ADD COLUMN IF NOT EXISTS user_id VARCHAR(36);
ALTER TABLE influencer_attributions ADD COLUMN IF NOT EXISTS influencer_id VARCHAR(36);
ALTER TABLE influencer_attributions ADD COLUMN IF NOT EXISTS ref_code TEXT;
ALTER TABLE influencer_attributions ADD COLUMN IF NOT EXISTS utm_source TEXT;
ALTER TABLE influencer_attributions ADD COLUMN IF NOT EXISTS utm_medium TEXT;
ALTER TABLE influencer_attributions ADD COLUMN IF NOT EXISTS utm_campaign TEXT;
ALTER TABLE influencer_attributions ADD COLUMN IF NOT EXISTS first_click_at TIMESTAMP;
ALTER TABLE influencer_attributions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;
ALTER TABLE influencer_attributions ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- influencer_tiers
ALTER TABLE influencer_tiers ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE influencer_tiers ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE influencer_tiers ADD COLUMN IF NOT EXISTS min_conversion_rate DOUBLE PRECISION;
ALTER TABLE influencer_tiers ADD COLUMN IF NOT EXISTS max_conversion_rate DOUBLE PRECISION;
ALTER TABLE influencer_tiers ADD COLUMN IF NOT EXISTS commission_bps INTEGER;
ALTER TABLE influencer_tiers ADD COLUMN IF NOT EXISTS point_multiplier DOUBLE PRECISION DEFAULT 1.0;
ALTER TABLE influencer_tiers ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;
ALTER TABLE influencer_tiers ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
ALTER TABLE influencer_tiers ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- influencer_stats
ALTER TABLE influencer_stats ADD COLUMN IF NOT EXISTS influencer_id VARCHAR(36);
ALTER TABLE influencer_stats ADD COLUMN IF NOT EXISTS total_clicks INTEGER DEFAULT 0;
ALTER TABLE influencer_stats ADD COLUMN IF NOT EXISTS total_downloads INTEGER DEFAULT 0;
ALTER TABLE influencer_stats ADD COLUMN IF NOT EXISTS total_signups INTEGER DEFAULT 0;
ALTER TABLE influencer_stats ADD COLUMN IF NOT EXISTS total_first_purchases INTEGER DEFAULT 0;
ALTER TABLE influencer_stats ADD COLUMN IF NOT EXISTS total_repeat_purchases INTEGER DEFAULT 0;
ALTER TABLE influencer_stats ADD COLUMN IF NOT EXISTS total_purchases INTEGER DEFAULT 0;
ALTER TABLE influencer_stats ADD COLUMN IF NOT EXISTS total_revenue_cents INTEGER DEFAULT 0;
ALTER TABLE influencer_stats ADD COLUMN IF NOT EXISTS conversion_rate DOUBLE PRECISION DEFAULT 0;
ALTER TABLE influencer_stats ADD COLUMN IF NOT EXISTS rolling_avg_conversion_rate DOUBLE PRECISION DEFAULT 0;
ALTER TABLE influencer_stats ADD COLUMN IF NOT EXISTS rolling_window_post_count INTEGER DEFAULT 0;
ALTER TABLE influencer_stats ADD COLUMN IF NOT EXISTS rolling_window_start_date TIMESTAMP;
ALTER TABLE influencer_stats ADD COLUMN IF NOT EXISTS total_points INTEGER DEFAULT 0;
ALTER TABLE influencer_stats ADD COLUMN IF NOT EXISTS total_commission_earned_cents INTEGER DEFAULT 0;
ALTER TABLE influencer_stats ADD COLUMN IF NOT EXISTS pending_commission_cents INTEGER DEFAULT 0;
ALTER TABLE influencer_stats ADD COLUMN IF NOT EXISTS tier_id VARCHAR(36);
ALTER TABLE influencer_stats ADD COLUMN IF NOT EXISTS tier_changed_at TIMESTAMP;
ALTER TABLE influencer_stats ADD COLUMN IF NOT EXISTS previous_tier_id VARCHAR(36);
ALTER TABLE influencer_stats ADD COLUMN IF NOT EXISTS tier_change_flag BOOLEAN DEFAULT false;
ALTER TABLE influencer_stats ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

-- influencer_point_config
ALTER TABLE influencer_point_config ADD COLUMN IF NOT EXISTS event_type TEXT;
ALTER TABLE influencer_point_config ADD COLUMN IF NOT EXISTS points_awarded INTEGER;
ALTER TABLE influencer_point_config ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE influencer_point_config ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
ALTER TABLE influencer_point_config ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

-- search_index
ALTER TABLE search_index ADD COLUMN IF NOT EXISTS entity_type TEXT;
ALTER TABLE search_index ADD COLUMN IF NOT EXISTS entity_id VARCHAR(36);
ALTER TABLE search_index ADD COLUMN IF NOT EXISTS user_id VARCHAR(36);
ALTER TABLE search_index ADD COLUMN IF NOT EXISTS parent_type TEXT;
ALTER TABLE search_index ADD COLUMN IF NOT EXISTS parent_id VARCHAR(36);
ALTER TABLE search_index ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE search_index ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE search_index ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE search_index ADD COLUMN IF NOT EXISTS tags TEXT[];
ALTER TABLE search_index ADD COLUMN IF NOT EXISTS known_for JSONB DEFAULT '[]'::jsonb;
ALTER TABLE search_index ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE search_index ADD COLUMN IF NOT EXISTS state TEXT;
ALTER TABLE search_index ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;
ALTER TABLE search_index ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
ALTER TABLE search_index ADD COLUMN IF NOT EXISTS rating INTEGER DEFAULT 0;
ALTER TABLE search_index ADD COLUMN IF NOT EXISTS review_count INTEGER DEFAULT 0;
ALTER TABLE search_index ADD COLUMN IF NOT EXISTS price_cents INTEGER;
ALTER TABLE search_index ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE search_index ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
ALTER TABLE search_index ADD COLUMN IF NOT EXISTS has_active_subscription BOOLEAN DEFAULT false;
ALTER TABLE search_index ADD COLUMN IF NOT EXISTS is_demo BOOLEAN DEFAULT false;
ALTER TABLE search_index ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

-- feed_engagement_events
ALTER TABLE feed_engagement_events ADD COLUMN IF NOT EXISTS user_id VARCHAR(36);
ALTER TABLE feed_engagement_events ADD COLUMN IF NOT EXISTS post_id VARCHAR(36);
ALTER TABLE feed_engagement_events ADD COLUMN IF NOT EXISTS event_type TEXT;
ALTER TABLE feed_engagement_events ADD COLUMN IF NOT EXISTS metadata JSONB;
ALTER TABLE feed_engagement_events ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- user_saved_posts
ALTER TABLE user_saved_posts ADD COLUMN IF NOT EXISTS user_id VARCHAR(36);
ALTER TABLE user_saved_posts ADD COLUMN IF NOT EXISTS post_id VARCHAR(36);
ALTER TABLE user_saved_posts ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- sponsored_posts
ALTER TABLE sponsored_posts ADD COLUMN IF NOT EXISTS vendor_id VARCHAR(36);
ALTER TABLE sponsored_posts ADD COLUMN IF NOT EXISTS post_id VARCHAR(36);
ALTER TABLE sponsored_posts ADD COLUMN IF NOT EXISTS budget_cents INTEGER;
ALTER TABLE sponsored_posts ADD COLUMN IF NOT EXISTS spent_cents INTEGER DEFAULT 0;
ALTER TABLE sponsored_posts ADD COLUMN IF NOT EXISTS cpm INTEGER;
ALTER TABLE sponsored_posts ADD COLUMN IF NOT EXISTS impressions INTEGER DEFAULT 0;
ALTER TABLE sponsored_posts ADD COLUMN IF NOT EXISTS clicks INTEGER DEFAULT 0;
ALTER TABLE sponsored_posts ADD COLUMN IF NOT EXISTS start_date TIMESTAMP;
ALTER TABLE sponsored_posts ADD COLUMN IF NOT EXISTS end_date TIMESTAMP;
ALTER TABLE sponsored_posts ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
ALTER TABLE sponsored_posts ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT;
ALTER TABLE sponsored_posts ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;
ALTER TABLE sponsored_posts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

-- vendor_email_sequence
ALTER TABLE vendor_email_sequence ADD COLUMN IF NOT EXISTS vendor_id VARCHAR(36);
ALTER TABLE vendor_email_sequence ADD COLUMN IF NOT EXISTS sequence_step INTEGER DEFAULT 0;
ALTER TABLE vendor_email_sequence ADD COLUMN IF NOT EXISTS last_sent_at TIMESTAMP;
ALTER TABLE vendor_email_sequence ADD COLUMN IF NOT EXISTS completed BOOLEAN DEFAULT false;
ALTER TABLE vendor_email_sequence ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;

-- moderation_queue
ALTER TABLE moderation_queue ADD COLUMN IF NOT EXISTS reporter_id VARCHAR(36);
ALTER TABLE moderation_queue ADD COLUMN IF NOT EXISTS target_id VARCHAR(36);
ALTER TABLE moderation_queue ADD COLUMN IF NOT EXISTS target_type TEXT;
ALTER TABLE moderation_queue ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE moderation_queue ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
ALTER TABLE moderation_queue ADD COLUMN IF NOT EXISTS admin_action TEXT;
ALTER TABLE moderation_queue ADD COLUMN IF NOT EXISTS admin_notes TEXT;
ALTER TABLE moderation_queue ADD COLUMN IF NOT EXISTS reviewed_by VARCHAR(36);
ALTER TABLE moderation_queue ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP;
ALTER TABLE moderation_queue ADD COLUMN IF NOT EXISTS flag_count INTEGER DEFAULT 1;
ALTER TABLE moderation_queue ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;


-- businesses.is_multi_staff (independent-booking multi-staff service businesses)
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS is_multi_staff BOOLEAN NOT NULL DEFAULT false;
