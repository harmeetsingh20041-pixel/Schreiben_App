-- Shared-staging-safe probe for the overdue Scheduled teacher rescue.
-- It creates isolated random fixtures, never calls the global due-release
-- consumer, and rolls every change back. Run with ON_ERROR_STOP enabled.

begin;

do $probe$
declare
  probe_teacher_id uuid := gen_random_uuid();
  probe_student_id uuid := gen_random_uuid();
  probe_workspace_id uuid := gen_random_uuid();
  probe_submission_id uuid := gen_random_uuid();
  probe_draft_id uuid := gen_random_uuid();
  release_result jsonb;
  audit_count integer;
begin
  insert into auth.users (
    instance_id,
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at
  )
  values
    (
      '00000000-0000-0000-0000-000000000000',
      probe_teacher_id,
      'authenticated',
      'authenticated',
      format('scheduled-rescue-teacher-%s@example.test', probe_teacher_id),
      '',
      now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{"full_name":"Scheduled rescue probe teacher"}'::jsonb,
      now(),
      now()
    ),
    (
      '00000000-0000-0000-0000-000000000000',
      probe_student_id,
      'authenticated',
      'authenticated',
      format('scheduled-rescue-student-%s@example.test', probe_student_id),
      '',
      now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{"full_name":"Scheduled rescue probe student"}'::jsonb,
      now(),
      now()
    );

  insert into public.workspaces (id, name, slug, owner_id)
  values (
    probe_workspace_id,
    'Scheduled rescue probe workspace',
    format(
      'scheduled-rescue-probe-%s',
      replace(probe_workspace_id::text, '-', '')
    ),
    probe_teacher_id
  );

  insert into public.workspace_members (workspace_id, user_id, role)
  values
    (probe_workspace_id, probe_teacher_id, 'teacher'),
    (probe_workspace_id, probe_student_id, 'student');

  insert into public.submissions (
    id,
    workspace_id,
    student_id,
    mode,
    question_source,
    original_text,
    status,
    feedback_mode,
    feedback_scheduled_at,
    evaluation_status,
    release_status,
    release_at
  ) values (
    probe_submission_id,
    probe_workspace_id,
    probe_student_id,
    'free_text',
    'free_text',
    'Alles gut.',
    'checked',
    'automatic_delayed',
    now() - interval '1 minute',
    'ready',
    'scheduled',
    now() - interval '1 minute'
  );

  insert into app_private.feedback_drafts (
    id,
    submission_id,
    version,
    state,
    content,
    provider_model
  ) values (
    probe_draft_id,
    probe_submission_id,
    1,
    'draft',
    jsonb_build_object(
      'overall_summary', 'The writing is correct.',
      'level_detected', 'A2',
      'corrected_text', 'Alles gut.',
      'lines', jsonb_build_array(jsonb_build_object(
        'line_number', 1,
        'source_start', 0,
        'source_end', 10,
        'original_line', 'Alles gut.',
        'corrected_line', 'Alles gut.',
        'status', 'correct',
        'changed_parts', '[]'::jsonb,
        'short_explanation', '',
        'detailed_explanation', '',
        'grammar_topic', ''
      )),
      'grammar_topics', '[]'::jsonb,
      'score_summary', '{}'::jsonb
    ),
    'shared-staging-safe-probe'
  );

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', probe_teacher_id, 'role', 'authenticated'
    )::text,
    true
  );
  perform set_config('request.jwt.claim.sub', probe_teacher_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  release_result := api.release_feedback(
    probe_submission_id,
    probe_draft_id
  );
  if release_result ->> 'release_status' <> 'released' then
    raise exception 'Overdue rescue did not return the released state.';
  end if;

  if not exists (
    select 1
    from public.submissions submission
    where submission.id = probe_submission_id
      and submission.release_status = 'released'
      and submission.corrected_text = 'Alles gut.'
  ) then
    raise exception 'Overdue rescue did not materialize complete feedback.';
  end if;

  select count(*)::integer
  into audit_count
  from app_private.feedback_draft_events event
  where event.feedback_draft_id = probe_draft_id
    and event.actor_id = probe_teacher_id
    and event.event_type in ('teacher_approved', 'teacher_released');

  if audit_count <> 2 then
    raise exception 'Overdue rescue did not retain both teacher audit events.';
  end if;

  release_result := api.release_feedback(
    probe_submission_id,
    probe_draft_id
  );
  if release_result ->> 'release_status' <> 'released' then
    raise exception 'Repeated overdue rescue was not idempotent.';
  end if;

  if (
    select count(*)
    from app_private.feedback_draft_events event
    where event.feedback_draft_id = probe_draft_id
  ) <> 2 then
    raise exception 'Repeated overdue rescue duplicated audit events.';
  end if;
end;
$probe$;

rollback;
