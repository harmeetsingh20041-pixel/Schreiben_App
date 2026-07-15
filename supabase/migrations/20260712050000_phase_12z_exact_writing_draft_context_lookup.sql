-- Phase 12Z: exact, authorized writing-draft restoration.
--
-- The writing page previously fetched at most 100 recent drafts and searched
-- that capped result in the browser. A valid older draft could therefore be
-- missed, while the unique context index correctly prevented creation of a
-- duplicate. This narrow read model resolves one complete context directly
-- through the existing active-class and writing-source authorization checks.

create or replace function public.get_writing_draft_by_context_internal(
  target_workspace_id uuid,
  target_batch_id uuid,
  target_source_type text,
  target_source_id uuid
)
returns table (
  draft_id uuid,
  workspace_id uuid,
  batch_id uuid,
  source_type text,
  source_id uuid,
  "text" text,
  revision integer,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  authorized_workspace_id uuid;
begin
  authorized_workspace_id := app_private.assert_writing_draft_context(
    target_batch_id,
    target_source_type,
    target_source_id
  );

  if target_workspace_id is null
    or authorized_workspace_id <> target_workspace_id
  then
    raise exception using
      errcode = '42501',
      message = 'writing_workspace_context_mismatch';
  end if;

  return query
  select
    draft.id,
    draft.workspace_id,
    draft.batch_id,
    draft.source_type,
    draft.source_id,
    draft.content,
    draft.revision,
    draft.updated_at
  from app_private.writing_drafts draft
  where draft.student_id = caller_id
    and draft.workspace_id = target_workspace_id
    and draft.batch_id = target_batch_id
    and draft.source_type = target_source_type
    and coalesce(
      draft.source_id,
      '00000000-0000-0000-0000-000000000000'::uuid
    ) = coalesce(
      target_source_id,
      '00000000-0000-0000-0000-000000000000'::uuid
    );
end;
$$;

revoke all on function public.get_writing_draft_by_context_internal(
  uuid, uuid, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.get_writing_draft_by_context_internal(
  uuid, uuid, text, uuid
) to authenticated;

create or replace function api.get_writing_draft_by_context(
  target_workspace_id uuid,
  target_batch_id uuid,
  target_source_type text,
  target_source_id uuid
)
returns table (
  draft_id uuid,
  workspace_id uuid,
  batch_id uuid,
  source_type text,
  source_id uuid,
  "text" text,
  revision integer,
  updated_at timestamptz
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from public.get_writing_draft_by_context_internal(
    target_workspace_id,
    target_batch_id,
    target_source_type,
    target_source_id
  );
$$;

revoke all on function api.get_writing_draft_by_context(
  uuid, uuid, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function api.get_writing_draft_by_context(
  uuid, uuid, text, uuid
) to authenticated;

comment on function api.get_writing_draft_by_context(uuid, uuid, text, uuid) is
  'Returns the caller-owned draft for one authorized workspace, class, and writing-source context without a capped client-side search.';
