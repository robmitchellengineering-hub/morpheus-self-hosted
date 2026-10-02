-- Morpheus — complete DDL for a fresh database, matching
-- server/prisma/schema.prisma exactly.
--
-- REGENERATE, do not hand-edit. This file is produced by:
--
--   cd server
--   npx prisma migrate diff --from-empty \
--     --to-schema-datamodel prisma/schema.prisma --script
--
-- Why this file exists instead of plain `prisma migrate deploy`: this repo has
-- no server/prisma/migrations directory. Migrations are hand-run SQL (see
-- KNOWN-HAZARDS.md H8), so a fresh self-host needs one script that produces the
-- whole schema. This is that script.
--
-- It was hand-written until 2026-09-19, and had drifted badly: 26 of the 52
-- tables and NONE of the 21 deck_* tables, so a database bootstrapped from it
-- came up without any Command Deck tables at all. Generating it from the schema
-- removes the drift by construction.
--
-- Run once, in full, against a fresh database — the Supabase SQL editor, or
-- `psql "$DATABASE_URL" -f server/prisma/manual-supabase-init.sql`.
--
-- If you later start using `prisma migrate dev`, baseline this database first
-- (`prisma migrate resolve --applied <name>`) so Prisma does not try to
-- recreate these tables.
--
-- No pgcrypto/extension is required: Prisma generates UUIDs client-side, so
-- these tables carry no gen_random_uuid() default, exactly as Prisma's own
-- generated DDL does not.

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT,
    "role" TEXT NOT NULL DEFAULT 'user',
    "google_id" TEXT,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "otp_code" TEXT,
    "otp_expires" TIMESTAMP(3),
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,
    "credit_balance" DECIMAL(14,4) NOT NULL DEFAULT 200,
    "billing_exempt" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_settings" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "ai_mode" TEXT NOT NULL DEFAULT 'default',
    "ai_base_url" TEXT,
    "ai_api_key" TEXT,
    "ai_model" TEXT,
    "planner_model" TEXT,
    "coder_model" TEXT,
    "reviewer_model" TEXT,
    "diagnosis_model" TEXT,
    "connections" TEXT,
    "tts_mode" TEXT NOT NULL DEFAULT 'default',
    "tts_engine" TEXT NOT NULL DEFAULT 'elevenlabs',
    "tts_api_key" TEXT,
    "tts_voice_id" TEXT,
    "tts_endpoint" TEXT,
    "personality_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_connections" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "scope" TEXT,
    "refresh_token" TEXT,
    "expires_at" TIMESTAMP(3),
    "refresh_token_expires_at" TIMESTAMP(3),
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "github_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "google_drive_connections" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "drive_email" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "scope" TEXT,
    "refresh_token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3),
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "google_drive_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deck_google_connections" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "google_email" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "scope" TEXT,
    "refresh_token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3),
    "backup_folder_id" TEXT,
    "last_backup_at" TIMESTAMP(3),
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deck_google_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_console_connections" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "gsc_email" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "scope" TEXT,
    "refresh_token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3),
    "property" TEXT,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "search_console_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_maintenance_policies" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "scan_enabled" BOOLEAN NOT NULL DEFAULT false,
    "day_of_month" INTEGER NOT NULL DEFAULT 1,
    "hour_utc" INTEGER NOT NULL DEFAULT 3,
    "apply_plugins" BOOLEAN NOT NULL DEFAULT false,
    "apply_themes" BOOLEAN NOT NULL DEFAULT false,
    "apply_core_minor" BOOLEAN NOT NULL DEFAULT false,
    "allow_core_major_manual" BOOLEAN NOT NULL DEFAULT true,
    "last_scan_at" TIMESTAMP(3),
    "last_result" TEXT,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_maintenance_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'init',
    "compile_target" TEXT NOT NULL DEFAULT 'source',
    "project_type" TEXT NOT NULL DEFAULT 'frontend',
    "polish_ui" BOOLEAN NOT NULL DEFAULT false,
    "context_summary" TEXT,
    "context_summary_message_count" INTEGER NOT NULL DEFAULT 0,
    "github_repo" TEXT,
    "github_token" TEXT,
    "synced_commit" TEXT,
    "storage_mode" TEXT NOT NULL DEFAULT 'postgres',
    "drive_folder_id" TEXT,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_files" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "file_url" TEXT,
    "language" TEXT NOT NULL DEFAULT 'text',
    "drive_file_id" TEXT,
    "drive_modified_time" TIMESTAMP(3),
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_snapshots" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "label" TEXT,
    "files" TEXT,
    "file_url" TEXT,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_records" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "action_type" TEXT NOT NULL,
    "credits" INTEGER NOT NULL DEFAULT 1,
    "project_id" TEXT,
    "project_name" TEXT,
    "metadata" TEXT,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_events" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "role" TEXT,
    "provider" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "credits_charged" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "project_id" TEXT,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_catalog_entries" (
    "id" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "provider" TEXT,
    "input_price_per_m" DOUBLE PRECISION,
    "output_price_per_m" DOUBLE PRECISION,
    "markup_multiplier" DOUBLE PRECISION NOT NULL DEFAULT 2.0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_catalog_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_transactions" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "credits" DECIMAL(14,4) NOT NULL,
    "amount_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "intended_net_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "stripe_session_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'paid',
    "is_first_purchase" BOOLEAN NOT NULL DEFAULT false,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_by_id" TEXT,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "admin_audit_log" (
    "id" TEXT NOT NULL,
    "admin_id" TEXT,
    "action" TEXT NOT NULL,
    "details" TEXT,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_tasks" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "maintenance_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "templates" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "project_id" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "long_description" TEXT,
    "author_name" TEXT,
    "author_id" TEXT,
    "files" TEXT NOT NULL,
    "artifact_files" TEXT,
    "icon" TEXT,
    "screenshots" TEXT,
    "compile_target" TEXT NOT NULL DEFAULT 'source',
    "tags" TEXT,
    "category" TEXT NOT NULL DEFAULT 'general',
    "install_count" INTEGER NOT NULL DEFAULT 0,
    "file_count" INTEGER NOT NULL DEFAULT 0,
    "price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "stripe_product_id" TEXT,
    "stripe_price_id" TEXT,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchases" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "template_id" TEXT,
    "template_name" TEXT,
    "buyer_id" TEXT NOT NULL,
    "buyer_email" TEXT,
    "seller_id" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "platform_cut" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "seller_cut" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "stripe_session_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'paid',
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "donations" (
    "id" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "donor_email" TEXT,
    "stripe_session_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'paid',
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "donations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'feature',
    "message" TEXT NOT NULL,
    "email" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backend_configs" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "custom_domain" TEXT,
    "api_keys" TEXT,
    "deploy_platform" TEXT,
    "deploy_url" TEXT,
    "deploy_status" TEXT,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "backend_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rebuild_docs" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "content_size" INTEGER NOT NULL DEFAULT 0,
    "file_url" TEXT,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rebuild_docs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "self_dev_manuals" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "content_size" INTEGER NOT NULL DEFAULT 0,
    "file_url" TEXT,
    "trigger" TEXT,
    "source_hash" TEXT,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "self_dev_manuals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "self_dev_features" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "steps" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "scope_policy" TEXT,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "self_dev_features_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "self_dev_decisions" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "ref" TEXT,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "self_dev_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "updates_plans" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "feedback_count" INTEGER NOT NULL DEFAULT 0,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "updates_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_snapshots" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "items" TEXT NOT NULL,
    "summary" TEXT,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cost_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_assets" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'image',
    "source" TEXT NOT NULL DEFAULT 'url',
    "url" TEXT NOT NULL,
    "preview_url" TEXT,
    "repo_path" TEXT,
    "alt" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "size" INTEGER,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plugin_connections" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'wordpress',
    "site_url" TEXT NOT NULL,
    "webhook_secret" TEXT NOT NULL,
    "repo" TEXT,
    "meta" TEXT,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plugin_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "widget_tokens" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "token_prefix" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "label" TEXT,
    "scopes" TEXT NOT NULL DEFAULT 'chat,deploy,store',
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "last_used_at" TIMESTAMP(3),
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "widget_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- Per-app capability grants (lib/appCapabilityGrants.js): one user's approval
-- that one generated app may use one named capability against that user's own
-- Google Drive connection. token_hash is sha256(full token) — the token itself is
-- never stored. Migration for existing databases:
-- server/prisma/selfdev-app-capability-grants.sql.
CREATE TABLE "app_capability_grants" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "token_prefix" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "label" TEXT,
    "capabilities" TEXT NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "last_used_at" TIMESTAMP(3),
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_capability_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_auth_requests" (
    "id" TEXT NOT NULL,
    "device_code" TEXT NOT NULL,
    "user_code" TEXT NOT NULL,
    "client_label" TEXT NOT NULL,
    "scopes" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approved_by_id" TEXT,
    "issued_token_id" TEXT,
    "pending_token" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_auth_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_tokens" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "token_prefix" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "scopes" TEXT NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "last_used_at" TIMESTAMP(3),
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deck_jarvis_messages" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deck_jarvis_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deck_jarvis_memory" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "folded_message_count" INTEGER NOT NULL DEFAULT 0,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deck_jarvis_memory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deck_dump_items" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deck_dump_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deck_people" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "color" TEXT NOT NULL,
    "is_self" BOOLEAN NOT NULL DEFAULT false,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deck_people_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deck_tasks" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "owner_person_id" TEXT,
    "energy" TEXT NOT NULL DEFAULT 'any',
    "done" BOOLEAN NOT NULL DEFAULT false,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deck_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deck_consignment_items" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "item" TEXT NOT NULL,
    "consignor" TEXT NOT NULL,
    "phone" TEXT,
    "price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "date_in" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sold" BOOLEAN NOT NULL DEFAULT false,
    "photo_url" TEXT,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deck_consignment_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deck_repair_jobs" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "customer" TEXT NOT NULL,
    "phone" TEXT,
    "item" TEXT NOT NULL,
    "notes" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'waiting',
    "photo_url" TEXT,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deck_repair_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deck_repair_files" (
    "id" TEXT NOT NULL,
    "repair_job_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "file_url" TEXT NOT NULL,
    "is_image" BOOLEAN NOT NULL DEFAULT false,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deck_repair_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deck_murbah_opportunities" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "note" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'idea',
    "booking_date" TIMESTAMP(3),
    "calendar_event_id" TEXT,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deck_murbah_opportunities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deck_inbox_items" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "from_name" TEXT NOT NULL,
    "from_email" TEXT,
    "message" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'new',
    "external_id" TEXT,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deck_inbox_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deck_gmail_seen_messages" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deck_gmail_seen_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deck_strategy_notes" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deck_strategy_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deck_knowledge_notes" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deck_knowledge_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deck_life_streams" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "stream_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'needs_work',
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deck_life_streams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deck_life_stream_notes" (
    "id" TEXT NOT NULL,
    "life_stream_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deck_life_stream_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deck_energy_log_entries" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "level" TEXT NOT NULL,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deck_energy_log_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deck_focus_entries" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "text" TEXT NOT NULL,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deck_focus_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deck_widget_instances" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "widget_key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deck_widget_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deck_widget_builds" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "widget_key" TEXT,
    "action" TEXT NOT NULL DEFAULT 'build',
    "status" TEXT NOT NULL DEFAULT 'planning',
    "step_index" INTEGER NOT NULL DEFAULT 0,
    "step_count" INTEGER NOT NULL DEFAULT 0,
    "step_title" TEXT,
    "message" TEXT,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deck_widget_builds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deck_business_profiles" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "shop_name" TEXT,
    "tagline" TEXT,
    "contact_email" TEXT,
    "business_context" TEXT,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deck_business_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_google_id_key" ON "users"("google_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_settings_created_by_id_key" ON "user_settings"("created_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "github_connections_created_by_id_key" ON "github_connections"("created_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "google_drive_connections_created_by_id_key" ON "google_drive_connections"("created_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "deck_google_connections_created_by_id_key" ON "deck_google_connections"("created_by_id");
CREATE UNIQUE INDEX "search_console_connections_created_by_id_key" ON "search_console_connections"("created_by_id");
CREATE UNIQUE INDEX "site_maintenance_policies_project_id_key" ON "site_maintenance_policies"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_files_project_id_path_key" ON "project_files"("project_id", "path");

-- CreateIndex
CREATE INDEX "usage_events_created_by_id_idx" ON "usage_events"("created_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "model_catalog_entries_model_id_key" ON "model_catalog_entries"("model_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_transactions_stripe_session_id_key" ON "credit_transactions"("stripe_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchases_stripe_session_id_key" ON "purchases"("stripe_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "donations_stripe_session_id_key" ON "donations"("stripe_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "backend_configs_project_id_key" ON "backend_configs"("project_id");

-- CreateIndex
CREATE INDEX "self_dev_decisions_project_id_created_date_idx" ON "self_dev_decisions"("project_id", "created_date");

-- CreateIndex
CREATE INDEX "project_assets_project_id_created_date_idx" ON "project_assets"("project_id", "created_date");

-- CreateIndex
CREATE UNIQUE INDEX "plugin_connections_project_id_kind_key" ON "plugin_connections"("project_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "widget_tokens_token_hash_key" ON "widget_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "widget_tokens_project_id_idx" ON "widget_tokens"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "app_capability_grants_token_hash_key" ON "app_capability_grants"("token_hash");

-- CreateIndex
CREATE INDEX "app_capability_grants_project_id_idx" ON "app_capability_grants"("project_id");

-- CreateIndex
CREATE INDEX "app_capability_grants_created_by_id_idx" ON "app_capability_grants"("created_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "device_auth_requests_device_code_key" ON "device_auth_requests"("device_code");

-- CreateIndex
CREATE UNIQUE INDEX "device_auth_requests_user_code_key" ON "device_auth_requests"("user_code");

-- CreateIndex
CREATE UNIQUE INDEX "device_tokens_token_hash_key" ON "device_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "device_tokens_created_by_id_idx" ON "device_tokens"("created_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "deck_jarvis_memory_created_by_id_key" ON "deck_jarvis_memory"("created_by_id");

-- CreateIndex
CREATE INDEX "deck_repair_files_repair_job_id_idx" ON "deck_repair_files"("repair_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "deck_gmail_seen_messages_created_by_id_external_id_key" ON "deck_gmail_seen_messages"("created_by_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "deck_life_streams_created_by_id_stream_key_key" ON "deck_life_streams"("created_by_id", "stream_key");

-- CreateIndex
CREATE INDEX "deck_life_stream_notes_life_stream_id_idx" ON "deck_life_stream_notes"("life_stream_id");

-- CreateIndex
CREATE UNIQUE INDEX "deck_energy_log_entries_created_by_id_date_key" ON "deck_energy_log_entries"("created_by_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "deck_focus_entries_created_by_id_date_key" ON "deck_focus_entries"("created_by_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "deck_widget_instances_created_by_id_widget_key_key" ON "deck_widget_instances"("created_by_id", "widget_key");

-- CreateIndex
CREATE UNIQUE INDEX "deck_business_profiles_created_by_id_key" ON "deck_business_profiles"("created_by_id");

-- AddForeignKey
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_connections" ADD CONSTRAINT "github_connections_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "google_drive_connections" ADD CONSTRAINT "google_drive_connections_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deck_google_connections" ADD CONSTRAINT "deck_google_connections_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "search_console_connections" ADD CONSTRAINT "search_console_connections_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "site_maintenance_policies" ADD CONSTRAINT "site_maintenance_policies_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "site_maintenance_policies" ADD CONSTRAINT "site_maintenance_policies_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_files" ADD CONSTRAINT "project_files_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_files" ADD CONSTRAINT "project_files_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_snapshots" ADD CONSTRAINT "file_snapshots_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_snapshots" ADD CONSTRAINT "file_snapshots_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_tasks" ADD CONSTRAINT "maintenance_tasks_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "templates" ADD CONSTRAINT "templates_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "templates" ADD CONSTRAINT "templates_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backend_configs" ADD CONSTRAINT "backend_configs_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backend_configs" ADD CONSTRAINT "backend_configs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rebuild_docs" ADD CONSTRAINT "rebuild_docs_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "self_dev_manuals" ADD CONSTRAINT "self_dev_manuals_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "self_dev_features" ADD CONSTRAINT "self_dev_features_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "self_dev_features" ADD CONSTRAINT "self_dev_features_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "self_dev_decisions" ADD CONSTRAINT "self_dev_decisions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "self_dev_decisions" ADD CONSTRAINT "self_dev_decisions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "updates_plans" ADD CONSTRAINT "updates_plans_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_snapshots" ADD CONSTRAINT "cost_snapshots_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_assets" ADD CONSTRAINT "project_assets_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_assets" ADD CONSTRAINT "project_assets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plugin_connections" ADD CONSTRAINT "plugin_connections_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plugin_connections" ADD CONSTRAINT "plugin_connections_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "widget_tokens" ADD CONSTRAINT "widget_tokens_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "widget_tokens" ADD CONSTRAINT "widget_tokens_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_capability_grants" ADD CONSTRAINT "app_capability_grants_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_capability_grants" ADD CONSTRAINT "app_capability_grants_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deck_jarvis_messages" ADD CONSTRAINT "deck_jarvis_messages_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deck_jarvis_memory" ADD CONSTRAINT "deck_jarvis_memory_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deck_dump_items" ADD CONSTRAINT "deck_dump_items_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deck_people" ADD CONSTRAINT "deck_people_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deck_tasks" ADD CONSTRAINT "deck_tasks_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deck_consignment_items" ADD CONSTRAINT "deck_consignment_items_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deck_repair_jobs" ADD CONSTRAINT "deck_repair_jobs_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deck_repair_files" ADD CONSTRAINT "deck_repair_files_repair_job_id_fkey" FOREIGN KEY ("repair_job_id") REFERENCES "deck_repair_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deck_repair_files" ADD CONSTRAINT "deck_repair_files_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deck_murbah_opportunities" ADD CONSTRAINT "deck_murbah_opportunities_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deck_inbox_items" ADD CONSTRAINT "deck_inbox_items_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deck_gmail_seen_messages" ADD CONSTRAINT "deck_gmail_seen_messages_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deck_strategy_notes" ADD CONSTRAINT "deck_strategy_notes_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deck_knowledge_notes" ADD CONSTRAINT "deck_knowledge_notes_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deck_life_streams" ADD CONSTRAINT "deck_life_streams_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deck_life_stream_notes" ADD CONSTRAINT "deck_life_stream_notes_life_stream_id_fkey" FOREIGN KEY ("life_stream_id") REFERENCES "deck_life_streams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deck_life_stream_notes" ADD CONSTRAINT "deck_life_stream_notes_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deck_energy_log_entries" ADD CONSTRAINT "deck_energy_log_entries_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deck_focus_entries" ADD CONSTRAINT "deck_focus_entries_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deck_widget_instances" ADD CONSTRAINT "deck_widget_instances_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deck_widget_builds" ADD CONSTRAINT "deck_widget_builds_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deck_business_profiles" ADD CONSTRAINT "deck_business_profiles_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- COLUMNS ADDED BY THE selfdev-*.sql MIGRATIONS AFTER THIS FILE WAS FIRST WRITTEN (2026-09-30)
--
-- This file is the bootstrap for a FRESH self-host. Until this block was added it did not carry these
-- columns: the sibling migrations were applied to production and never mirrored here, so a new install
-- came up missing SEVENTEEN of them and said nothing. Nothing broke loudly, because readers fall back to
-- the pre-migration shape (hazard H11) — the features simply did not persist on a fresh install, which is
-- exactly why it went unnoticed.
--
-- Additive and idempotent throughout, so re-running this file changes nothing. `verify-bootstrap-sql.mjs`
-- now fails the build if a selfdev migration adds a column this file does not have; that is what stops the
-- drift rather than a note asking someone to remember.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════

-- selfdev-add-file-synced-sha.sql — provenance for self-dev sync, so an upstream change can be told apart
-- from un-pushed local work instead of both looking like "the sha differs".
ALTER TABLE project_files ADD COLUMN IF NOT EXISTS synced_sha TEXT;
COMMENT ON COLUMN project_files.synced_sha IS
  'git blob sha of the upstream content this row was last synced from. NULL = provenance unknown (pre-dates this column, or a file created locally). Used by self-dev sync to tell an upstream change apart from un-pushed local work.';

-- selfdev-deck-crm-fields.sql — the CRM fields for repair jobs and consignment items.
alter table deck_consignment_items add column if not exists person_id text;
alter table deck_consignment_items add column if not exists fee double precision;
alter table deck_consignment_items add column if not exists sold_price double precision;
alter table deck_consignment_items add column if not exists sold_date timestamp(3);
alter table deck_consignment_items add column if not exists paid_out boolean not null default false;

alter table deck_repair_jobs add column if not exists person_id text;
alter table deck_repair_jobs add column if not exists quote double precision;
alter table deck_repair_jobs add column if not exists promised_date timestamp(3);
alter table deck_repair_jobs add column if not exists completed_date timestamp(3);
alter table deck_repair_jobs add column if not exists paid boolean not null default false;

-- selfdev-deck-fee-tiers.sql — the per-account consignment fee structure (percentages, not fractions).
alter table deck_business_profiles add column if not exists fee_threshold double precision;
alter table deck_business_profiles add column if not exists fee_rate_under double precision;
alter table deck_business_profiles add column if not exists fee_rate_over double precision;

-- selfdev-usage-event-observability.sql — what a brokered call was doing and how it ended.
alter table usage_events add column if not exists task text;
alter table usage_events add column if not exists status text;
alter table usage_events add column if not exists duration_ms integer;

-- add-deck-play.sql — the Asteroids reward: the play bank and the Morpheus-wide scoreboard.
-- The bank is a ledger (credited seconds minus seconds played), and deck_play_credits is unique on
-- (created_by_id, task_id) so a completed task can only ever pay once.
CREATE TABLE "deck_play_credits" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "task_id" TEXT,
    "seconds" INTEGER NOT NULL DEFAULT 60,
    "reason" TEXT NOT NULL DEFAULT 'task',
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deck_play_credits_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "deck_play_scores" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "initials" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "seconds_played" INTEGER NOT NULL,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deck_play_scores_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "deck_play_credits_created_by_id_task_id_key" ON "deck_play_credits"("created_by_id", "task_id");

CREATE INDEX "deck_play_scores_score_idx" ON "deck_play_scores"("score");

ALTER TABLE "deck_play_credits" ADD CONSTRAINT "deck_play_credits_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "deck_play_scores" ADD CONSTRAINT "deck_play_scores_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- add-deck-murbah-money.sql — the money half of the Murbah ledger (see that file for why).
alter table deck_murbah_opportunities add column if not exists price double precision;
alter table deck_murbah_opportunities add column if not exists deposit_paid boolean not null default false;
alter table deck_murbah_opportunities add column if not exists paid boolean not null default false;
alter table deck_murbah_opportunities add column if not exists end_date timestamp(3);
