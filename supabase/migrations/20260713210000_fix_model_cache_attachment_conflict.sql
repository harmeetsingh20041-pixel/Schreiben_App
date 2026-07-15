-- Phase 14D: keep a cache hit from failing at the final attachment ledger.
--
-- request_practice_worksheet_before_phase_13f() returns a TABLE whose output
-- columns include assignment_id.  PL/pgSQL therefore treats the named
-- ON CONFLICT target as ambiguous between that output variable and the table
-- column.  An untargeted DO NOTHING has the same idempotency semantics here:
-- the attachment table has no other applicable user-supplied unique key for a
-- request event, while its generated primary key cannot collide.

do $migration$
declare
  function_definition text;
  corrected_definition text;
  conflict_pattern constant text :=
    'on\s+conflict\s*\(\s*attachment_source\s*,\s*assignment_id\s*,\s*cloned_practice_test_id\s*\)\s*do\s+nothing';
begin
  select pg_get_functiondef(
    'public.request_practice_worksheet_before_phase_13f(uuid)'::regprocedure
  )
  into function_definition;

  if function_definition is null
    or function_definition !~* conflict_pattern
  then
    raise exception using
      errcode = '55000',
      message = 'phase14d_expected_conflict_target_missing';
  end if;

  corrected_definition := pg_catalog.regexp_replace(
    function_definition,
    conflict_pattern,
    'ON CONFLICT DO NOTHING',
    'i'
  );

  if corrected_definition ~* conflict_pattern
    or corrected_definition not like '%ON CONFLICT DO NOTHING%'
  then
    raise exception using
      errcode = '55000',
      message = 'phase14d_conflict_target_rewrite_failed';
  end if;

  execute corrected_definition;
end;
$migration$;

comment on function public.request_practice_worksheet_before_phase_13f(uuid) is
  'Phase 14D: preserves certified-bank, same-workspace, model-cache, and paid-fallback ordering while recording idempotent cache attachments without PL/pgSQL output-column ambiguity.';
