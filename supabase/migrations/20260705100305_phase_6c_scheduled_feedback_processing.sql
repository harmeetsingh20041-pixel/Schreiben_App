-- Phase 6C: enable Supabase-hosted scheduled feedback processing.
-- Secrets and cron job bodies are configured outside committed migrations so
-- PROCESS_FEEDBACK_SECRET is never stored in source control.

create extension if not exists pg_cron;
create extension if not exists pg_net;
