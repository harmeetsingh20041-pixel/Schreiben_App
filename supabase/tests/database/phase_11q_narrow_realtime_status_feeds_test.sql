begin;

select plan(11);

select ok(
  exists (
    select 1
    from information_schema.columns column_info
    where column_info.table_schema = 'public'
      and column_info.table_name = 'practice_test_attempts'
      and column_info.column_name = 'updated_at'
      and column_info.is_nullable = 'NO'
  )
    and exists (
      select 1
      from pg_trigger
      where tgrelid = 'public.practice_test_attempts'::regclass
        and tgname = 'practice_test_attempts_set_updated_at'
        and not tgisinternal
    ),
  'practice attempts maintain the revision timestamp used by the narrow feed'
);

select ok(
  to_regclass('api.submission_status_events') is not null
    and to_regclass('api.practice_assignment_status_events') is not null
    and to_regclass('api.practice_attempt_status_events') is not null,
  'Realtime uses dedicated status-only API tables'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'api.submission_status_events'::regclass)
    and (select relrowsecurity from pg_class where oid = 'api.practice_assignment_status_events'::regclass)
    and (select relrowsecurity from pg_class where oid = 'api.practice_attempt_status_events'::regclass),
  'every Realtime feed enforces row-level authorization'
);

select ok(
  has_table_privilege('authenticated', 'api.submission_status_events', 'SELECT')
    and has_table_privilege('authenticated', 'api.practice_assignment_status_events', 'SELECT')
    and has_table_privilege('authenticated', 'api.practice_attempt_status_events', 'SELECT')
    and not has_table_privilege('authenticated', 'api.submission_status_events', 'INSERT,UPDATE,DELETE')
    and not has_table_privilege('authenticated', 'api.practice_assignment_status_events', 'INSERT,UPDATE,DELETE')
    and not has_table_privilege('authenticated', 'api.practice_attempt_status_events', 'INSERT,UPDATE,DELETE'),
  'authenticated clients can read status but cannot forge it'
);

select ok(
  not has_table_privilege('anon', 'api.submission_status_events', 'SELECT')
    and not has_table_privilege('anon', 'api.practice_assignment_status_events', 'SELECT')
    and not has_table_privilege('anon', 'api.practice_attempt_status_events', 'SELECT'),
  'anonymous clients cannot subscribe to status feeds'
);

select ok(
  not exists (
    select 1
    from information_schema.columns column_info
    where column_info.table_schema = 'api'
      and column_info.table_name in (
        'submission_status_events',
        'practice_assignment_status_events',
        'practice_attempt_status_events'
      )
      and column_info.column_name in (
        'original_text',
        'corrected_text',
        'overall_summary',
        'feedback_error',
        'answer_text',
        'submitted_answers',
        'evaluation_error',
        'provider_payload'
      )
  ),
  'published rows contain no writing, answers, provider payloads, or raw errors'
);

select ok(
  not exists (
    select 1
    from pg_publication_tables publication_table
    where publication_table.pubname = 'supabase_realtime'
      and publication_table.schemaname = 'public'
      and publication_table.tablename in (
        'submissions',
        'student_practice_assignments',
        'practice_test_attempts'
      )
  ),
  'content-bearing source tables are absent from the Realtime publication'
);

select is(
  (
    select count(*)::integer
    from pg_publication_tables publication_table
    where publication_table.pubname = 'supabase_realtime'
      and publication_table.schemaname = 'api'
      and publication_table.tablename in (
        'submission_status_events',
        'practice_assignment_status_events',
        'practice_attempt_status_events'
      )
  ),
  3,
  'all three narrow status feeds are published'
);

select ok(
  exists (
    select 1 from pg_trigger
    where tgrelid = 'public.submissions'::regclass
      and tgname = 'submissions_sync_realtime_status'
      and not tgisinternal
  )
    and exists (
      select 1 from pg_trigger
      where tgrelid = 'public.student_practice_assignments'::regclass
        and tgname = 'practice_assignments_sync_realtime_status'
        and not tgisinternal
    )
    and exists (
      select 1 from pg_trigger
      where tgrelid = 'public.practice_test_attempts'::regclass
        and tgname = 'practice_attempts_sync_realtime_status'
        and not tgisinternal
    ),
  'source-row transitions synchronize every status feed'
);

select ok(
  (select prosecdef from pg_proc where oid = 'app_private.sync_realtime_status_feed()'::regprocedure)
    and pg_get_functiondef('app_private.sync_realtime_status_feed()'::regprocedure)
      like '%new.evaluation_status is null or new.release_status is null%'
    and not has_function_privilege(
      'authenticated',
      'app_private.sync_realtime_status_feed()',
      'EXECUTE'
    ),
  'the trigger writer is definer-owned and not client-callable'
);

select ok(
  not exists (
    select 1
    from pg_policy policy
    where policy.polrelid in (
      'api.submission_status_events'::regclass,
      'api.practice_assignment_status_events'::regclass,
      'api.practice_attempt_status_events'::regclass
    )
      and pg_get_expr(policy.polqual, policy.polrelid) not like '%is_workspace_member%'
  ),
  'student status subscriptions require current workspace membership'
);

select * from finish();
rollback;
