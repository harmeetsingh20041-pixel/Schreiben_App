-- Queue recovery is invoked through the secret-protected recover-async-jobs
-- Edge Function by an external 30-second scheduler. Scheduled feedback release
-- remains a pure SQL cron job. The clean production database no longer needs
-- the networking extension or the legacy HTTP cron commands.

create table if not exists app_private.recovery_heartbeat (
  singleton boolean primary key default true check (singleton),
  last_seen_at timestamptz not null,
  last_request_id uuid not null,
  updated_at timestamptz not null default now()
);

alter table app_private.recovery_heartbeat enable row level security;
revoke all on table app_private.recovery_heartbeat
from public, anon, authenticated, service_role;

create or replace function api.record_recovery_heartbeat(target_request_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  heartbeat_time timestamptz := now();
begin
  perform app_private.assert_service_role();
  if target_request_id is null then
    raise exception using errcode = '22023', message = 'Recovery request id is required.';
  end if;
  insert into app_private.recovery_heartbeat (
    singleton,
    last_seen_at,
    last_request_id,
    updated_at
  ) values (true, heartbeat_time, target_request_id, heartbeat_time)
  on conflict (singleton) do update
  set last_seen_at = excluded.last_seen_at,
      last_request_id = excluded.last_request_id,
      updated_at = excluded.updated_at;
  return heartbeat_time;
end;
$$;

create or replace function api.get_recovery_health()
returns table (
  last_seen_at timestamptz,
  heartbeat_fresh boolean,
  pg_net_installed boolean,
  writing_queue_ready boolean,
  worksheet_generation_queue_ready boolean,
  worksheet_answer_queue_ready boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  latest timestamptz;
begin
  perform app_private.assert_service_role();
  select heartbeat.last_seen_at
  into latest
  from app_private.recovery_heartbeat heartbeat
  where heartbeat.singleton;

  return query
  select
    latest,
    coalesce(latest >= now() - interval '90 seconds', false),
    exists (select 1 from pg_extension where extname = 'pg_net'),
    exists (
      select 1 from pgmq.list_queues() queue
      where queue.queue_name = 'writing_evaluation'
    ),
    exists (
      select 1 from pgmq.list_queues() queue
      where queue.queue_name = 'worksheet_generation'
    ),
    exists (
      select 1 from pgmq.list_queues() queue
      where queue.queue_name = 'worksheet_answer_evaluation'
    );
end;
$$;

revoke all on function api.record_recovery_heartbeat(uuid)
from public, anon, authenticated;
revoke all on function api.get_recovery_health()
from public, anon, authenticated;
grant execute on function api.record_recovery_heartbeat(uuid) to service_role;
grant execute on function api.get_recovery_health() to service_role;

do $$
declare
  legacy_job text;
begin
  if to_regclass('cron.job') is not null then
    foreach legacy_job in array array[
      'process-due-feedback-every-5-minutes',
      'recover-writing-jobs-every-30-seconds',
      'recover-worksheet-generation-every-30-seconds',
      'recover-worksheet-evaluation-every-30-seconds'
    ]
    loop
      if exists (select 1 from cron.job where jobname = legacy_job) then
        perform cron.unschedule(legacy_job);
      end if;
    end loop;
  end if;
end;
$$;

drop extension if exists pg_net;
