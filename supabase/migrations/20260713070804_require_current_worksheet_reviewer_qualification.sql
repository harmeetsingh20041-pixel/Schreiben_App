-- A canonical worksheet attestation is reusable only while both the reviewer
-- and releaser remain qualified now. Earlier bank functions correctly checked
-- that each qualification covered its historical attestation timestamp, but
-- several reuse and coverage paths did not also compare expires_at with the
-- current transaction time. An expired qualification could therefore keep a
-- revision selectable, cloneable, or eligible as the replacement that allowed
-- another revision/attester to be withdrawn.
--
-- Preserve every immutable review, release, clone, assignment, and attempt.
-- This migration changes only the current-eligibility predicates at the final
-- database boundary. `now()` is deliberately transaction-stable, so one bank
-- decision cannot change halfway through a transaction.

create or replace function app_private.practice_test_canonical_revision_is_current(
  target_practice_test_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select
      test.worksheet_template_revision_id is null
      or exists (
        select 1
        from app_private.practice_worksheet_template_revisions revision
        join app_private.practice_worksheet_template_reviews review
          on review.revision_id = revision.id
         and review.decision = 'approved'
         and review.content_sha256 = revision.content_sha256
        join app_private.practice_worksheet_template_releases release
          on release.id = test.worksheet_template_release_id
         and release.revision_id = revision.id
         and release.review_id = review.id
         and release.content_sha256 = revision.content_sha256
        join app_private.practice_worksheet_bank_reviewers reviewer
          on reviewer.user_id = review.reviewer_id
         and reviewer.active
         and reviewer.can_certify
         and reviewer.verified_at <= review.reviewed_at
         and (
           reviewer.expires_at is null
           or reviewer.expires_at > greatest(review.reviewed_at, now())
         )
        join app_private.practice_worksheet_bank_reviewers releaser
          on releaser.user_id = release.released_by
         and releaser.active
         and releaser.can_release
         and releaser.verified_at <= release.released_at
         and (
           releaser.expires_at is null
           or releaser.expires_at > greatest(release.released_at, now())
         )
        where revision.id = test.worksheet_template_revision_id
          and revision.state = 'released'
          and revision.content_sha256 = test.template_content_sha256
          and revision.content_sha256 =
            app_private.practice_worksheet_template_revision_sha256(
              revision.id
            )
          and not exists (
            select 1
            from app_private.practice_worksheet_template_withdrawals withdrawal
            where withdrawal.revision_id = revision.id
          )
      )
    from public.practice_tests test
    where test.id = target_practice_test_id
  ), false);
$$;

revoke all on function app_private.practice_test_canonical_revision_is_current(uuid)
from public, anon, authenticated, service_role;

comment on function app_private.practice_test_canonical_revision_is_current(uuid)
is
  'Private current-bank predicate. Canonical clones remain reusable only while the immutable release is active, non-withdrawn, hash-bound, and both historical attesters are still currently qualified.';

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
   and (
     reviewer.expires_at is null
     or reviewer.expires_at > greatest(review.reviewed_at, now())
   )
  join app_private.practice_worksheet_bank_reviewers releaser
    on releaser.user_id = release.released_by
   and releaser.active
   and releaser.can_release
   and releaser.verified_at <= release.released_at
   and (
     releaser.expires_at is null
     or releaser.expires_at > greatest(release.released_at, now())
   )
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
    and revision.content_sha256 =
      app_private.practice_worksheet_template_revision_sha256(revision.id)
    and not exists (
      select 1
      from app_private.practice_worksheet_template_withdrawals withdrawal
      where withdrawal.revision_id = revision.id
    )
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
  'Service-only exact-context selector. It excludes withdrawn, superseded, hash-invalid, or no-longer-currently-qualified canonical worksheet attestations before preferring unseen material and then safe reuse.';

-- The remaining six definitions are intentionally patched from their latest
-- complete bodies. They are large concurrency-sensitive functions, and this
-- fail-closed replacement preserves every lock, replay, hash, and privilege
-- invariant from the immediately preceding migrations. Each expected source
-- predicate must occur exactly once; schema drift aborts instead of silently
-- leaving one path on the historical-only eligibility rule.

do $migration$
declare
  function_definition text;
  patched_definition text;
  old_fragment text;
  new_fragment text;
  occurrence_count integer;
begin
  select pg_get_functiondef(
    'app_private.practice_topic_level_gate_satisfied(uuid,text,uuid)'::regprocedure
  ) into function_definition;
  patched_definition := function_definition;

  old_fragment := 'reviewer.expires_at > review.reviewed_at';
  new_fragment :=
    'reviewer.expires_at > greatest(review.reviewed_at, now())';
  occurrence_count := (
    length(patched_definition) - length(replace(patched_definition, old_fragment, ''))
  ) / length(old_fragment);
  if occurrence_count <> 1 then
    raise exception using
      errcode = '55000',
      message = 'practice_topic_level_gate_reviewer_expiry_patch_mismatch';
  end if;
  patched_definition := replace(
    patched_definition,
    old_fragment,
    new_fragment
  );

  old_fragment := 'releaser.expires_at > release.released_at';
  new_fragment :=
    'releaser.expires_at > greatest(release.released_at, now())';
  occurrence_count := (
    length(patched_definition) - length(replace(patched_definition, old_fragment, ''))
  ) / length(old_fragment);
  if occurrence_count <> 1 then
    raise exception using
      errcode = '55000',
      message = 'practice_topic_level_gate_releaser_expiry_patch_mismatch';
  end if;
  patched_definition := replace(
    patched_definition,
    old_fragment,
    new_fragment
  );

  old_fragment :=
    'where template.grammar_topic_id = target_grammar_topic_id
        and template.level = target_worksheet_level';
  new_fragment :=
    'where template.grammar_topic_id = target_grammar_topic_id
        and template.level = target_worksheet_level
        and revision.content_sha256 =
          app_private.practice_worksheet_template_revision_sha256(revision.id)
        and not exists (
          select 1
          from app_private.practice_worksheet_template_withdrawals withdrawal
          where withdrawal.revision_id = revision.id
        )';
  occurrence_count := (
    length(patched_definition) - length(replace(patched_definition, old_fragment, ''))
  ) / length(old_fragment);
  if occurrence_count <> 1 then
    raise exception using
      errcode = '55000',
      message = 'practice_topic_level_gate_revision_integrity_patch_mismatch';
  end if;
  patched_definition := replace(
    patched_definition,
    old_fragment,
    new_fragment
  );

  execute patched_definition;
end;
$migration$;

revoke all on function app_private.practice_topic_level_gate_satisfied(
  uuid, text, uuid
)
from public, anon, authenticated, service_role;

comment on function app_private.practice_topic_level_gate_satisfied(
  uuid, text, uuid
) is
  'Private low-CEFR level-fit gate. A canonical worksheet satisfies the gate only while its reviewer and releaser qualifications remain current; an explicit cycle opt-in remains independently valid.';

do $migration$
declare
  function_definition text;
  patched_definition text;
  old_fragment text;
  new_fragment text;
  occurrence_count integer;
begin
  select pg_get_functiondef(
    'app_private.publish_certified_worksheet_template(text,jsonb,uuid,uuid,jsonb,text,text)'::regprocedure
  ) into function_definition;
  patched_definition := function_definition;

  old_fragment := 'reviewer.expires_at > selected_review.reviewed_at';
  new_fragment :=
    'reviewer.expires_at > greatest(selected_review.reviewed_at, now())';
  occurrence_count := (
    length(patched_definition) - length(replace(patched_definition, old_fragment, ''))
  ) / length(old_fragment);
  if occurrence_count <> 1 then
    raise exception using
      errcode = '55000',
      message = 'worksheet_bank_publish_replay_reviewer_expiry_patch_mismatch';
  end if;
  patched_definition := replace(
    patched_definition,
    old_fragment,
    new_fragment
  );

  old_fragment := 'releaser.expires_at > selected_release.released_at';
  new_fragment :=
    'releaser.expires_at > greatest(selected_release.released_at, now())';
  occurrence_count := (
    length(patched_definition) - length(replace(patched_definition, old_fragment, ''))
  ) / length(old_fragment);
  if occurrence_count <> 1 then
    raise exception using
      errcode = '55000',
      message = 'worksheet_bank_publish_replay_releaser_expiry_patch_mismatch';
  end if;
  patched_definition := replace(
    patched_definition,
    old_fragment,
    new_fragment
  );

  execute patched_definition;
end;
$migration$;

revoke all on function app_private.publish_certified_worksheet_template(
  text, jsonb, uuid, uuid, jsonb, text, text
)
from public, anon, authenticated, service_role;

comment on function app_private.publish_certified_worksheet_template(
  text, jsonb, uuid, uuid, jsonb, text, text
) is
  'Postgres-only immutable canonical worksheet publication. New attestations and exact existing-revision replays both require reviewer and releaser qualifications that remain current now.';

do $migration$
declare
  function_definition text;
  patched_definition text;
  old_fragment text;
  new_fragment text;
  occurrence_count integer;
begin
  select pg_get_functiondef(
    'app_private.clone_released_worksheet_template(uuid,uuid)'::regprocedure
  ) into function_definition;
  patched_definition := function_definition;

  old_fragment := 'reviewer.expires_at > selected_review.reviewed_at';
  new_fragment :=
    'reviewer.expires_at > greatest(selected_review.reviewed_at, now())';
  occurrence_count := (
    length(patched_definition) - length(replace(patched_definition, old_fragment, ''))
  ) / length(old_fragment);
  if occurrence_count <> 1 then
    raise exception using
      errcode = '55000',
      message = 'worksheet_bank_clone_reviewer_expiry_patch_mismatch';
  end if;
  patched_definition := replace(
    patched_definition,
    old_fragment,
    new_fragment
  );

  old_fragment := 'releaser.expires_at > selected_release.released_at';
  new_fragment :=
    'releaser.expires_at > greatest(selected_release.released_at, now())';
  occurrence_count := (
    length(patched_definition) - length(replace(patched_definition, old_fragment, ''))
  ) / length(old_fragment);
  if occurrence_count <> 1 then
    raise exception using
      errcode = '55000',
      message = 'worksheet_bank_clone_releaser_expiry_patch_mismatch';
  end if;
  patched_definition := replace(
    patched_definition,
    old_fragment,
    new_fragment
  );

  execute patched_definition;
end;
$migration$;

revoke all on function app_private.clone_released_worksheet_template(uuid, uuid)
from public, anon, authenticated, service_role;

comment on function app_private.clone_released_worksheet_template(uuid, uuid)
is
  'Private immutable bank clone operation. Hash and release bindings plus both historical and current reviewer/releaser qualification are required for new and idempotently reused clones.';

do $migration$
declare
  function_definition text;
  patched_definition text;
  old_fragment text;
  new_fragment text;
  occurrence_count integer;
begin
  select pg_get_functiondef(
    'app_private.publish_certified_worksheet_packet(text,text,jsonb)'::regprocedure
  ) into function_definition;
  patched_definition := function_definition;

  old_fragment := 'reviewer.expires_at > selected_reviewed_at';
  new_fragment :=
    'reviewer.expires_at > greatest(selected_reviewed_at, now())';
  occurrence_count := (
    length(patched_definition) - length(replace(patched_definition, old_fragment, ''))
  ) / length(old_fragment);
  if occurrence_count <> 1 then
    raise exception using
      errcode = '55000',
      message = 'worksheet_packet_reviewer_expiry_patch_mismatch';
  end if;
  patched_definition := replace(
    patched_definition,
    old_fragment,
    new_fragment
  );

  old_fragment := 'releaser.expires_at > selected_release_authorized_at';
  new_fragment :=
    'releaser.expires_at > greatest(selected_release_authorized_at, now())';
  occurrence_count := (
    length(patched_definition) - length(replace(patched_definition, old_fragment, ''))
  ) / length(old_fragment);
  if occurrence_count <> 1 then
    raise exception using
      errcode = '55000',
      message = 'worksheet_packet_releaser_expiry_patch_mismatch';
  end if;
  patched_definition := replace(
    patched_definition,
    old_fragment,
    new_fragment
  );

  execute patched_definition;
end;
$migration$;

revoke all on function app_private.publish_certified_worksheet_packet(
  text, text, jsonb
)
from public, anon, authenticated, service_role;

comment on function app_private.publish_certified_worksheet_packet(
  text, text, jsonb
) is
  'Postgres-only immutable worksheet packet publication. Manifest attestation timestamps cannot revive a reviewer or releaser qualification that has expired by transaction time.';

do $migration$
declare
  function_definition text;
  patched_definition text;
  old_fragment text;
  new_fragment text;
  occurrence_count integer;
begin
  select pg_get_functiondef(
    'app_private.withdraw_released_worksheet_template(uuid,integer,text,uuid,text)'::regprocedure
  ) into function_definition;
  patched_definition := function_definition;

  old_fragment :=
    'replacement_reviewer.expires_at > replacement_review.reviewed_at';
  new_fragment :=
    'replacement_reviewer.expires_at > greatest(replacement_review.reviewed_at, now())';
  occurrence_count := (
    length(patched_definition) - length(replace(patched_definition, old_fragment, ''))
  ) / length(old_fragment);
  if occurrence_count <> 1 then
    raise exception using
      errcode = '55000',
      message = 'worksheet_bank_withdrawal_reviewer_expiry_patch_mismatch';
  end if;
  patched_definition := replace(
    patched_definition,
    old_fragment,
    new_fragment
  );

  old_fragment :=
    'replacement_releaser.expires_at > replacement_release.released_at';
  new_fragment :=
    'replacement_releaser.expires_at > greatest(replacement_release.released_at, now())';
  occurrence_count := (
    length(patched_definition) - length(replace(patched_definition, old_fragment, ''))
  ) / length(old_fragment);
  if occurrence_count <> 1 then
    raise exception using
      errcode = '55000',
      message = 'worksheet_bank_withdrawal_releaser_expiry_patch_mismatch';
  end if;
  patched_definition := replace(
    patched_definition,
    old_fragment,
    new_fragment
  );

  execute patched_definition;
end;
$migration$;

revoke all on function app_private.withdraw_released_worksheet_template(
  uuid, integer, text, uuid, text
)
from public, anon, authenticated, service_role;

comment on function app_private.withdraw_released_worksheet_template(
  uuid, integer, text, uuid, text
) is
  'Postgres-only retry-safe canonical worksheet withdrawal. The actor and exact distinct replacement must be currently qualified, and exact audit replays remain idempotent.';

do $migration$
declare
  function_definition text;
  patched_definition text;
  old_fragment text;
  new_fragment text;
  occurrence_count integer;
begin
  select pg_get_functiondef(
    'app_private.guard_worksheet_bank_reviewer_coverage()'::regprocedure
  ) into function_definition;
  patched_definition := function_definition;

  old_fragment := 'reviewer.expires_at > review.reviewed_at';
  new_fragment :=
    'reviewer.expires_at > greatest(review.reviewed_at, now())';
  occurrence_count := (
    length(patched_definition) - length(replace(patched_definition, old_fragment, ''))
  ) / length(old_fragment);
  if occurrence_count <> 1 then
    raise exception using
      errcode = '55000',
      message = 'worksheet_bank_coverage_reviewer_expiry_patch_mismatch';
  end if;
  patched_definition := replace(
    patched_definition,
    old_fragment,
    new_fragment
  );

  old_fragment := 'releaser.expires_at > release.released_at';
  new_fragment :=
    'releaser.expires_at > greatest(release.released_at, now())';
  occurrence_count := (
    length(patched_definition) - length(replace(patched_definition, old_fragment, ''))
  ) / length(old_fragment);
  if occurrence_count <> 1 then
    raise exception using
      errcode = '55000',
      message = 'worksheet_bank_coverage_releaser_expiry_patch_mismatch';
  end if;
  patched_definition := replace(
    patched_definition,
    old_fragment,
    new_fragment
  );

  old_fragment := 'end > candidate_review.reviewed_at';
  new_fragment :=
    'end > greatest(candidate_review.reviewed_at, now())';
  occurrence_count := (
    length(patched_definition) - length(replace(patched_definition, old_fragment, ''))
  ) / length(old_fragment);
  if occurrence_count <> 1 then
    raise exception using
      errcode = '55000',
      message = 'worksheet_bank_coverage_candidate_reviewer_expiry_patch_mismatch';
  end if;
  patched_definition := replace(
    patched_definition,
    old_fragment,
    new_fragment
  );

  old_fragment := 'end > candidate_release.released_at';
  new_fragment :=
    'end > greatest(candidate_release.released_at, now())';
  occurrence_count := (
    length(patched_definition) - length(replace(patched_definition, old_fragment, ''))
  ) / length(old_fragment);
  if occurrence_count <> 1 then
    raise exception using
      errcode = '55000',
      message = 'worksheet_bank_coverage_candidate_releaser_expiry_patch_mismatch';
  end if;
  patched_definition := replace(
    patched_definition,
    old_fragment,
    new_fragment
  );

  execute patched_definition;
end;
$migration$;

revoke all on function app_private.guard_worksheet_bank_reviewer_coverage()
from public, anon, authenticated, service_role;

comment on function app_private.guard_worksheet_bank_reviewer_coverage() is
  'Private reviewer-mutation guard. Serialized eligibility changes preserve one released, non-withdrawn, hash-valid revision whose reviewer and releaser qualifications remain current now for each affected exact topic/CEFR context.';
