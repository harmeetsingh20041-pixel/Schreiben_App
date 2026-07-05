create index if not exists student_grammar_stats_workspace_student_level_idx
on public.student_grammar_stats (workspace_id, student_id, weakness_level);

create or replace function public.refresh_student_grammar_stats(
  target_workspace_id uuid,
  target_student_id uuid
)
returns table (
  id uuid,
  workspace_id uuid,
  student_id uuid,
  grammar_topic_id uuid,
  grammar_topic_name text,
  grammar_topic_slug text,
  total_minor_issues integer,
  total_major_issues integer,
  total_correct_after_practice integer,
  weakness_level text,
  practice_unlocked boolean,
  last_seen_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  jwt_role text := coalesce(auth.jwt() ->> 'role', '');
begin
  if target_workspace_id is null or target_student_id is null then
    raise exception 'Workspace and student are required.'
      using errcode = '22023';
  end if;

  if jwt_role <> 'service_role' then
    if actor_id is null then
      raise exception 'Authentication required.'
        using errcode = '28000';
    end if;

    if actor_id <> target_student_id
      and not public.is_platform_admin()
      and not public.has_workspace_role(target_workspace_id, array['owner', 'teacher'])
    then
      raise exception 'Permission denied.'
        using errcode = '42501';
    end if;
  end if;

  if not exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = target_workspace_id
      and wm.user_id = target_student_id
      and wm.role = 'student'
  ) then
    raise exception 'Student is not a member of this workspace.'
      using errcode = '42501';
  end if;

  drop table if exists pg_temp.phase7a_topic_totals;

  create temp table phase7a_topic_totals on commit drop as
    select
      sgt.grammar_topic_id,
      coalesce(sum(case when sgt.severity = 'minor' then sgt.count else 0 end), 0)::integer as minor_count,
      coalesce(sum(case when sgt.severity in ('major', 'mixed') then sgt.count else 0 end), 0)::integer as major_count,
      max(coalesce(s.checked_at, s.feedback_completed_at, s.updated_at, s.created_at)) as seen_at
    from public.submissions s
    join public.submission_grammar_topics sgt
      on sgt.submission_id = s.id
    where s.workspace_id = target_workspace_id
      and s.student_id = target_student_id
      and s.status in ('checked', 'needs_review')
    group by sgt.grammar_topic_id;

  insert into public.student_grammar_stats (
    workspace_id,
    student_id,
    grammar_topic_id,
    total_minor_issues,
    total_major_issues,
    weakness_level,
    practice_unlocked,
    last_seen_at,
    updated_at
  )
  select
    target_workspace_id,
    target_student_id,
    totals.grammar_topic_id,
    totals.minor_count,
    totals.major_count,
    case
      when totals.major_count >= 1 then 'unlocked'
      when totals.minor_count >= 3 then 'unlocked'
      when totals.minor_count >= 2 then 'weak'
      else 'tracking'
    end,
    totals.major_count >= 1 or totals.minor_count >= 3,
    totals.seen_at,
    now()
  from phase7a_topic_totals totals
  where totals.minor_count > 0 or totals.major_count > 0
  on conflict (workspace_id, student_id, grammar_topic_id)
  do update set
    total_minor_issues = excluded.total_minor_issues,
    total_major_issues = excluded.total_major_issues,
    weakness_level = excluded.weakness_level,
    practice_unlocked = excluded.practice_unlocked,
    last_seen_at = excluded.last_seen_at,
    updated_at = now();

  delete from public.student_grammar_stats sgs
  where sgs.workspace_id = target_workspace_id
    and sgs.student_id = target_student_id
    and sgs.total_correct_after_practice = 0
    and not exists (
      select 1
      from phase7a_topic_totals totals
      where totals.grammar_topic_id = sgs.grammar_topic_id
        and (totals.minor_count > 0 or totals.major_count > 0)
    );

  update public.student_grammar_stats sgs
  set
    total_minor_issues = 0,
    total_major_issues = 0,
    weakness_level = case
      when sgs.weakness_level = 'mastered' then 'mastered'
      else 'tracking'
    end,
    practice_unlocked = false,
    last_seen_at = null,
    updated_at = now()
  where sgs.workspace_id = target_workspace_id
    and sgs.student_id = target_student_id
    and sgs.total_correct_after_practice > 0
    and not exists (
      select 1
      from phase7a_topic_totals totals
      where totals.grammar_topic_id = sgs.grammar_topic_id
        and (totals.minor_count > 0 or totals.major_count > 0)
    );

  return query
    select
      sgs.id,
      sgs.workspace_id,
      sgs.student_id,
      sgs.grammar_topic_id,
      gt.name as grammar_topic_name,
      gt.slug as grammar_topic_slug,
      sgs.total_minor_issues,
      sgs.total_major_issues,
      sgs.total_correct_after_practice,
      sgs.weakness_level,
      sgs.practice_unlocked,
      sgs.last_seen_at,
      sgs.updated_at
    from public.student_grammar_stats sgs
    join public.grammar_topics gt
      on gt.id = sgs.grammar_topic_id
    where sgs.workspace_id = target_workspace_id
      and sgs.student_id = target_student_id
    order by
      sgs.practice_unlocked desc,
      sgs.total_major_issues desc,
      sgs.total_minor_issues desc,
      gt.name asc;
end;
$$;

revoke all on function public.refresh_student_grammar_stats(uuid, uuid) from public;
grant execute on function public.refresh_student_grammar_stats(uuid, uuid) to authenticated, service_role;
