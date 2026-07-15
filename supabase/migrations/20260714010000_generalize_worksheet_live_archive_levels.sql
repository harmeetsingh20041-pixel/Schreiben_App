-- Generalize the exact worksheet-live spend archive guard across A1-B2 while
-- preserving its fixed identities, service-only facade, terminal-only spend
-- semantics, and every existing cleanup/replay boundary. Public and api
-- signatures and ACLs are intentionally unchanged.

create or replace function app_private.archive_worksheet_live_canary_spend(
  target_workspace_id uuid,
  target_workspace_slug text,
  target_batch_id uuid,
  target_provider_assignment_id uuid,
  target_bank_assignment_id uuid
)
returns table (
  archived_reservation_count bigint,
  newly_archived_count bigint,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_workspace public.workspaces%rowtype;
  selected_fixture_level text;
  expected_suffix text;
  selected_student_id uuid;
  lock_entity_id uuid;
  current_archive_run_id uuid;
  current_archive_run_ids uuid[];
  active_reservation_count bigint := 0;
  inserted_count bigint := 0;
  deleted_count bigint := 0;
  total_count bigint := 0;
begin
  perform app_private.assert_service_role();

  if target_workspace_id is null
    or coalesce(target_workspace_slug, '') = ''
    or target_batch_id is null
    or target_provider_assignment_id is null
    or target_bank_assignment_id is null
    or target_provider_assignment_id = target_bank_assignment_id
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_live_canary_archive_contract_invalid';
  end if;

  -- This is not a general tenant-deletion API. It is hard-bound to the one
  -- deterministic worksheet-live staging canary used by the browser proof.
  if target_workspace_id <>
      'e1300000-0000-4000-8000-000000000001'::uuid
    or target_workspace_slug <>
      'e2e-worksheet-live-e1300000-0000-4000-8000-000000000001'
    or target_batch_id <>
      'e1300000-0000-4000-8000-000000000004'::uuid
    or target_provider_assignment_id <>
      'e1300000-0000-4000-8000-000000000006'::uuid
    or target_bank_assignment_id <>
      'e1300000-0000-4000-8000-000000000007'::uuid
  then
    raise exception using
      errcode = '55000',
      message = 'worksheet_live_canary_identity_mismatch';
  end if;

  expected_suffix := left(target_workspace_id::text, 8);
  if target_workspace_slug <>
      'e2e-worksheet-live-' || target_workspace_id::text
  then
    raise exception using
      errcode = '55000',
      message = 'worksheet_live_canary_identity_mismatch';
  end if;

  select workspace.*
  into selected_workspace
  from public.workspaces workspace
  where workspace.id = target_workspace_id
  for update nowait;

  if selected_workspace.id is null
    or selected_workspace.slug <> target_workspace_slug
    or selected_workspace.name <> 'V1 worksheet live ' || expected_suffix
  then
    raise exception using
      errcode = '55000',
      message = 'worksheet_live_canary_identity_mismatch';
  end if;

  -- Lock the exact batch before any child rows. Its immutable level is the
  -- single source of truth for every level-scoped fixture assertion below.
  select batch.level
  into selected_fixture_level
  from public.batches batch
  where batch.id = target_batch_id
    and batch.workspace_id = target_workspace_id
  for update nowait;

  if selected_fixture_level is null
    or selected_fixture_level not in ('A1', 'A2', 'B1', 'B2')
  then
    raise exception using
      errcode = '55000',
      message = 'worksheet_live_canary_identity_mismatch';
  end if;

  -- The assignment locks serialize with worksheet start/submit paths. The
  -- paid-job advisory locks serialize with generation/retry enqueue paths.
  perform assignment.id
  from public.student_practice_assignments assignment
  where assignment.id in (
    target_provider_assignment_id,
    target_bank_assignment_id
  )
  order by assignment.id
  for update nowait;

  for lock_entity_id in
    select assignment_id
    from unnest(array[
      target_provider_assignment_id,
      target_bank_assignment_id
    ]) assignment_id
    order by assignment_id
  loop
    if not pg_try_advisory_xact_lock(
      hashtextextended(
        concat_ws(
          ':',
          'paid-job-entity',
          'worksheet_generation',
          lock_entity_id
        ),
        0
      )
    ) then
      raise exception using
        errcode = '55000',
        message = 'worksheet_live_canary_job_active';
    end if;
  end loop;

  -- Lock the fixed provider topic plus the optional bank topic after their
  -- assignments, in deterministic UUID order.
  perform topic.id
  from public.grammar_topics topic
  where topic.id =
      'e1300000-0000-4000-8000-000000000008'::uuid
    or topic.id in (
      select assignment.grammar_topic_id
      from public.student_practice_assignments assignment
      where assignment.id in (
        target_provider_assignment_id,
        target_bank_assignment_id
      )
    )
  order by topic.id
  for update nowait;

  select enrollment.student_id
  into selected_student_id
  from public.batch_students enrollment
  where enrollment.workspace_id = target_workspace_id
    and enrollment.batch_id = target_batch_id
  order by enrollment.id
  limit 1;

  if selected_student_id is null
    or (
      select count(*)
      from public.batches batch
      where batch.workspace_id = target_workspace_id
    ) <> 1
    or not exists (
      select 1
      from public.batches batch
      where batch.id = target_batch_id
        and batch.workspace_id = target_workspace_id
        and batch.name = 'Worksheet live class ' || expected_suffix
        and batch.level = selected_fixture_level
        and batch.feedback_mode = 'immediate'
        and batch.is_active
        and batch.join_requires_approval
        and batch.created_by = selected_workspace.owner_id
    )
    or (
      select count(*)
      from public.workspace_members membership
      where membership.workspace_id = target_workspace_id
    ) <> 2
    or not exists (
      select 1
      from public.workspace_members membership
      where membership.workspace_id = target_workspace_id
        and membership.user_id = selected_workspace.owner_id
        and membership.role in ('owner', 'teacher')
    )
    or not exists (
      select 1
      from public.workspace_members membership
      where membership.workspace_id = target_workspace_id
        and membership.user_id = selected_student_id
        and membership.role = 'student'
    )
    or (
      select count(*)
      from public.batch_students enrollment
      where enrollment.workspace_id = target_workspace_id
    ) <> 1
    or not exists (
      select 1
      from public.batch_students enrollment
      where enrollment.workspace_id = target_workspace_id
        and enrollment.batch_id = target_batch_id
        and enrollment.student_id = selected_student_id
    )
  then
    raise exception using
      errcode = '55000',
      message = 'worksheet_live_canary_identity_mismatch';
  end if;

  -- The provider assignment is mandatory. The bank assignment is optional
  -- because a staging project may truthfully have no released bank template,
  -- but when present it must be the one fixed isolated bank row.
  if not exists (
      select 1
      from public.student_practice_assignments assignment
      join public.grammar_topics topic
        on topic.id = assignment.grammar_topic_id
      where assignment.id = target_provider_assignment_id
        and assignment.workspace_id = target_workspace_id
        and assignment.student_id = selected_student_id
        and assignment.batch_id = target_batch_id
        and assignment.source = 'manual'
        and assignment.assigned_by = selected_workspace.owner_id
        and assignment.worksheet_level = selected_fixture_level
        and assignment.class_context_version = 1
        and assignment.class_context_integrity = 'teacher_verified'
        and topic.id =
          'e1300000-0000-4000-8000-000000000008'::uuid
        and topic.slug = 'e2e-worksheet-provider-canary'
        and topic.name = 'Akkusativ'
        and topic.level = selected_fixture_level
        and topic.description =
          'Synthetic staging canary for focused ' || selected_fixture_level ||
            ' accusative-case practice.'
    )
    or exists (
      select 1
      from public.student_practice_assignments assignment
      where assignment.id = target_bank_assignment_id
        and (
          assignment.workspace_id is distinct from target_workspace_id
          or assignment.student_id is distinct from selected_student_id
          or assignment.batch_id is distinct from target_batch_id
          or assignment.source is distinct from 'manual'
          or assignment.assigned_by is distinct from selected_workspace.owner_id
          or assignment.worksheet_level is distinct from selected_fixture_level
          or assignment.class_context_version is distinct from 1
          or assignment.class_context_integrity is distinct from
            'teacher_verified'
          or assignment.grammar_topic_id is not distinct from (
            select provider_assignment.grammar_topic_id
            from public.student_practice_assignments provider_assignment
            where provider_assignment.id = target_provider_assignment_id
          )
          or not exists (
            select 1
            from public.grammar_topics bank_topic
            where bank_topic.id = assignment.grammar_topic_id
              and (
                bank_topic.level = selected_fixture_level
                or (
                  selected_fixture_level in ('A1', 'A2')
                  and bank_topic.level = 'A1_A2'
                )
              )
              and bank_topic.level <> 'B1_B2'
              and bank_topic.slug <> 'e2e-worksheet-provider-canary'
          )
        )
    )
    or exists (
      select 1
      from public.student_practice_assignments assignment
      where assignment.workspace_id = target_workspace_id
        and assignment.id not in (
          target_provider_assignment_id,
          target_bank_assignment_id
        )
    )
    or (
      select count(*)
      from public.student_practice_assignments assignment
      where assignment.workspace_id = target_workspace_id
    ) not between 1 and 2
  then
    raise exception using
      errcode = '55000',
      message = 'worksheet_live_canary_assignment_scope_invalid';
  end if;

  -- Lock every fixture-owned generated/attached test before validating or
  -- detaching spend evidence. The order extends the existing parent-to-child
  -- lock chain without changing the assignment/job/reservation order.
  perform test.id
  from public.practice_tests test
  where test.workspace_id = target_workspace_id
  order by test.id
  for update nowait;

  if exists (
      select 1
      from public.practice_tests test
      where test.workspace_id = target_workspace_id
        and not exists (
          select 1
          from public.student_practice_assignments assignment
          where assignment.id in (
              target_provider_assignment_id,
              target_bank_assignment_id
            )
            and assignment.workspace_id = target_workspace_id
            and assignment.practice_test_id = test.id
        )
    )
    or exists (
      select 1
      from public.student_practice_assignments assignment
      join public.practice_tests test
        on test.id = assignment.practice_test_id
      where assignment.id in (
          target_provider_assignment_id,
          target_bank_assignment_id
        )
        and assignment.workspace_id = target_workspace_id
        and (
          test.workspace_id <> target_workspace_id
          or test.grammar_topic_id <> assignment.grammar_topic_id
          or test.level <> selected_fixture_level
        )
    )
  then
    raise exception using
      errcode = '55000',
      message = 'worksheet_live_canary_test_scope_invalid';
  end if;

  -- Assignment locks above prevent a normal submitter from inserting a new
  -- attempt after this snapshot. Existing answer jobs are additionally fenced
  -- by their paid-job entity advisory lock.
  perform attempt.id
  from public.practice_test_attempts attempt
  where attempt.workspace_id = target_workspace_id
  order by attempt.id
  for update nowait;

  if exists (
      select 1
      from public.practice_test_attempts attempt
      left join public.student_practice_assignments assignment
        on assignment.id = attempt.assignment_id
      where attempt.workspace_id = target_workspace_id
        and (
          assignment.id is null
          or assignment.id not in (
            target_provider_assignment_id,
            target_bank_assignment_id
          )
          or assignment.workspace_id is distinct from target_workspace_id
          or attempt.student_id is distinct from assignment.student_id
          or attempt.practice_test_id is distinct from
            assignment.practice_test_id
        )
    )
    or exists (
      select 1
      from public.practice_test_attempts attempt
      where attempt.assignment_id in (
          target_provider_assignment_id,
          target_bank_assignment_id
        )
        and attempt.workspace_id <> target_workspace_id
    )
  then
    raise exception using
      errcode = '55000',
      message = 'worksheet_live_canary_attempt_scope_invalid';
  end if;

  for lock_entity_id in
    select attempt.id
    from public.practice_test_attempts attempt
    where attempt.workspace_id = target_workspace_id
    order by attempt.id
  loop
    if not pg_try_advisory_xact_lock(
      hashtextextended(
        concat_ws(
          ':',
          'paid-job-entity',
          'worksheet_answer_evaluation',
          lock_entity_id
        ),
        0
      )
    ) then
      raise exception using
        errcode = '55000',
        message = 'worksheet_live_canary_job_active';
    end if;
  end loop;

  perform job.id
  from app_private.async_jobs job
  where (
      job.job_kind = 'worksheet_generation'
      and exists (
        select 1
        from public.student_practice_assignments assignment
        where assignment.id = job.entity_id
          and assignment.workspace_id = target_workspace_id
          and assignment.id in (
            target_provider_assignment_id,
            target_bank_assignment_id
          )
      )
    )
    or (
      job.job_kind = 'worksheet_answer_evaluation'
      and exists (
        select 1
        from public.practice_test_attempts attempt
        where attempt.id = job.entity_id
          and attempt.workspace_id = target_workspace_id
      )
  )
  order by job.id
  for update of job nowait;

  if exists (
      select 1
      from app_private.async_jobs job
      where job.entity_id in (
          target_provider_assignment_id,
          target_bank_assignment_id
        )
        and (
          job.job_kind <> 'worksheet_generation'
          or job.queue_name <> 'worksheet_generation'
        )
    )
    or exists (
      select 1
      from app_private.async_jobs job
      join public.practice_test_attempts attempt
        on attempt.id = job.entity_id
       and attempt.workspace_id = target_workspace_id
      where job.job_kind <> 'worksheet_answer_evaluation'
        or job.queue_name <> 'worksheet_answer_evaluation'
    )
    or exists (
      select 1
      from app_private.async_jobs job
      where job.job_kind = 'worksheet_generation'
        and job.entity_id in (
          target_provider_assignment_id,
          target_bank_assignment_id
        )
        and not exists (
          select 1
          from public.student_practice_assignments assignment
          where assignment.id = job.entity_id
            and assignment.workspace_id = target_workspace_id
        )
    )
  then
    raise exception using
      errcode = '55000',
      message = 'worksheet_live_canary_job_scope_invalid';
  end if;

  -- Queue evidence is not deleted here, but it must describe only one of the
  -- exact scoped jobs. This rejects an orphan message for the optional bank ID
  -- before any spend row can be detached.
  if exists (
    select 1
    from (
      select
        'worksheet_generation'::text as queue_name,
        message.message
      from pgmq.q_worksheet_generation message
      union all
      select 'worksheet_generation'::text, message.message
      from pgmq.a_worksheet_generation message
      union all
      select 'worksheet_answer_evaluation'::text, message.message
      from pgmq.q_worksheet_answer_evaluation message
      union all
      select 'worksheet_answer_evaluation'::text, message.message
      from pgmq.a_worksheet_answer_evaluation message
    ) queued
    where (
        queued.message ->> 'entity_id' in (
          target_provider_assignment_id::text,
          target_bank_assignment_id::text
        )
        or queued.message ->> 'entity_id' in (
          select attempt.id::text
          from public.practice_test_attempts attempt
          where attempt.workspace_id = target_workspace_id
        )
        or exists (
          select 1
          from app_private.async_jobs candidate_job
          where queued.message ->> 'job_id' = candidate_job.id::text
            and (
              (
                candidate_job.job_kind = 'worksheet_generation'
                and exists (
                  select 1
                  from public.student_practice_assignments assignment
                  where assignment.id = candidate_job.entity_id
                    and assignment.workspace_id = target_workspace_id
                    and assignment.id in (
                      target_provider_assignment_id,
                      target_bank_assignment_id
                    )
                )
              )
              or (
                candidate_job.job_kind = 'worksheet_answer_evaluation'
                and exists (
                  select 1
                  from public.practice_test_attempts attempt
                  where attempt.id = candidate_job.entity_id
                    and attempt.workspace_id = target_workspace_id
                )
              )
            )
        )
      )
      and not exists (
        select 1
        from app_private.async_jobs job
        where queued.message ->> 'job_id' = job.id::text
          and queued.message ->> 'entity_id' = job.entity_id::text
          and queued.message ->> 'job_kind' = job.job_kind
          and queued.message ->> 'entity_version' = job.entity_version::text
          and queued.queue_name = job.queue_name
          and (
            (
              job.job_kind = 'worksheet_generation'
              and exists (
                select 1
                from public.student_practice_assignments assignment
                where assignment.id = job.entity_id
                  and assignment.workspace_id = target_workspace_id
                  and assignment.id in (
                    target_provider_assignment_id,
                    target_bank_assignment_id
                  )
              )
            )
            or (
              job.job_kind = 'worksheet_answer_evaluation'
              and exists (
                select 1
                from public.practice_test_attempts attempt
                where attempt.id = job.entity_id
                  and attempt.workspace_id = target_workspace_id
              )
            )
          )
      )
  ) then
    raise exception using
      errcode = '55000',
      message = 'worksheet_live_canary_queue_scope_invalid';
  end if;

  if exists (
    select 1
    from app_private.async_jobs job
    where (
      (
          job.job_kind = 'worksheet_generation'
          and exists (
            select 1
            from public.student_practice_assignments assignment
            where assignment.id = job.entity_id
              and assignment.workspace_id = target_workspace_id
              and assignment.id in (
                target_provider_assignment_id,
                target_bank_assignment_id
              )
          )
        )
        or (
          job.job_kind = 'worksheet_answer_evaluation'
          and exists (
            select 1
            from public.practice_test_attempts attempt
            where attempt.id = job.entity_id
              and attempt.workspace_id = target_workspace_id
          )
        )
      )
      and job.status in ('queued', 'processing', 'retry')
  ) then
    raise exception using
      errcode = '55000',
      message = 'worksheet_live_canary_job_active';
  end if;

  perform reservation.id
  from app_private.ai_spend_reservations reservation
  where reservation.workspace_id = target_workspace_id
  order by reservation.id
  for update nowait;

  if exists (
      select 1
      from app_private.ai_spend_reservations reservation
      where reservation.workspace_id = target_workspace_id
        and not exists (
          select 1
          from app_private.async_jobs job
          where job.id = reservation.job_id
            and (
              (
                job.job_kind = 'worksheet_generation'
                and job.entity_version = reservation.entity_version
                and exists (
                  select 1
                  from public.student_practice_assignments assignment
                  where assignment.id = job.entity_id
                    and assignment.workspace_id = target_workspace_id
                    and assignment.id in (
                      target_provider_assignment_id,
                      target_bank_assignment_id
                    )
                )
              )
              or (
                job.job_kind = 'worksheet_answer_evaluation'
                and job.entity_version = reservation.entity_version
                and exists (
                  select 1
                  from public.practice_test_attempts attempt
                  where attempt.id = job.entity_id
                    and attempt.workspace_id = target_workspace_id
                )
              )
            )
        )
    )
    or exists (
      select 1
      from app_private.ai_spend_reservations reservation
      join app_private.async_jobs job on job.id = reservation.job_id
      where (
          (
            job.job_kind = 'worksheet_generation'
            and exists (
              select 1
              from public.student_practice_assignments assignment
              where assignment.id = job.entity_id
                and assignment.workspace_id = target_workspace_id
                and assignment.id in (
                  target_provider_assignment_id,
                  target_bank_assignment_id
                )
            )
          )
          or (
            job.job_kind = 'worksheet_answer_evaluation'
            and exists (
              select 1
              from public.practice_test_attempts attempt
              where attempt.id = job.entity_id
                and attempt.workspace_id = target_workspace_id
            )
          )
        )
        and reservation.workspace_id <> target_workspace_id
    )
    or exists (
      select 1
      from app_private.ai_spend_reservations reservation
      join app_private.async_jobs job on job.id = reservation.job_id
      where reservation.workspace_id = target_workspace_id
        and (
          (
            job.job_kind = 'worksheet_generation'
            and reservation.call_purpose not in (
              'worksheet_generation',
              'worksheet_critique'
            )
          )
          or (
            job.job_kind = 'worksheet_answer_evaluation'
            and reservation.call_purpose not in (
              'worksheet_answer_evaluation',
              'worksheet_answer_adjudication'
            )
          )
        )
    )
  then
    raise exception using
      errcode = '55000',
      message = 'worksheet_live_canary_spend_scope_invalid';
  end if;

  if exists (
    select 1
    from app_private.ai_spend_reservations reservation
    where reservation.workspace_id = target_workspace_id
      and reservation.state = 'reserved'
  ) then
    raise exception using
      errcode = '55000',
      message = 'worksheet_live_canary_spend_not_terminal';
  end if;

  if exists (
    select 1
    from app_private.ai_spend_reservations reservation
    join app_private.ai_canary_spend_archive archived
      on archived.original_reservation_id = reservation.id
    where reservation.workspace_id = target_workspace_id
  ) then
    raise exception using
      errcode = '55000',
      message = 'worksheet_live_canary_spend_overlap';
  end if;

  -- Rows from an earlier browser run intentionally outlive that run's jobs and
  -- workspace. Their immutable source, fixed workspace identity, and non-null
  -- run ID are sufficient historical linkage. If an original job ID is still
  -- live, however, it must resolve exactly to this current fixture and version.
  if exists (
    select 1
    from app_private.ai_canary_spend_archive archived
    where archived.original_workspace_id = target_workspace_id
      and (
        archived.archive_source <> 'worksheet_live_canary_cleanup'
        or archived.archive_run_id is null
        or exists (
          select 1
          from app_private.async_jobs job
          where job.id = archived.original_job_id
            and not (
              (
                job.job_kind = 'worksheet_generation'
                and job.entity_version = archived.entity_version
                and exists (
                  select 1
                  from public.student_practice_assignments assignment
                  where assignment.id = job.entity_id
                    and assignment.workspace_id = target_workspace_id
                    and assignment.id in (
                      target_provider_assignment_id,
                      target_bank_assignment_id
                    )
                )
                and archived.call_purpose in (
                  'worksheet_generation',
                  'worksheet_critique'
                )
              )
              or (
                job.job_kind = 'worksheet_answer_evaluation'
                and job.entity_version = archived.entity_version
                and archived.call_purpose in (
                  'worksheet_answer_evaluation',
                  'worksheet_answer_adjudication'
                )
                and exists (
                  select 1
                  from public.practice_test_attempts attempt
                  where attempt.id = job.entity_id
                    and attempt.workspace_id = target_workspace_id
                )
              )
            )
        )
      )
  ) then
    raise exception using
      errcode = '55000',
      message = 'worksheet_live_canary_archive_scope_invalid';
  end if;

  select count(*)
  into active_reservation_count
  from app_private.ai_spend_reservations reservation
  where reservation.workspace_id = target_workspace_id;

  select coalesce(
    array_agg(
      distinct archived.archive_run_id
      order by archived.archive_run_id
    ),
    array[]::uuid[]
  )
  into current_archive_run_ids
  from app_private.ai_canary_spend_archive archived
  where archived.original_workspace_id = target_workspace_id
    and archived.archive_source = 'worksheet_live_canary_cleanup'
    and exists (
      select 1
      from app_private.async_jobs job
      where job.id = archived.original_job_id
        and (
          (
            job.job_kind = 'worksheet_generation'
            and job.entity_version = archived.entity_version
            and exists (
              select 1
              from public.student_practice_assignments assignment
              where assignment.id = job.entity_id
                and assignment.workspace_id = target_workspace_id
                and assignment.id in (
                  target_provider_assignment_id,
                  target_bank_assignment_id
                )
            )
            and archived.call_purpose in (
              'worksheet_generation',
              'worksheet_critique'
            )
          )
          or (
            job.job_kind = 'worksheet_answer_evaluation'
            and job.entity_version = archived.entity_version
            and archived.call_purpose in (
              'worksheet_answer_evaluation',
              'worksheet_answer_adjudication'
            )
            and exists (
              select 1
              from public.practice_test_attempts attempt
              where attempt.id = job.entity_id
                and attempt.workspace_id = target_workspace_id
            )
          )
        )
    );

  if cardinality(current_archive_run_ids) > 1 then
    raise exception using
      errcode = '55000',
      message = 'worksheet_live_canary_archive_run_ambiguous';
  end if;

  current_archive_run_id := current_archive_run_ids[1];
  if active_reservation_count > 0 and current_archive_run_id is null then
    current_archive_run_id := gen_random_uuid();
  end if;

  with copied as (
    insert into app_private.ai_canary_spend_archive (
      original_reservation_id,
      original_job_id,
      entity_version,
      call_key,
      original_workspace_id,
      billing_month,
      provider_name,
      model_name,
      call_purpose,
      input_rate_microusd_per_million,
      output_rate_microusd_per_million,
      reserved_microusd,
      state,
      actual_microusd,
      billed_input_tokens,
      billed_output_tokens,
      release_reason,
      usage_estimated,
      expires_at,
      created_at,
      finalized_at,
      released_at,
      archive_source,
      archive_run_id
    )
    select
      reservation.id,
      reservation.job_id,
      reservation.entity_version,
      reservation.call_key,
      reservation.workspace_id,
      reservation.billing_month,
      reservation.provider_name,
      reservation.model_name,
      reservation.call_purpose,
      reservation.input_rate_microusd_per_million,
      reservation.output_rate_microusd_per_million,
      reservation.reserved_microusd,
      reservation.state,
      reservation.actual_microusd,
      reservation.billed_input_tokens,
      reservation.billed_output_tokens,
      reservation.release_reason,
      reservation.usage_estimated,
      reservation.expires_at,
      reservation.created_at,
      reservation.finalized_at,
      reservation.released_at,
      'worksheet_live_canary_cleanup',
      current_archive_run_id
    from app_private.ai_spend_reservations reservation
    where reservation.workspace_id = target_workspace_id
    returning 1
  )
  select count(*) into inserted_count from copied;

  if inserted_count <> active_reservation_count then
    raise exception using
      errcode = '55000',
      message = 'worksheet_live_canary_archive_copy_incomplete';
  end if;

  perform set_config('app.ai_spend_transition', 'on', true);
  delete from app_private.ai_spend_reservations reservation
  where reservation.workspace_id = target_workspace_id;
  get diagnostics deleted_count = row_count;
  perform set_config('app.ai_spend_transition', 'off', true);

  if deleted_count <> inserted_count then
    raise exception using
      errcode = '55000',
      message = 'worksheet_live_canary_archive_delete_mismatch';
  end if;

  select count(*)
  into total_count
  from app_private.ai_canary_spend_archive archived
  where archived.original_workspace_id = target_workspace_id
    and archived.archive_source = 'worksheet_live_canary_cleanup'
    and archived.archive_run_id = current_archive_run_id;

  return query select
    total_count,
    inserted_count,
    inserted_count = 0 and total_count > 0;
exception
  when lock_not_available then
    raise exception using
      errcode = '55000',
      message = 'worksheet_live_canary_job_active';
end;
$$;


comment on function app_private.archive_worksheet_live_canary_spend(
  uuid, text, uuid, uuid, uuid
) is
  'Archives only terminal, content-free AI spend for the exact fixed A1-B2 worksheet-live canary after deterministic parent-to-child locking and level-consistency validation.';
