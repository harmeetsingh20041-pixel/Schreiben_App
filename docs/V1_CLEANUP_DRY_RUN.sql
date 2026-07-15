-- V1 cleanup manifest and dry run only.
-- This file deliberately contains no fuzzy matching and no mutations of
-- application data. Add only identifiers that were individually reviewed.

begin;

create temporary table v1_cleanup_manifest (
  entity_type text not null check (entity_type in ('workspace', 'practice_test')),
  entity_id uuid not null,
  reason text not null check (length(btrim(reason)) between 8 and 240),
  approved_ticket text not null check (length(btrim(approved_ticket)) between 3 and 120),
  primary key (entity_type, entity_id)
) on commit drop;

-- Intentionally empty. Copy this file to a dated incident/release artifact and
-- insert explicit UUIDs only after the owner approves the exact manifest:
-- insert into v1_cleanup_manifest values
--   ('workspace', '<reviewed-uuid>', '<specific reason>', '<approval reference>');

-- The dry run must return the exact target plus its expected cascade surface.
select
  manifest.entity_type,
  manifest.entity_id,
  manifest.reason,
  manifest.approved_ticket,
  case manifest.entity_type
    when 'workspace' then workspace.name
    when 'practice_test' then worksheet.title
  end as current_label,
  case manifest.entity_type
    when 'workspace' then workspace.created_at
    when 'practice_test' then worksheet.created_at
  end as created_at,
  case manifest.entity_type
    when 'workspace' then (
      select count(*) from public.submissions submission
      where submission.workspace_id = manifest.entity_id
    )
    else (
      select count(*) from public.practice_test_attempts attempt
      where attempt.practice_test_id = manifest.entity_id
    )
  end as protected_history_count
from v1_cleanup_manifest manifest
left join public.workspaces workspace
  on manifest.entity_type = 'workspace'
 and workspace.id = manifest.entity_id
left join public.practice_tests worksheet
  on manifest.entity_type = 'practice_test'
 and worksheet.id = manifest.entity_id
order by manifest.entity_type, manifest.entity_id;

-- Missing IDs or any target with historical student work are blockers, not
-- implicit permission to broaden the match.
select
  manifest.*,
  case
    when manifest.entity_type = 'workspace'
      and not exists (
        select 1 from public.workspaces item where item.id = manifest.entity_id
      ) then 'missing'
    when manifest.entity_type = 'practice_test'
      and not exists (
        select 1 from public.practice_tests item where item.id = manifest.entity_id
      ) then 'missing'
    when manifest.entity_type = 'workspace'
      and exists (
        select 1 from public.submissions item where item.workspace_id = manifest.entity_id
      ) then 'blocked_has_submissions'
    when manifest.entity_type = 'practice_test'
      and exists (
        select 1 from public.practice_test_attempts item
        where item.practice_test_id = manifest.entity_id
      ) then 'blocked_has_attempts'
    else 'eligible_for_separate_approved_change'
  end as dry_run_status
from v1_cleanup_manifest manifest
order by manifest.entity_type, manifest.entity_id;

-- A dry run never commits or deletes. A separately reviewed change must repeat
-- the same manifest and assert its hash before any explicit-id mutation.
rollback;
