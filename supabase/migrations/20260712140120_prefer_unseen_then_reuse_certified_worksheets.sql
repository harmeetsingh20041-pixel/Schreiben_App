-- Keep certified practice available after a learner has exhausted every
-- released revision for an exact CEFR/topic context. The original Phase 12H
-- selector excluded all previously used revisions, which made the certified
-- bank finite for each learner and returned control to provider generation.
--
-- Eligibility remains unchanged: the student must be a current workspace
-- member, the template must match the exact grammar topic and frozen worksheet
-- level, the revision must be released, and its immutable review/release/hash
-- chain must still be backed by active qualified certifier/releaser records.
-- Selection now prefers unseen revisions and, only after exhaustion, rotates
-- through the least-used revision with least-recent use as the tie-breaker.

create or replace function public.select_released_worksheet_template_internal(
  target_workspace_id uuid,
  target_student_id uuid,
  target_grammar_topic_id uuid,
  target_level text
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select revision.id
  from app_private.practice_worksheet_template_revisions revision
  join app_private.practice_worksheet_templates template
    on template.id = revision.template_id
  join app_private.practice_worksheet_template_reviews review
    on review.revision_id = revision.id
   and review.decision = 'approved'
   and review.content_sha256 = revision.content_sha256
  join app_private.practice_worksheet_template_releases release
    on release.revision_id = revision.id
   and release.review_id = review.id
   and release.content_sha256 = revision.content_sha256
  join app_private.practice_worksheet_bank_reviewers reviewer
    on reviewer.user_id = review.reviewer_id
   and reviewer.active
   and reviewer.can_certify
   and reviewer.verified_at <= review.reviewed_at
   and (reviewer.expires_at is null or reviewer.expires_at > review.reviewed_at)
  join app_private.practice_worksheet_bank_reviewers releaser
    on releaser.user_id = release.released_by
   and releaser.active
   and releaser.can_release
   and releaser.verified_at <= release.released_at
   and (releaser.expires_at is null or releaser.expires_at > release.released_at)
  left join lateral (
    select
      count(*)::bigint as use_count,
      max(coalesce(
        prior_assignment.completed_at,
        prior_assignment.started_at,
        prior_assignment.assigned_at
      )) as last_used_at
    from public.student_practice_assignments prior_assignment
    join public.practice_tests prior_test
      on prior_test.id = prior_assignment.practice_test_id
    where prior_assignment.workspace_id = target_workspace_id
      and prior_assignment.student_id = target_student_id
      and prior_test.worksheet_template_revision_id = revision.id
  ) usage on true
  where target_workspace_id is not null
    and target_student_id is not null
    and target_grammar_topic_id is not null
    and target_level in ('A1', 'A2', 'B1', 'B2')
    and revision.state = 'released'
    and template.grammar_topic_id = target_grammar_topic_id
    and template.level = target_level
    and exists (
      select 1
      from public.workspace_members membership
      where membership.workspace_id = target_workspace_id
        and membership.user_id = target_student_id
        and membership.role = 'student'
    )
  order by
    case when usage.use_count = 0 then 0 else 1 end,
    usage.use_count,
    usage.last_used_at nulls first,
    case revision.difficulty when 'easy' then 1 when 'medium' then 2 else 3 end,
    release.released_at,
    revision.id
  limit 1;
$$;

revoke all on function public.select_released_worksheet_template_internal(
  uuid, uuid, uuid, text
)
from public, anon, authenticated, service_role;
grant execute on function public.select_released_worksheet_template_internal(
  uuid, uuid, uuid, text
)
to service_role;

comment on function public.select_released_worksheet_template_internal(
  uuid, uuid, uuid, text
) is
  'Service-only exact workspace, student, topic, and CEFR selector. Prefers unseen released certified revisions, then rotates least-used and least-recently-used revisions after exhaustion; clone-time hash verification remains mandatory.';
