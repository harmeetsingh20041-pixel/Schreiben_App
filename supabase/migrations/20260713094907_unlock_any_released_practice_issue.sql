-- Every canonical issue in released, validated writing feedback is actionable
-- practice evidence. Severity and repetition still determine presentation
-- priority, but they no longer decide whether a learner may practise at all.
--
-- Keep this policy in one private predicate and surgically update the mature
-- adaptive state machine. The existing resolution epochs, exact class/CEFR
-- snapshots, low-CEFR level-fit gate, certified-bank selector, one-active-row
-- indexes, and paid generation controls remain authoritative.

create or replace function app_private.practice_issue_count_unlocks(
  target_minor_issue_count integer,
  target_major_issue_count integer
)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select
    coalesce(target_minor_issue_count, 0) >= 0
    and coalesce(target_major_issue_count, 0) >= 0
    and (
      coalesce(target_minor_issue_count, 0)
      + coalesce(target_major_issue_count, 0)
    ) >= 1;
$$;

revoke all on function app_private.practice_issue_count_unlocks(integer, integer)
from public, anon, authenticated, service_role;

-- Preserve the latest cycle-update guard byte-for-byte except for its two
-- threshold predicates. Refuse to migrate if the expected predecessor shape
-- changed, rather than silently weakening a future guard revision.
do $patch_practice_cycle_guard$
declare
  function_definition text;
  patched_definition text;
  threshold_pattern text :=
    'expected_major_issue_count >= 1[[:space:]]+or expected_minor_issue_count >= 3';
  match_count integer;
begin
  select pg_get_functiondef(
    'app_private.guard_practice_resolution_cycle_update()'::regprocedure
  ) into function_definition;

  select count(*)::integer
  into match_count
  from regexp_matches(function_definition, threshold_pattern, 'g');

  if function_definition is null or match_count <> 2 then
    raise exception using
      errcode = '55000',
      message = 'practice_cycle_guard_unlock_policy_anchor_changed';
  end if;

  patched_definition := regexp_replace(
    function_definition,
    threshold_pattern,
    'app_private.practice_issue_count_unlocks('
      || 'expected_minor_issue_count, expected_major_issue_count)',
    'g'
  );

  if patched_definition = function_definition
    or patched_definition ~ threshold_pattern
  then
    raise exception using
      errcode = '55000',
      message = 'practice_cycle_guard_unlock_policy_patch_failed';
  end if;

  execute patched_definition;
end;
$patch_practice_cycle_guard$;

-- Reconciliation owns both new-cycle creation and unfrozen evidence refresh.
-- Update both predicates while retaining its advisory lock, class-context
-- revalidation, resolution-epoch and assignment-selection behavior.
do $patch_practice_reconciler$
declare
  function_definition text;
  patched_definition text;
  threshold_pattern text :=
    'unresolved_major >= 1[[:space:]]+or unresolved_minor >= 3';
  match_count integer;
begin
  select pg_get_functiondef(
    'app_private.reconcile_practice_topic_internal(uuid,uuid,uuid)'::regprocedure
  ) into function_definition;

  select count(*)::integer
  into match_count
  from regexp_matches(function_definition, threshold_pattern, 'g');

  if function_definition is null or match_count <> 2 then
    raise exception using
      errcode = '55000',
      message = 'practice_reconciler_unlock_policy_anchor_changed';
  end if;

  patched_definition := regexp_replace(
    function_definition,
    threshold_pattern,
    'app_private.practice_issue_count_unlocks('
      || 'unresolved_minor, unresolved_major)',
    'g'
  );

  if patched_definition = function_definition
    or patched_definition ~ threshold_pattern
  then
    raise exception using
      errcode = '55000',
      message = 'practice_reconciler_unlock_policy_patch_failed';
  end if;

  execute patched_definition;
end;
$patch_practice_reconciler$;

-- A restricted low-CEFR topic is still held until a qualified worksheet-bank
-- release or an explicit audited opt-in exists. Make that escape hatch
-- consistent with the new one-issue availability policy; do not bypass it.
do $patch_restricted_practice_opt_in$
declare
  function_definition text;
  patched_definition text;
  threshold_pattern text :=
    'selected_cycle.major_issue_count >= 1[[:space:]]+or selected_cycle.minor_issue_count >= 3';
  match_count integer;
begin
  select pg_get_functiondef(
    'public.opt_in_restricted_practice_internal(uuid,text)'::regprocedure
  ) into function_definition;

  select count(*)::integer
  into match_count
  from regexp_matches(function_definition, threshold_pattern, 'g');

  if function_definition is null or match_count <> 1 then
    raise exception using
      errcode = '55000',
      message = 'restricted_practice_opt_in_policy_anchor_changed';
  end if;

  patched_definition := regexp_replace(
    function_definition,
    threshold_pattern,
    'app_private.practice_issue_count_unlocks('
      || 'selected_cycle.minor_issue_count, '
      || 'selected_cycle.major_issue_count)',
    'g'
  );

  if patched_definition = function_definition
    or patched_definition ~ threshold_pattern
  then
    raise exception using
      errcode = '55000',
      message = 'restricted_practice_opt_in_policy_patch_failed';
  end if;

  execute patched_definition;
end;
$patch_restricted_practice_opt_in$;

-- Launch production is replayed into an empty project. Deliberately avoid a
-- migration-time historical reconciliation scan or permanent backfill Cron:
-- both would add deployment risk and idle production work for no launch data.
-- Staging-only legacy one/two-minor cycles are reconciled in bounded operator
-- batches after migration replay, with evidence captured before and after.

comment on function app_private.practice_issue_count_unlocks(integer, integer)
is 'Private adaptive-practice policy: any nonnegative released issue count of at least one is available; severity and repetition only affect priority.';

notify pgrst, 'reload schema';
