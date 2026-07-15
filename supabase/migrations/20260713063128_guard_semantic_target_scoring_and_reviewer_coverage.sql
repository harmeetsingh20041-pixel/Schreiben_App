-- Preserve target-topic scoring and certified worksheet availability at the
-- final persistence boundary.
--
-- Provider and application validators already reject incidental-error credit
-- when punctuation or capitalization is the skill being assessed. The first
-- trigger makes that invariant durable against stale or privileged writers.
--
-- Reviewer eligibility is intentionally mutable so a qualification can be
-- revoked. The second trigger serializes every affected topic/CEFR context on
-- the same advisory key as canonical worksheet withdrawal and refuses a
-- change that would remove the final released, hash-valid, fully attested
-- worksheet. A non-blocking advisory acquisition avoids a row-lock/advisory-
-- lock inversion with the withdrawal function; callers retry SQLSTATE 40001.

-- Supabase's remote migration runner executes top-level statements without an
-- implicit transaction. The precondition lock must therefore be enclosed in
-- an explicit transaction so it remains held until both guards are installed.
begin;

create or replace function app_private.assert_semantic_review_integrity_precondition()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.practice_attempt_question_reviews review
    left join public.student_practice_assignments assignment
      on assignment.id = review.assignment_id
     and assignment.workspace_id = review.workspace_id
     and assignment.student_id = review.student_id
    left join public.practice_test_attempts attempt
      on attempt.id = review.attempt_id
     and attempt.assignment_id = assignment.id
     and attempt.workspace_id = assignment.workspace_id
     and attempt.student_id = assignment.student_id
     and attempt.practice_test_id = assignment.practice_test_id
    left join public.practice_test_questions question
      on question.id = review.question_id
     and question.practice_test_id = assignment.practice_test_id
    left join public.grammar_topics topic
      on topic.id = assignment.grammar_topic_id
    where assignment.id is null
      or attempt.id is null
      or question.id is null
      or topic.id is null
      or app_private.is_practice_question_locally_scorable(
        question.question_type,
        question.correct_answer,
        question.evaluation_mode,
        question.accepted_answers
      )
      or review.review_status not in (
        'correct',
        'partially_correct',
        'capitalization_issue',
        'minor_punctuation',
        'incorrect'
      )
      or review.max_points is distinct from 1.00
      or review.points_awarded is distinct from case review.review_status
        when 'correct' then 1.00
        when 'minor_punctuation' then 1.00
        when 'partially_correct' then 0.50
        when 'capitalization_issue' then 0.50
        when 'incorrect' then 0.00
        else null
      end
      or (
        topic.slug = 'punctuation'
        and review.review_status = 'minor_punctuation'
      )
      or (
        topic.slug = 'capitalization'
        and review.review_status = 'capitalization_issue'
      )
  ) then
    raise exception using
      errcode = '23514',
      message = 'semantic_review_integrity_precondition_failed';
  end if;
end;
$$;

revoke all on function app_private.assert_semantic_review_integrity_precondition()
from public, anon, authenticated, service_role;
grant execute on function app_private.assert_semantic_review_integrity_precondition()
to postgres;

-- Never hide or rewrite historical scoring damage during deployment. A
-- staging operator must first inspect and explicitly remediate any affected
-- attempt; clean production has no historical rows. Block concurrent legacy
-- writers across the precondition scan and trigger installation so an invalid
-- row cannot slip through the migration boundary.
lock table public.practice_attempt_question_reviews in share row exclusive mode;
select app_private.assert_semantic_review_integrity_precondition();

create or replace function app_private.guard_semantic_target_review_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_topic_slug text;
  expected_points numeric(6, 2);
begin
  select topic.slug
  into target_topic_slug
  from public.student_practice_assignments assignment
  join public.practice_test_attempts attempt
    on attempt.id = new.attempt_id
   and attempt.assignment_id = assignment.id
   and attempt.workspace_id = assignment.workspace_id
   and attempt.student_id = assignment.student_id
   and attempt.practice_test_id = assignment.practice_test_id
  join public.practice_test_questions question
    on question.id = new.question_id
   and question.practice_test_id = assignment.practice_test_id
   and not app_private.is_practice_question_locally_scorable(
     question.question_type,
     question.correct_answer,
     question.evaluation_mode,
     question.accepted_answers
   )
  join public.grammar_topics topic
    on topic.id = assignment.grammar_topic_id
  where assignment.id = new.assignment_id
    and assignment.workspace_id = new.workspace_id
    and assignment.student_id = new.student_id;

  if target_topic_slug is null then
    raise exception using
      errcode = '55000',
      message = 'semantic_review_target_context_invalid';
  end if;

  if (target_topic_slug = 'punctuation'
      and new.review_status = 'minor_punctuation')
    or (target_topic_slug = 'capitalization'
      and new.review_status = 'capitalization_issue')
  then
    raise exception using
      errcode = '22023',
      message = 'semantic_target_review_status_invalid';
  end if;

  expected_points := case new.review_status
    when 'correct' then 1.00
    when 'minor_punctuation' then 1.00
    when 'partially_correct' then 0.50
    when 'capitalization_issue' then 0.50
    when 'incorrect' then 0.00
    else null
  end;

  if expected_points is null
    or new.max_points is distinct from 1.00
    or new.points_awarded is distinct from expected_points
  then
    raise exception using
      errcode = '22023',
      message = 'semantic_review_status_points_invalid';
  end if;

  return new;
end;
$$;

revoke all on function app_private.guard_semantic_target_review_status()
from public, anon, authenticated, service_role;

drop trigger if exists practice_attempt_reviews_guard_target_status
on public.practice_attempt_question_reviews;
create trigger practice_attempt_reviews_guard_target_status
before insert or update of
  attempt_id,
  assignment_id,
  workspace_id,
  student_id,
  question_id,
  review_status,
  points_awarded,
  max_points
on public.practice_attempt_question_reviews
for each row
execute function app_private.guard_semantic_target_review_status();

create or replace function app_private.guard_worksheet_bank_reviewer_coverage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  coverage_context record;
  coverage_lock_key bigint;
begin
  if new.active is not distinct from old.active
    and new.can_certify is not distinct from old.can_certify
    and new.can_release is not distinct from old.can_release
    and new.verified_at is not distinct from old.verified_at
    and new.expires_at is not distinct from old.expires_at
  then
    return new;
  end if;

  -- Consider only contexts for which OLD currently participates in a fully
  -- selectable chain. Enabling or extending an ineligible reviewer therefore
  -- remains possible even when a different historical context is already
  -- being repaired.
  for coverage_context in
    select distinct
      template.grammar_topic_id,
      topic.slug as topic_slug,
      template.level
    from app_private.practice_worksheet_template_revisions revision
    join app_private.practice_worksheet_templates template
      on template.id = revision.template_id
    join public.grammar_topics topic
      on topic.id = template.grammar_topic_id
    join app_private.grammar_topic_contracts contract
      on contract.slug = topic.slug
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
     and (
       reviewer.expires_at is null
       or reviewer.expires_at > review.reviewed_at
     )
    join app_private.practice_worksheet_bank_reviewers releaser
      on releaser.user_id = release.released_by
     and releaser.active
     and releaser.can_release
     and releaser.verified_at <= release.released_at
     and (
       releaser.expires_at is null
       or releaser.expires_at > release.released_at
     )
    where revision.state = 'released'
      and (review.reviewer_id = old.user_id or release.released_by = old.user_id)
      and revision.content_sha256 =
        app_private.practice_worksheet_template_revision_sha256(revision.id)
      and not exists (
        select 1
        from app_private.practice_worksheet_template_withdrawals withdrawal
        where withdrawal.revision_id = revision.id
      )
    order by template.grammar_topic_id, topic.slug, template.level
  loop
    coverage_lock_key := hashtextextended(
      concat_ws(
        ':',
        'worksheet-bank-withdrawal-coverage',
        coverage_context.grammar_topic_id::text,
        coverage_context.topic_slug,
        coverage_context.level
      ),
      0
    );

    if not pg_try_advisory_xact_lock(coverage_lock_key) then
      raise exception using
        errcode = '40001',
        message = 'worksheet_bank_coverage_concurrent_change';
    end if;

    -- The reviewer row still contains OLD inside this BEFORE trigger. Replace
    -- only that row's eligibility values with NEW while evaluating the exact
    -- post-update state; every other attester is read from its current row.
    if not exists (
      select 1
      from app_private.practice_worksheet_template_revisions candidate_revision
      join app_private.practice_worksheet_templates candidate_template
        on candidate_template.id = candidate_revision.template_id
      join public.grammar_topics candidate_topic
        on candidate_topic.id = candidate_template.grammar_topic_id
      join app_private.grammar_topic_contracts candidate_contract
        on candidate_contract.slug = candidate_topic.slug
      join app_private.practice_worksheet_template_reviews candidate_review
        on candidate_review.revision_id = candidate_revision.id
       and candidate_review.decision = 'approved'
       and candidate_review.content_sha256 = candidate_revision.content_sha256
      join app_private.practice_worksheet_template_releases candidate_release
        on candidate_release.revision_id = candidate_revision.id
       and candidate_release.review_id = candidate_review.id
       and candidate_release.content_sha256 = candidate_revision.content_sha256
      join app_private.practice_worksheet_bank_reviewers candidate_reviewer
        on candidate_reviewer.user_id = candidate_review.reviewer_id
      join app_private.practice_worksheet_bank_reviewers candidate_releaser
        on candidate_releaser.user_id = candidate_release.released_by
      where candidate_revision.state = 'released'
        and candidate_template.grammar_topic_id =
          coverage_context.grammar_topic_id
        and candidate_topic.slug = coverage_context.topic_slug
        and candidate_contract.slug = coverage_context.topic_slug
        and candidate_template.level = coverage_context.level
        and case
          when candidate_reviewer.user_id = old.user_id then new.active
          else candidate_reviewer.active
        end
        and case
          when candidate_reviewer.user_id = old.user_id then new.can_certify
          else candidate_reviewer.can_certify
        end
        and case
          when candidate_reviewer.user_id = old.user_id then new.verified_at
          else candidate_reviewer.verified_at
        end <= candidate_review.reviewed_at
        and (
          case
            when candidate_reviewer.user_id = old.user_id then new.expires_at
            else candidate_reviewer.expires_at
          end is null
          or case
            when candidate_reviewer.user_id = old.user_id then new.expires_at
            else candidate_reviewer.expires_at
          end > candidate_review.reviewed_at
        )
        and case
          when candidate_releaser.user_id = old.user_id then new.active
          else candidate_releaser.active
        end
        and case
          when candidate_releaser.user_id = old.user_id then new.can_release
          else candidate_releaser.can_release
        end
        and case
          when candidate_releaser.user_id = old.user_id then new.verified_at
          else candidate_releaser.verified_at
        end <= candidate_release.released_at
        and (
          case
            when candidate_releaser.user_id = old.user_id then new.expires_at
            else candidate_releaser.expires_at
          end is null
          or case
            when candidate_releaser.user_id = old.user_id then new.expires_at
            else candidate_releaser.expires_at
          end > candidate_release.released_at
        )
        and candidate_revision.content_sha256 =
          app_private.practice_worksheet_template_revision_sha256(
            candidate_revision.id
          )
        and not exists (
          select 1
          from app_private.practice_worksheet_template_withdrawals withdrawal
          where withdrawal.revision_id = candidate_revision.id
        )
    ) then
      raise exception using
        errcode = '55000',
        message = 'worksheet_bank_last_active_coverage_required';
    end if;
  end loop;

  return new;
end;
$$;

revoke all on function app_private.guard_worksheet_bank_reviewer_coverage()
from public, anon, authenticated, service_role;

drop trigger if exists practice_worksheet_bank_reviewers_guard_coverage
on app_private.practice_worksheet_bank_reviewers;
create trigger practice_worksheet_bank_reviewers_guard_coverage
before update of active, can_certify, can_release, verified_at, expires_at
on app_private.practice_worksheet_bank_reviewers
for each row
execute function app_private.guard_worksheet_bank_reviewer_coverage();

comment on function app_private.guard_semantic_target_review_status() is
  'Private persistence guard: semantic rows bind to their exact attempt and use one canonical terminal status/points mapping; target punctuation or capitalization cannot receive incidental-error credit.';

comment on function app_private.guard_worksheet_bank_reviewer_coverage() is
  'Private reviewer-mutation guard: serialized eligibility changes must preserve one released, non-withdrawn, hash-valid, fully attested revision for every affected exact grammar-topic/CEFR context.';

commit;
