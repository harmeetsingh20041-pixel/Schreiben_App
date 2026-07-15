-- Both checkpoint save functions return a column named provider_name. In
-- PL/pgSQL, the column-list form of ON CONFLICT therefore collides with that
-- output variable when the save path is first executed. Target the existing
-- primary-key constraint explicitly so checkpoint persistence and its spend
-- finalization remain one atomic operation.

begin;

do $patch_checkpoint_conflict_targets$
declare
  function_signature regprocedure;
  function_definition text;
  original_fragment constant text :=
    'on conflict (job_id, checkpoint_role, provider_name) do nothing';
  replacement_fragment constant text :=
    'on conflict on constraint worksheet_answer_provider_checkpoints_pkey do nothing';
begin
  foreach function_signature in array array[
    'app_private.save_worksheet_answer_provider_checkpoint(uuid,bigint,uuid,uuid,integer,text,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint,integer,integer)'::regprocedure,
    'app_private.save_worksheet_answer_adjudication_checkpoint(uuid,bigint,uuid,uuid,integer,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint,integer,integer)'::regprocedure
  ]
  loop
    select pg_get_functiondef(function_signature)
    into function_definition;

    if function_definition is null
      or length(function_definition)
        - length(replace(function_definition, original_fragment, ''))
        <> length(original_fragment)
    then
      raise exception using
        errcode = '55000',
        message = 'worksheet_answer_checkpoint_conflict_patch_precondition_failed';
    end if;

    execute replace(
      function_definition,
      original_fragment,
      replacement_fragment
    );
  end loop;
end;
$patch_checkpoint_conflict_targets$;

revoke all on function
  app_private.save_worksheet_answer_provider_checkpoint(
    uuid, bigint, uuid, uuid, integer, text, text, text, text, jsonb,
    text, text, bigint, bigint, bigint, bigint, integer, integer
  )
from public, anon, authenticated, service_role;

revoke all on function
  app_private.save_worksheet_answer_adjudication_checkpoint(
    uuid, bigint, uuid, uuid, integer, text, text, text, jsonb,
    text, text, bigint, bigint, bigint, bigint, integer, integer
  )
from public, anon, authenticated, service_role;

commit;
