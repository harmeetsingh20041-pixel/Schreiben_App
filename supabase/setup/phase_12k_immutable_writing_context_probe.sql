-- Shared-staging-safe Phase 12K probe.
--
-- Apply the Phase 12K migration and this file in one transaction with
-- ON_ERROR_STOP enabled. Every fixture, job, message, and schema change is
-- rolled back; the probe never claims or purges a shared queue.

begin;

create temporary table phase_12k_probe_state (
  singleton boolean primary key default true check (singleton),
  teacher_id uuid not null,
  student_id uuid not null,
  workspace_id uuid not null,
  batch_id uuid not null,
  question_id uuid not null,
  submission_id uuid
) on commit drop;

insert into phase_12k_probe_state (
  teacher_id, student_id, workspace_id, batch_id, question_id
)
values (
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
  gen_random_uuid(), gen_random_uuid()
);

grant select, update on phase_12k_probe_state to authenticated, service_role;

do $fixtures$
declare
  state_record record;
  created_submission record;
begin
  select * into state_record from pg_temp.phase_12k_probe_state;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  )
  values
    (
      '00000000-0000-0000-0000-000000000000',
      state_record.teacher_id,
      'authenticated', 'authenticated',
      format('phase12k-teacher-%s@example.test', state_record.teacher_id),
      '', now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{"full_name":"Phase 12K probe teacher"}'::jsonb,
      now(), now()
    ),
    (
      '00000000-0000-0000-0000-000000000000',
      state_record.student_id,
      'authenticated', 'authenticated',
      format('phase12k-student-%s@example.test', state_record.student_id),
      '', now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{"full_name":"Phase 12K probe student"}'::jsonb,
      now(), now()
    );

  insert into public.workspaces (id, name, slug, owner_id)
  values (
    state_record.workspace_id,
    'Phase 12K shared-safe probe',
    format(
      'phase12k-probe-%s',
      replace(state_record.workspace_id::text, '-', '')
    ),
    state_record.teacher_id
  );

  insert into public.workspace_members (workspace_id, user_id, role)
  values
    (state_record.workspace_id, state_record.teacher_id, 'teacher'),
    (state_record.workspace_id, state_record.student_id, 'student');

  insert into public.batches (
    id, workspace_id, name, level, is_active, feedback_mode
  ) values (
    state_record.batch_id,
    state_record.workspace_id,
    'Phase 12K probe A2',
    'A2', true, 'immediate'
  );

  insert into public.batch_students (
    batch_id, student_id, workspace_id
  ) values (
    state_record.batch_id,
    state_record.student_id,
    state_record.workspace_id
  );

  insert into public.questions (
    id, workspace_id, title, prompt, level, topic, task_type,
    expected_word_min, expected_word_max, estimated_minutes, is_active
  ) values (
    state_record.question_id,
    state_record.workspace_id,
    'Probe title', 'Probe prompt', 'A2', 'Probe topic', 'writing',
    30, 60, 10, true
  );

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', state_record.student_id,
      'role', 'authenticated'
    )::text,
    true
  );
  perform set_config(
    'request.jwt.claim.sub', state_record.student_id::text, true
  );
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  select submitted.*
  into created_submission
  from api.submit_writing(
    state_record.batch_id,
    'workspace_question',
    state_record.question_id,
    E'  Unveränderter Text.\n\nZweiter Absatz.  '
  ) submitted;

  if created_submission.submission_id is null then
    raise exception 'Phase 12K probe submission was not created.';
  end if;

  update pg_temp.phase_12k_probe_state
  set submission_id = created_submission.submission_id
  where singleton;

  if not exists (
    select 1
    from app_private.writing_evaluation_contexts context
    where context.submission_id = created_submission.submission_id
      and context.workspace_id = state_record.workspace_id
      and context.student_id = state_record.student_id
      and context.batch_id = state_record.batch_id
      and context.cefr_level = 'A2'
      and context.source_type = 'workspace_question'
      and context.source_id = state_record.question_id
      and context.question_metadata ->> 'title' = 'Probe title'
      and context.question_metadata ->> 'prompt' = 'Probe prompt'
      and context.question_metadata ->> 'topic' = 'Probe topic'
      and context.original_text_sha256 = pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(
            E'  Unveränderter Text.\n\nZweiter Absatz.  ',
            'UTF8'
          )
        ),
        'hex'
      )
  ) then
    raise exception 'Phase 12K snapshot did not preserve exact context.';
  end if;

  if exists (
    select 1
    from information_schema.columns column_info
    where column_info.table_schema = 'app_private'
      and column_info.table_name = 'writing_evaluation_contexts'
      and column_info.column_name in ('original_text', 'writing_text', 'answer_text')
  ) then
    raise exception 'Phase 12K duplicated raw writing in the snapshot.';
  end if;

  if not exists (
    select 1
    from app_private.async_jobs job
    join pgmq.q_writing_evaluation queue
      on queue.msg_id = job.queue_message_id
    where job.entity_id = created_submission.submission_id
      and (
        select count(*) = 4
        from jsonb_object_keys(queue.message)
      )
      and queue.message::text not like '%Unveränderter%'
      and queue.message::text not like '%Probe prompt%'
  ) then
    raise exception 'Phase 12K queue payload leaked context or writing.';
  end if;

  update public.batches
  set level = 'B1'
  where id = state_record.batch_id;

  update public.questions
  set
    title = 'Mutated title',
    prompt = 'Mutated prompt',
    level = 'B1',
    topic = 'Mutated topic'
  where id = state_record.question_id;
end;
$fixtures$;

set local role service_role;

do $worker$
declare
  state_record record;
  loaded_context record;
begin
  select * into state_record from pg_temp.phase_12k_probe_state;

  select context.*
  into loaded_context
  from api.get_writing_evaluation_context(state_record.submission_id) context;

  if loaded_context.submission_id is null
    or loaded_context.workspace_id <> state_record.workspace_id
    or loaded_context.batch_level <> 'A2'
    or loaded_context.question_title <> 'Probe title'
    or loaded_context.question_prompt <> 'Probe prompt'
    or loaded_context.question_level <> 'A2'
    or loaded_context.question_topic <> 'Probe topic'
    or loaded_context.original_text <>
      E'  Unveränderter Text.\n\nZweiter Absatz.  '
  then
    raise exception 'Phase 12K worker loaded mutable live context.';
  end if;
end;
$worker$;

reset role;

set local role authenticated;

do $actor_detail$
declare
  selected_submission_id uuid;
  detail jsonb;
begin
  select submission_id
  into selected_submission_id
  from pg_temp.phase_12k_probe_state;

  detail := api.get_submission_detail(selected_submission_id);
  if detail #>> '{submission,question_title}' <> 'Probe title'
    or detail #>> '{submission,question_prompt}' <> 'Probe prompt'
    or detail #>> '{submission,question_level}' <> 'A2'
    or detail #>> '{submission,question_topic}' <> 'Probe topic'
    or detail #>> '{submission,batch_level}' <> 'A2'
    or not ((detail -> 'submission') ? 'automatic_retry_at')
    or not ((detail -> 'submission') ? 'automatic_retry_exhausted_at')
  then
    raise exception 'Phase 12K actor detail drifted or lost recovery fields.';
  end if;
end;
$actor_detail$;

reset role;

do $immutability$
declare
  selected_submission_id uuid;
begin
  select submission_id
  into selected_submission_id
  from pg_temp.phase_12k_probe_state;

  begin
    update public.submissions
    set original_text = 'Tampered text'
    where id = selected_submission_id;
    raise exception 'Phase 12K allowed original-text mutation.';
  exception
    when sqlstate '55000' then
      if sqlerrm <> 'writing_submission_context_immutable' then
        raise;
      end if;
  end;

  begin
    update app_private.writing_evaluation_contexts
    set cefr_level = 'B1'
    where submission_id = selected_submission_id;
    raise exception 'Phase 12K allowed context mutation.';
  exception
    when sqlstate '55000' then
      if sqlerrm <> 'writing_evaluation_context_immutable' then
        raise;
      end if;
  end;
end;
$immutability$;

do $legacy_quarantine_and_recovery$
declare
  state_record record;
  recovery_result jsonb;
  retry_result record;
begin
  if to_regclass('pg_temp.phase_12k_legacy_pre_state') is null then
    return;
  end if;

  select *
  into state_record
  from pg_temp.phase_12k_legacy_pre_state;

  if not exists (
    select 1
    from app_private.practice_resolution_cycles cycle
    join public.student_practice_assignments assignment
      on assignment.resolution_cycle_id = cycle.id
    join app_private.async_jobs job on job.id = state_record.job_id
    where cycle.id = state_record.cycle_id
      and assignment.id = state_record.assignment_id
      and cycle.class_context_version = 0
      and cycle.batch_id is null
      and cycle.worksheet_level is null
      and cycle.class_context_integrity = 'legacy_unverified'
      and assignment.class_context_version = 0
      and assignment.batch_id is null
      and assignment.worksheet_level is null
      and assignment.class_context_integrity = 'legacy_unverified'
      and assignment.generation_status = 'failed'
      and assignment.generation_error = 'worksheet_class_context_required'
      and job.status = 'dead'
      and job.last_error_code = 'worksheet_class_context_required'
  ) then
    raise exception 'Phase 12K did not quarantine the promoted legacy context.';
  end if;

  begin
    update public.student_practice_assignments assignment
    set class_context_integrity = 'teacher_verified'
    where assignment.id = state_record.assignment_id;
    raise exception 'Phase 12K allowed an integrity-only legacy relabel.';
  exception
    when sqlstate '55000' then
      if sqlerrm <> 'Practice assignment class context is immutable.' then
        raise;
      end if;
  end;

  if not exists (
    select 1
    from public.student_practice_assignments assignment
    where assignment.id = state_record.assignment_id
      and assignment.class_context_version = 0
      and assignment.class_context_integrity = 'legacy_unverified'
  ) then
    raise exception 'Phase 12K integrity-only relabel was not rolled back.';
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', state_record.teacher_id, 'role', 'authenticated')::text,
    true
  );
  perform set_config('request.jwt.claim.sub', state_record.teacher_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  recovery_result := api.resolve_practice_assignment_class_context(
    state_record.assignment_id,
    state_record.batch_id
  );

  if recovery_result ->> 'worksheet_level' <> 'A2'
    or not exists (
      select 1
      from app_private.practice_resolution_cycles cycle
      join public.student_practice_assignments assignment
        on assignment.resolution_cycle_id = cycle.id
      where cycle.id = state_record.cycle_id
        and assignment.id = state_record.assignment_id
        and cycle.class_context_version = 1
        and cycle.class_context_integrity = 'teacher_verified'
        and assignment.class_context_version = 1
        and assignment.class_context_integrity = 'teacher_verified'
    )
  then
    raise exception 'Phase 12K teacher recovery did not create audited provenance.';
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', state_record.student_id, 'role', 'authenticated')::text,
    true
  );
  perform set_config('request.jwt.claim.sub', state_record.student_id::text, true);

  select requested.*
  into retry_result
  from api.request_practice_worksheet(state_record.assignment_id) requested;

  if retry_result.job_id is null
    or not exists (
      select 1
      from app_private.async_jobs job
      where job.id = retry_result.job_id
        and job.entity_id = state_record.assignment_id
        and job.status = 'queued'
    )
  then
    raise exception 'Phase 12K verified teacher recovery could not requeue safely.';
  end if;
end;
$legacy_quarantine_and_recovery$;

rollback;
