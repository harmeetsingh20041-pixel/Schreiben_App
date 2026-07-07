-- V1 cleanup dry run only.
-- This file intentionally contains SELECT statements only.
-- Do not convert these into DELETE/UPDATE statements without explicit approval.

-- Workspaces that may be test/demo/smoke data.
select id, name, created_at
from public.workspaces
where name ilike '%test%'
   or name ilike '%smoke%'
   or name ilike '%demo%'
   or name ilike '%phase%'
order by created_at desc;

-- Student-visible worksheet titles that look like fixtures.
select id, workspace_id, title, generation_source, quality_status, teacher_reviewed, created_at
from public.practice_tests
where title ilike '%phase%'
   or title ilike '%fixture%'
   or title ilike '%smoke%'
   or title ilike '%test%'
order by created_at desc;

-- Debugging practice assignment chains.
select
  spa.id,
  spa.workspace_id,
  spa.student_id,
  spa.grammar_topic_id,
  gt.name as grammar_topic_name,
  spa.source,
  spa.status,
  spa.practice_test_id,
  spa.previous_assignment_id,
  spa.repeat_number,
  spa.assigned_at,
  spa.completed_at
from public.student_practice_assignments spa
left join public.grammar_topics gt on gt.id = spa.grammar_topic_id
where spa.source in ('manual', 'adaptive_repeat')
   or spa.adaptive_reason is not null
order by spa.assigned_at desc;

-- Failed generation diagnostics for later review.
select assignment_id, stage, safe_status, developer_reason, created_at
from public.practice_generation_events
where safe_status = 'failed'
order by created_at desc
limit 100;

-- Counts only: potential cleanup categories.
select 'phase_or_fixture_worksheets' as category, count(*) as row_count
from public.practice_tests
where title ilike '%phase%'
   or title ilike '%fixture%'
   or title ilike '%smoke%'
   or title ilike '%test%'
union all
select 'test_like_workspaces' as category, count(*) as row_count
from public.workspaces
where name ilike '%test%'
   or name ilike '%smoke%'
   or name ilike '%demo%'
   or name ilike '%phase%'
union all
select 'failed_generation_events' as category, count(*) as row_count
from public.practice_generation_events
where safe_status = 'failed';
