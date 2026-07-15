-- Preserve the exact deterministic primary-generation failure across the
-- durable Gemini fallback stage. Without this field the worker cannot tell a
-- genuine provider outage from a structurally invalid candidate, so it sends
-- generic outage guidance and the smaller outage token budget for both.

drop function if exists api.get_worksheet_generation_checkpoint(
  uuid, bigint, uuid, integer
);
drop function if exists app_private.get_worksheet_generation_checkpoint(
  uuid, bigint, uuid, integer
);

create function app_private.get_worksheet_generation_checkpoint(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  expected_entity_version integer
)
returns table (
  job_id uuid,
  assignment_id uuid,
  entity_version integer,
  stage text,
  candidate_attempt smallint,
  candidate_provider text,
  candidate_model text,
  candidate_sha256 text,
  candidate jsonb,
  completion_payload jsonb,
  fallback_failure_code text,
  primary_rejection jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job app_private.async_jobs%rowtype;
begin
  selected_job := app_private.assert_active_worksheet_generation_lease(
    target_job_id,
    target_queue_message_id,
    worker_id,
    expected_entity_version
  );

  return query
  select
    checkpoint.job_id,
    checkpoint.assignment_id,
    checkpoint.entity_version,
    checkpoint.stage,
    checkpoint.candidate_attempt,
    checkpoint.candidate_provider,
    checkpoint.candidate_model,
    checkpoint.candidate_sha256,
    checkpoint.candidate,
    checkpoint.completion_payload,
    checkpoint.fallback_failure_code,
    case
      when evidence.job_id is null then null
      else jsonb_build_object(
        'attempt_number', evidence.candidate_attempt,
        'provider', evidence.candidate_provider,
        'model', evidence.candidate_model,
        'rejection_reasons', evidence.rejection_reasons,
        'candidate', evidence.rejected_candidate
      )
    end
  from app_private.worksheet_generation_checkpoints checkpoint
  left join app_private.worksheet_generation_stage_evidence evidence
    on evidence.job_id = checkpoint.job_id
   and evidence.assignment_id = checkpoint.assignment_id
   and evidence.entity_version = checkpoint.entity_version
  where checkpoint.job_id = selected_job.id
    and checkpoint.assignment_id = selected_job.entity_id
    and checkpoint.entity_version = selected_job.entity_version;
end;
$$;

revoke all on function app_private.get_worksheet_generation_checkpoint(
  uuid, bigint, uuid, integer
) from public, anon, authenticated, service_role;
grant execute on function app_private.get_worksheet_generation_checkpoint(
  uuid, bigint, uuid, integer
) to service_role;

create function api.get_worksheet_generation_checkpoint(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  expected_entity_version integer
)
returns table (
  job_id uuid,
  assignment_id uuid,
  entity_version integer,
  stage text,
  candidate_attempt smallint,
  candidate_provider text,
  candidate_model text,
  candidate_sha256 text,
  candidate jsonb,
  completion_payload jsonb,
  fallback_failure_code text,
  primary_rejection jsonb
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from app_private.get_worksheet_generation_checkpoint(
    target_job_id,
    target_queue_message_id,
    worker_id,
    expected_entity_version
  );
$$;

revoke all on function api.get_worksheet_generation_checkpoint(
  uuid, bigint, uuid, integer
) from public, anon, authenticated;
grant execute on function api.get_worksheet_generation_checkpoint(
  uuid, bigint, uuid, integer
) to service_role;

comment on function api.get_worksheet_generation_checkpoint(
  uuid, bigint, uuid, integer
) is
  'Service-only durable worksheet checkpoint, including the content-free primary failure code used for targeted bounded fallback guidance.';

notify pgrst, 'reload schema';
