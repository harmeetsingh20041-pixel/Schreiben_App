-- Phase 6A feedback engine compatibility.
-- Keep old values valid while allowing an in-progress status and a
-- level-neutral "acceptable" line status for A1/A2/B1/B2.

alter table public.submissions
drop constraint if exists submissions_status_check;

alter table public.submissions
add constraint submissions_status_check
check (status in ('draft', 'submitted', 'checking', 'checked', 'needs_review', 'failed'));

alter table public.submission_lines
drop constraint if exists submission_lines_status_check;

alter table public.submission_lines
add constraint submission_lines_status_check
check (status in ('correct', 'acceptable_for_level', 'acceptable_a1_a2', 'minor_issue', 'major_issue', 'unclear'));

create index if not exists submission_lines_submission_line_number_idx
on public.submission_lines (submission_id, line_number);

create index if not exists submission_grammar_topics_submission_idx
on public.submission_grammar_topics (submission_id);
