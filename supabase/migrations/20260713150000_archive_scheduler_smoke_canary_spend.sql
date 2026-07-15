-- Detach terminal AI-spend receipts from the one long-lived scheduler smoke
-- workspace without turning this into a tenant-cleanup API. The workspace and
-- slug are deliberately hard-bound to the observed synthetic staging fixture.

alter table app_private.ai_canary_spend_archive
  drop constraint if exists ai_canary_spend_archive_archive_source_check;

alter table app_private.ai_canary_spend_archive
  drop constraint if exists ai_canary_spend_archive_run_source_check;

alter table app_private.ai_canary_spend_archive
  add constraint ai_canary_spend_archive_archive_source_check check (
    archive_source in (
      'writing_live_canary_cleanup',
      'worksheet_live_canary_cleanup',
      'scheduler_smoke_canary_cleanup'
    )
  ),
  add constraint ai_canary_spend_archive_run_source_check check (
    (
      archive_source = 'writing_live_canary_cleanup'
      and archive_run_id is null
    )
    or (
      archive_source = 'worksheet_live_canary_cleanup'
      and archive_run_id is not null
    )
    or (
      archive_source = 'scheduler_smoke_canary_cleanup'
      and archive_run_id is not null
    )
  );

create function app_private.archive_scheduler_smoke_canary_spend(
  target_workspace_id uuid,
  target_workspace_slug text,
  target_student_id uuid,
  target_archive_run_id uuid
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
  lock_job_kind text;
  lock_entity_id uuid;
  active_reservation_count bigint := 0;
  workspace_archive_count bigint := 0;
  existing_run_count bigint := 0;
  inserted_count bigint := 0;
  deleted_count bigint := 0;
  remaining_count bigint := 0;
  accounting_count_before bigint := 0;
  accounting_reserved_before bigint := 0;
  accounting_actual_before bigint := 0;
  accounting_count_after bigint := 0;
  accounting_reserved_after bigint := 0;
  accounting_actual_after bigint := 0;
begin
  perform app_private.assert_service_role();

  if target_workspace_id is null
    or coalesce(target_workspace_slug, '') = ''
    or target_student_id is null
    or target_archive_run_id is null
  then
    raise exception using
      errcode = '22023',
      message = 'scheduler_smoke_canary_archive_contract_invalid';
  end if;

  if target_workspace_id <>
      'da208b06-9087-40d8-8304-d9a4662e3d86'::uuid
    or target_workspace_slug <>
      'scheduler-smoke-test-workspace-0b23d636'
    or target_workspace_slug !~
      '^scheduler-smoke-test-workspace-[0-9a-f]{8}$'
  then
    raise exception using
      errcode = '55000',
      message = 'scheduler_smoke_canary_identity_mismatch';
  end if;

  select workspace.*
  into selected_workspace
  from public.workspaces workspace
  where workspace.id = target_workspace_id
  for update nowait;

  perform membership.id
  from public.workspace_members membership
  where membership.workspace_id = target_workspace_id
  order by membership.id
  for update nowait;

  if selected_workspace.id is null
    or selected_workspace.slug <> target_workspace_slug
    or selected_workspace.name <> 'Scheduler Smoke Test Workspace'
    or not exists (
      select 1
      from public.workspace_members membership
      where membership.workspace_id = target_workspace_id
        and membership.user_id = selected_workspace.owner_id
        and membership.role in ('owner', 'teacher')
    )
    or (
      select count(*)
      from public.workspace_members membership
      where membership.workspace_id = target_workspace_id
    ) <> 2
    or (
      select count(*)
      from public.workspace_members membership
      where membership.workspace_id = target_workspace_id
        and membership.role = 'student'
    ) <> 1
    or not exists (
      select 1
      from public.workspace_members membership
      where membership.workspace_id = target_workspace_id
        and membership.user_id = target_student_id
        and membership.role = 'student'
    )
  then
    raise exception using
      errcode = '55000',
      message = 'scheduler_smoke_canary_identity_mismatch';
  end if;

  -- The fixture is a one-student canary. Every current child record must stay
  -- attached to that same learner and workspace before any receipt is moved.
  if exists (
      select 1
      from public.batch_students enrollment
      where enrollment.workspace_id = target_workspace_id
        and enrollment.student_id <> target_student_id
    )
    or exists (
      select 1
      from public.submissions submission
      where submission.workspace_id = target_workspace_id
        and submission.student_id <> target_student_id
    )
    or exists (
      select 1
      from public.student_practice_assignments assignment
      where assignment.workspace_id = target_workspace_id
        and assignment.student_id <> target_student_id
    )
    or exists (
      select 1
      from public.practice_test_attempts attempt
      where attempt.workspace_id = target_workspace_id
        and attempt.student_id <> target_student_id
    )
    or exists (
      select 1
      from public.submissions submission
      left join public.batches batch on batch.id = submission.batch_id
      where submission.workspace_id = target_workspace_id
        and submission.batch_id is not null
        and batch.workspace_id is distinct from target_workspace_id
    )
    or exists (
      select 1
      from public.student_practice_assignments assignment
      left join public.batches batch on batch.id = assignment.batch_id
      where assignment.workspace_id = target_workspace_id
        and assignment.batch_id is not null
        and batch.workspace_id is distinct from target_workspace_id
    )
    or exists (
      select 1
      from public.practice_test_attempts attempt
      left join public.student_practice_assignments assignment
        on assignment.id = attempt.assignment_id
      left join public.practice_tests practice_test
        on practice_test.id = attempt.practice_test_id
      where attempt.workspace_id = target_workspace_id
        and (
          practice_test.workspace_id is distinct from target_workspace_id
          or (
            attempt.assignment_id is not null
            and (
              assignment.workspace_id is distinct from target_workspace_id
              or assignment.student_id is distinct from target_student_id
            )
          )
        )
    )
  then
    raise exception using
      errcode = '55000',
      message = 'scheduler_smoke_canary_entity_scope_invalid';
  end if;

  -- Stable parent/entity/job ordering matches the ordinary paid-work paths.
  perform submission.id
  from public.submissions submission
  where submission.workspace_id = target_workspace_id
  order by submission.id
  for update nowait;

  perform assignment.id
  from public.student_practice_assignments assignment
  where assignment.workspace_id = target_workspace_id
  order by assignment.id
  for update nowait;

  perform attempt.id
  from public.practice_test_attempts attempt
  where attempt.workspace_id = target_workspace_id
  order by attempt.id
  for update nowait;

  -- Reuse the exact entity advisory locks taken by every paid enqueue/retry.
  -- A stable kind/ID order prevents a new job or reservation from appearing
  -- after the terminal-work snapshot without blocking indefinitely.
  for lock_job_kind, lock_entity_id in
    select scoped.job_kind, scoped.entity_id
    from (
      select
        'writing_evaluation'::text as job_kind,
        submission.id as entity_id
      from public.submissions submission
      where submission.workspace_id = target_workspace_id

      union all

      select 'worksheet_generation'::text, assignment.id
      from public.student_practice_assignments assignment
      where assignment.workspace_id = target_workspace_id

      union all

      select 'worksheet_answer_evaluation'::text, attempt.id
      from public.practice_test_attempts attempt
      where attempt.workspace_id = target_workspace_id
    ) scoped
    order by scoped.job_kind, scoped.entity_id
  loop
    if not pg_try_advisory_xact_lock(
      hashtextextended(
        concat_ws(
          ':',
          'paid-job-entity',
          lock_job_kind,
          lock_entity_id
        ),
        0
      )
    ) then
      raise exception using
        errcode = '55000',
        message = 'scheduler_smoke_canary_job_active';
    end if;
  end loop;

  perform job.id
  from app_private.async_jobs job
  where exists (
      select 1
      from public.submissions submission
      where submission.id = job.entity_id
        and submission.workspace_id = target_workspace_id
    )
    or exists (
      select 1
      from public.student_practice_assignments assignment
      where assignment.id = job.entity_id
        and assignment.workspace_id = target_workspace_id
    )
    or exists (
      select 1
      from public.practice_test_attempts attempt
      where attempt.id = job.entity_id
        and attempt.workspace_id = target_workspace_id
    )
  order by job.id
  for update of job nowait;

  if exists (
    select 1
    from app_private.async_jobs job
    where (
        exists (
          select 1
          from public.submissions submission
          where submission.id = job.entity_id
            and submission.workspace_id = target_workspace_id
        )
        or exists (
          select 1
          from public.student_practice_assignments assignment
          where assignment.id = job.entity_id
            and assignment.workspace_id = target_workspace_id
        )
        or exists (
          select 1
          from public.practice_test_attempts attempt
          where attempt.id = job.entity_id
            and attempt.workspace_id = target_workspace_id
        )
      )
      and not (
        (
          job.queue_name = 'writing_evaluation'
          and job.job_kind = 'writing_evaluation'
          and exists (
            select 1
            from public.submissions submission
            where submission.id = job.entity_id
              and submission.workspace_id = target_workspace_id
          )
        )
        or (
          job.queue_name = 'worksheet_generation'
          and job.job_kind = 'worksheet_generation'
          and exists (
            select 1
            from public.student_practice_assignments assignment
            where assignment.id = job.entity_id
              and assignment.workspace_id = target_workspace_id
          )
        )
        or (
          job.queue_name = 'worksheet_answer_evaluation'
          and job.job_kind = 'worksheet_answer_evaluation'
          and exists (
            select 1
            from public.practice_test_attempts attempt
            where attempt.id = job.entity_id
              and attempt.workspace_id = target_workspace_id
          )
        )
      )
  ) then
    raise exception using
      errcode = '55000',
      message = 'scheduler_smoke_canary_job_scope_invalid';
  end if;

  if exists (
    select 1
    from app_private.async_jobs job
    where (
        exists (
          select 1
          from public.submissions submission
          where submission.id = job.entity_id
            and submission.workspace_id = target_workspace_id
        )
        or exists (
          select 1
          from public.student_practice_assignments assignment
          where assignment.id = job.entity_id
            and assignment.workspace_id = target_workspace_id
        )
        or exists (
          select 1
          from public.practice_test_attempts attempt
          where attempt.id = job.entity_id
            and attempt.workspace_id = target_workspace_id
        )
      )
      and job.status not in ('succeeded', 'dead')
  ) then
    raise exception using
      errcode = '55000',
      message = 'scheduler_smoke_canary_job_active';
  end if;

  if exists (
      select 1
      from app_private.worksheet_generation_checkpoints checkpoint
      join app_private.async_jobs job on job.id = checkpoint.job_id
      join public.student_practice_assignments assignment
        on assignment.id = job.entity_id
      where job.job_kind = 'worksheet_generation'
        and assignment.workspace_id = target_workspace_id
    )
    or exists (
      select 1
      from app_private.worksheet_answer_provider_checkpoints checkpoint
      join app_private.async_jobs job on job.id = checkpoint.job_id
      join public.practice_test_attempts attempt on attempt.id = job.entity_id
      where job.job_kind = 'worksheet_answer_evaluation'
        and attempt.workspace_id = target_workspace_id
    )
  then
    raise exception using
      errcode = '55000',
      message = 'scheduler_smoke_canary_checkpoint_pending';
  end if;

  if exists (
    select 1
    from (
      select 'writing_evaluation'::text as queue_name, queued.message
      from pgmq.q_writing_evaluation queued
      union all
      select 'worksheet_generation'::text, queued.message
      from pgmq.q_worksheet_generation queued
      union all
      select 'worksheet_answer_evaluation'::text, queued.message
      from pgmq.q_worksheet_answer_evaluation queued
    ) queued
    where exists (
        select 1
        from app_private.async_jobs job
        where queued.message ->> 'job_id' = job.id::text
          and (
            (
              job.job_kind = 'writing_evaluation'
              and exists (
                select 1
                from public.submissions submission
                where submission.id = job.entity_id
                  and submission.workspace_id = target_workspace_id
              )
            )
            or (
              job.job_kind = 'worksheet_generation'
              and exists (
                select 1
                from public.student_practice_assignments assignment
                where assignment.id = job.entity_id
                  and assignment.workspace_id = target_workspace_id
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
      or (
        queued.queue_name = 'writing_evaluation'
        and queued.message ->> 'entity_id' in (
          select submission.id::text
          from public.submissions submission
          where submission.workspace_id = target_workspace_id
        )
      )
      or (
        queued.queue_name = 'worksheet_generation'
        and queued.message ->> 'entity_id' in (
          select assignment.id::text
          from public.student_practice_assignments assignment
          where assignment.workspace_id = target_workspace_id
        )
      )
      or (
        queued.queue_name = 'worksheet_answer_evaluation'
        and queued.message ->> 'entity_id' in (
          select attempt.id::text
          from public.practice_test_attempts attempt
          where attempt.workspace_id = target_workspace_id
        )
      )
  ) then
    raise exception using
      errcode = '55000',
      message = 'scheduler_smoke_canary_queue_pending';
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
        and reservation.student_id <> target_student_id
    )
    or exists (
      select 1
      from app_private.ai_spend_reservations reservation
      where reservation.workspace_id = target_workspace_id
        and not exists (
          select 1
          from app_private.async_jobs job
          where job.id = reservation.job_id
            and job.entity_version = reservation.entity_version
            and job.status in ('succeeded', 'dead')
            and (
              (
                job.queue_name = 'writing_evaluation'
                and job.job_kind = 'writing_evaluation'
                and reservation.call_purpose in (
                  'writing_generation',
                  'writing_critique',
                  'writing_adjudication',
                  'writing_final_critique'
                )
                and exists (
                  select 1
                  from public.submissions submission
                  where submission.id = job.entity_id
                    and submission.workspace_id = target_workspace_id
                    and submission.student_id = target_student_id
                )
              )
              or (
                job.queue_name = 'worksheet_generation'
                and job.job_kind = 'worksheet_generation'
                and reservation.call_purpose in (
                  'worksheet_generation',
                  'worksheet_critique'
                )
                and exists (
                  select 1
                  from public.student_practice_assignments assignment
                  where assignment.id = job.entity_id
                    and assignment.workspace_id = target_workspace_id
                    and assignment.student_id = target_student_id
                )
              )
              or (
                job.queue_name = 'worksheet_answer_evaluation'
                and job.job_kind = 'worksheet_answer_evaluation'
                and reservation.call_purpose in (
                  'worksheet_answer_evaluation',
                  'worksheet_answer_adjudication'
                )
                and exists (
                  select 1
                  from public.practice_test_attempts attempt
                  where attempt.id = job.entity_id
                    and attempt.workspace_id = target_workspace_id
                    and attempt.student_id = target_student_id
                )
              )
            )
        )
    )
    or exists (
      select 1
      from app_private.ai_spend_reservations reservation
      join app_private.async_jobs job on job.id = reservation.job_id
      where reservation.workspace_id <> target_workspace_id
        and (
          (
            job.job_kind = 'writing_evaluation'
            and exists (
              select 1
              from public.submissions submission
              where submission.id = job.entity_id
                and submission.workspace_id = target_workspace_id
            )
          )
          or (
            job.job_kind = 'worksheet_generation'
            and exists (
              select 1
              from public.student_practice_assignments assignment
              where assignment.id = job.entity_id
                and assignment.workspace_id = target_workspace_id
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
  then
    raise exception using
      errcode = '55000',
      message = 'scheduler_smoke_canary_spend_scope_invalid';
  end if;

  if exists (
    select 1
    from app_private.ai_spend_reservations reservation
    where reservation.workspace_id = target_workspace_id
      and reservation.state = 'reserved'
  ) then
    raise exception using
      errcode = '55000',
      message = 'scheduler_smoke_canary_spend_not_terminal';
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
      message = 'scheduler_smoke_canary_spend_overlap';
  end if;

  if exists (
    select 1
    from app_private.ai_canary_spend_archive archived
    where archived.original_workspace_id = target_workspace_id
      and (
        archived.archive_source <> 'scheduler_smoke_canary_cleanup'
        or archived.archive_run_id is null
        or not exists (
          select 1
          from app_private.async_jobs job
          where job.id = archived.original_job_id
            and job.entity_version = archived.entity_version
            and job.status in ('succeeded', 'dead')
            and (
              (
                job.queue_name = 'writing_evaluation'
                and job.job_kind = 'writing_evaluation'
                and archived.call_purpose in (
                  'writing_generation',
                  'writing_critique',
                  'writing_adjudication',
                  'writing_final_critique'
                )
                and exists (
                  select 1
                  from public.submissions submission
                  where submission.id = job.entity_id
                    and submission.workspace_id = target_workspace_id
                    and submission.student_id = target_student_id
                )
              )
              or (
                job.queue_name = 'worksheet_generation'
                and job.job_kind = 'worksheet_generation'
                and archived.call_purpose in (
                  'worksheet_generation',
                  'worksheet_critique'
                )
                and exists (
                  select 1
                  from public.student_practice_assignments assignment
                  where assignment.id = job.entity_id
                    and assignment.workspace_id = target_workspace_id
                    and assignment.student_id = target_student_id
                )
              )
              or (
                job.queue_name = 'worksheet_answer_evaluation'
                and job.job_kind = 'worksheet_answer_evaluation'
                and archived.call_purpose in (
                  'worksheet_answer_evaluation',
                  'worksheet_answer_adjudication'
                )
                and exists (
                  select 1
                  from public.practice_test_attempts attempt
                  where attempt.id = job.entity_id
                    and attempt.workspace_id = target_workspace_id
                    and attempt.student_id = target_student_id
                )
              )
            )
        )
      )
  ) then
    raise exception using
      errcode = '55000',
      message = 'scheduler_smoke_canary_archive_scope_invalid';
  end if;

  if exists (
    select 1
    from app_private.ai_canary_spend_archive archived
    where archived.archive_run_id = target_archive_run_id
      and (
        archived.archive_source <> 'scheduler_smoke_canary_cleanup'
        or archived.original_workspace_id <> target_workspace_id
      )
  ) then
    raise exception using
      errcode = '55000',
      message = 'scheduler_smoke_canary_archive_run_conflict';
  end if;

  select count(*)
  into active_reservation_count
  from app_private.ai_spend_reservations reservation
  where reservation.workspace_id = target_workspace_id;

  select count(*)
  into workspace_archive_count
  from app_private.ai_canary_spend_archive archived
  where archived.original_workspace_id = target_workspace_id
    and archived.archive_source = 'scheduler_smoke_canary_cleanup';

  select count(*)
  into existing_run_count
  from app_private.ai_canary_spend_archive archived
  where archived.original_workspace_id = target_workspace_id
    and archived.archive_source = 'scheduler_smoke_canary_cleanup'
    and archived.archive_run_id = target_archive_run_id;

  if active_reservation_count > 0 and existing_run_count > 0 then
    raise exception using
      errcode = '55000',
      message = 'scheduler_smoke_canary_archive_run_conflict';
  end if;

  if active_reservation_count = 0 then
    if workspace_archive_count > 0 and existing_run_count = 0 then
      raise exception using
        errcode = '55000',
        message = 'scheduler_smoke_canary_archive_run_conflict';
    end if;
    return query select
      existing_run_count,
      0::bigint,
      existing_run_count > 0;
    return;
  end if;

  select
    count(*),
    coalesce(sum(entry.reserved_microusd), 0)::bigint,
    coalesce(sum(entry.actual_microusd), 0)::bigint
  into
    accounting_count_before,
    accounting_reserved_before,
    accounting_actual_before
  from app_private.ai_spend_accounting_entries() entry
  where entry.reservation_id in (
    select reservation.id
    from app_private.ai_spend_reservations reservation
    where reservation.workspace_id = target_workspace_id
  );

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
      'scheduler_smoke_canary_cleanup',
      target_archive_run_id
    from app_private.ai_spend_reservations reservation
    where reservation.workspace_id = target_workspace_id
      and reservation.student_id = target_student_id
    order by reservation.id
    returning 1
  )
  select count(*) into inserted_count from copied;

  if inserted_count <> active_reservation_count then
    raise exception using
      errcode = '55000',
      message = 'scheduler_smoke_canary_archive_copy_incomplete';
  end if;

  perform set_config('app.ai_spend_transition', 'on', true);
  delete from app_private.ai_spend_reservations reservation
  where reservation.workspace_id = target_workspace_id
    and reservation.student_id = target_student_id
    and exists (
      select 1
      from app_private.ai_canary_spend_archive archived
      where archived.original_reservation_id = reservation.id
        and archived.original_workspace_id = target_workspace_id
        and archived.archive_source = 'scheduler_smoke_canary_cleanup'
        and archived.archive_run_id = target_archive_run_id
    );
  get diagnostics deleted_count = row_count;
  perform set_config('app.ai_spend_transition', 'off', true);

  if deleted_count <> inserted_count then
    raise exception using
      errcode = '55000',
      message = 'scheduler_smoke_canary_archive_delete_mismatch';
  end if;

  select count(*)
  into remaining_count
  from app_private.ai_spend_reservations reservation
  where reservation.workspace_id = target_workspace_id;

  if remaining_count <> 0 then
    raise exception using
      errcode = '55000',
      message = 'scheduler_smoke_canary_archive_scope_drift';
  end if;

  select
    count(*),
    coalesce(sum(entry.reserved_microusd), 0)::bigint,
    coalesce(sum(entry.actual_microusd), 0)::bigint
  into
    accounting_count_after,
    accounting_reserved_after,
    accounting_actual_after
  from app_private.ai_spend_accounting_entries() entry
  where entry.reservation_id in (
    select archived.original_reservation_id
    from app_private.ai_canary_spend_archive archived
    where archived.original_workspace_id = target_workspace_id
      and archived.archive_source = 'scheduler_smoke_canary_cleanup'
      and archived.archive_run_id = target_archive_run_id
  );

  if accounting_count_before <> inserted_count
    or accounting_count_after <> accounting_count_before
    or accounting_reserved_after <> accounting_reserved_before
    or accounting_actual_after <> accounting_actual_before
  then
    raise exception using
      errcode = '55000',
      message = 'scheduler_smoke_canary_accounting_mismatch';
  end if;

  return query select inserted_count, inserted_count, false;
exception
  when lock_not_available then
    raise exception using
      errcode = '55000',
      message = 'scheduler_smoke_canary_busy';
end;
$$;

revoke all on function app_private.archive_scheduler_smoke_canary_spend(
  uuid, text, uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function app_private.archive_scheduler_smoke_canary_spend(
  uuid, text, uuid, uuid
) to service_role;

comment on table app_private.ai_canary_spend_archive is
  'Content-free immutable spend evidence detached only for exact synthetic writing-live, worksheet-live, or scheduler-smoke fixtures; never used for normal tenant cleanup.';
comment on function app_private.archive_scheduler_smoke_canary_spend(
  uuid, text, uuid, uuid
) is
  'Private service-only fail-closed copy-before-delete archival for terminal spend in the exact long-lived scheduler smoke fixture; archive_run_id is caller-supplied for exact replay.';
