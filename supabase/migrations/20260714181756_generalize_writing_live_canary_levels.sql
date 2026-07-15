begin;

-- The writing reliability matrix is intentionally A1-B2. Preserve the exact
-- synthetic workspace/batch/service-role identity boundary while removing the
-- stale A1-only predicate from its private spend-archive implementation.
do $generalize_writing_live_canary_levels$
declare
  target_function regprocedure :=
    'app_private.archive_writing_live_canary_spend(uuid,text,uuid)'::regprocedure;
  current_definition text;
  patched_definition text;
  old_predicate constant text := 'batch.level = ''A1''';
  new_predicate constant text :=
    'batch.level in (''A1'', ''A2'', ''B1'', ''B2'')';
  replacement_count integer;
begin
  select pg_get_functiondef(target_function)
  into current_definition;

  replacement_count := (
    length(current_definition) -
    length(replace(current_definition, old_predicate, ''))
  ) / length(old_predicate);
  if replacement_count <> 1 then
    raise exception using
      errcode = '55000',
      message = 'writing_live_canary_level_patch_contract_invalid';
  end if;

  patched_definition := replace(
    current_definition,
    old_predicate,
    new_predicate
  );
  execute patched_definition;

  if position(
    new_predicate in pg_get_functiondef(target_function)
  ) = 0 then
    raise exception using
      errcode = '55000',
      message = 'writing_live_canary_level_patch_verification_failed';
  end if;
end;
$generalize_writing_live_canary_levels$;

comment on function app_private.archive_writing_live_canary_spend(
  uuid, text, uuid
) is
  'Private fail-closed atomic copy-before-delete implementation for terminal spend belonging to one deterministic A1-B2 writing-live staging fixture.';

commit;
