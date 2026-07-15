-- Immutable model-validated worksheet cache.
--
-- Qualified canonical worksheets remain the highest-trust delivery source.
-- This separate cache makes an already accepted, deterministic all-MCQ
-- worksheet reusable across workspaces without claiming human review. Every
-- promotion is bound to the immutable completion-v2 evidence, both provider
-- critics, the candidate hash and a recomputed educational-content hash.
-- The existing thirteen low-CEFR gates are intentionally unchanged: cache
-- material is selectable only when the exact cycle already satisfies the
-- qualified-release or audited teacher-opt-in boundary.

create table app_private.practice_worksheet_model_cache_revisions (
  id uuid primary key default gen_random_uuid(),
  grammar_topic_id uuid not null
    references public.grammar_topics(id) on delete restrict,
  level text not null check (level in ('A1', 'A2', 'B1', 'B2')),
  difficulty text not null check (difficulty in ('easy', 'medium', 'hard')),
  title text not null check (length(btrim(title)) between 1 and 120),
  description text not null check (length(btrim(description)) between 1 and 1000),
  mini_lesson jsonb not null check (jsonb_typeof(mini_lesson) = 'object'),
  generator_provider text not null check (
    generator_provider in ('deepseek', 'gemini')
  ),
  generator_model text not null check (
    generator_model ~ '^[a-zA-Z0-9._:/-]{1,100}$'
  ),
  validation_profile text not null default 'mcq_safe_v1'
    check (validation_profile = 'mcq_safe_v1'),
  validation_metadata jsonb not null check (
    jsonb_typeof(validation_metadata) = 'object'
  ),
  source_practice_test_id uuid not null unique
    references public.practice_tests(id) on delete restrict,
  source_completion_job_id uuid not null unique
    references app_private.worksheet_generation_completions_v2(job_id)
    on delete restrict,
  candidate_sha256 text not null check (candidate_sha256 ~ '^[a-f0-9]{64}$'),
  primary_critic_provider text not null check (
    primary_critic_provider = 'deepseek'
  ),
  primary_critic_model text not null check (
    primary_critic_model ~ '^[a-zA-Z0-9._:/-]{1,100}$'
  ),
  primary_verdict_sha256 text not null check (
    primary_verdict_sha256 ~ '^[a-f0-9]{64}$'
  ),
  secondary_critic_provider text not null check (
    secondary_critic_provider = 'gemini'
  ),
  secondary_critic_model text not null check (
    secondary_critic_model ~ '^[a-zA-Z0-9._:/-]{1,100}$'
  ),
  secondary_verdict_sha256 text not null check (
    secondary_verdict_sha256 ~ '^[a-f0-9]{64}$'
  ),
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  promoted_at timestamptz not null default now(),
  unique (grammar_topic_id, level, content_sha256)
);

create table app_private.practice_worksheet_model_cache_questions (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null
    references app_private.practice_worksheet_model_cache_revisions(id)
    on delete restrict,
  question_number integer not null check (question_number > 0),
  question_type text not null check (question_type = 'multiple_choice'),
  evaluation_mode text not null check (evaluation_mode = 'local_exact'),
  prompt text not null check (length(btrim(prompt)) between 12 and 800),
  options jsonb not null check (jsonb_typeof(options) = 'array'),
  correct_answer text not null check (length(btrim(correct_answer)) between 1 and 500),
  accepted_answers jsonb not null check (jsonb_typeof(accepted_answers) = 'array'),
  rubric jsonb check (rubric is null),
  answer_contract_version integer not null default 1
    check (answer_contract_version = 1),
  explanation text not null check (length(btrim(explanation)) between 1 and 600),
  created_at timestamptz not null default now(),
  unique (revision_id, question_number)
);

-- A content-identical worksheet may deduplicate onto an existing revision.
-- Keep every independently completed source bound to that shared revision so
-- withdrawal invalidates future use of the first source and all later sources.
create table app_private.practice_worksheet_model_cache_sources (
  source_practice_test_id uuid primary key
    references public.practice_tests(id) on delete restrict,
  revision_id uuid not null
    references app_private.practice_worksheet_model_cache_revisions(id)
    on delete restrict,
  source_completion_job_id uuid not null unique
    references app_private.worksheet_generation_completions_v2(job_id)
    on delete restrict,
  source_content_sha256 text not null check (
    source_content_sha256 ~ '^[a-f0-9]{64}$'
  ),
  linked_at timestamptz not null default now()
);

create table app_private.practice_worksheet_model_cache_withdrawals (
  revision_id uuid primary key
    references app_private.practice_worksheet_model_cache_revisions(id)
    on delete restrict,
  withdrawn_by uuid not null references public.profiles(id) on delete restrict,
  reason text not null check (length(btrim(reason)) between 8 and 1000),
  withdrawn_at timestamptz not null default now()
);

create index practice_worksheet_model_cache_lookup_idx
on app_private.practice_worksheet_model_cache_revisions (
  grammar_topic_id,
  level,
  difficulty,
  promoted_at,
  id
);

create index practice_worksheet_model_cache_questions_revision_idx
on app_private.practice_worksheet_model_cache_questions (
  revision_id,
  question_number
);

create index practice_worksheet_model_cache_sources_revision_idx
on app_private.practice_worksheet_model_cache_sources (revision_id);

alter table app_private.practice_worksheet_model_cache_revisions
  enable row level security;
alter table app_private.practice_worksheet_model_cache_questions
  enable row level security;
alter table app_private.practice_worksheet_model_cache_sources
  enable row level security;
alter table app_private.practice_worksheet_model_cache_withdrawals
  enable row level security;

revoke all on table app_private.practice_worksheet_model_cache_revisions
from public, anon, authenticated, service_role;
revoke all on table app_private.practice_worksheet_model_cache_questions
from public, anon, authenticated, service_role;
revoke all on table app_private.practice_worksheet_model_cache_sources
from public, anon, authenticated, service_role;
revoke all on table app_private.practice_worksheet_model_cache_withdrawals
from public, anon, authenticated, service_role;

create or replace function app_private.guard_model_cache_promotion_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  strict_scoring boolean := false;
begin
  if current_setting('app.model_cache_promotion', true) is distinct from 'on' then
    raise exception using
      errcode = '42501',
      message = 'model_cache_promotion_required';
  end if;

  if tg_table_name = 'practice_worksheet_model_cache_sources' then
    if not exists (
      select 1
      from app_private.practice_worksheet_model_cache_revisions revision
      join public.practice_tests source_test
        on source_test.id = new.source_practice_test_id
      join app_private.worksheet_generation_completions_v2 completion
        on completion.job_id = new.source_completion_job_id
       and completion.practice_test_id = source_test.id
       and completion.job_id = source_test.generation_job_id
      where revision.id = new.revision_id
        and completion.completion_mode = 'generated'
        and completion.content_sha256 = new.source_content_sha256
        and revision.content_sha256 = new.source_content_sha256
        and app_private.practice_test_content_sha256(source_test.id)
          = new.source_content_sha256
    ) then
      raise exception using
        errcode = '23514',
        message = 'model_cache_source_link_invalid';
    end if;
    return new;
  end if;

  if tg_table_name = 'practice_worksheet_model_cache_questions' then
    select coalesce(
      app_private.is_practice_topic_strict_scoring(topic.name, topic.slug),
      false
    ) or coalesce(
      app_private.is_practice_topic_punctuation_scoring(topic.name, topic.slug),
      false
    )
    into strict_scoring
    from app_private.practice_worksheet_model_cache_revisions revision
    join public.grammar_topics topic on topic.id = revision.grammar_topic_id
    where revision.id = new.revision_id;

    if new.question_type <> 'multiple_choice'
      or new.evaluation_mode <> 'local_exact'
      or new.rubric is not null
      or jsonb_array_length(new.options) not between 3 and 4
      or jsonb_array_length(new.accepted_answers) <> 1
      or jsonb_typeof(new.accepted_answers #> '{0}') <> 'string'
      or new.accepted_answers #>> '{0}' is distinct from new.correct_answer
      or exists (
        select 1
        from jsonb_array_elements(new.options) option_value(value)
        where jsonb_typeof(option_value.value) <> 'string'
          or length(btrim(option_value.value #>> '{}')) = 0
      )
      or (
        select count(*) <> count(distinct
          app_private.normalize_practice_contract_value(
            option_value,
            strict_scoring
          )
        )
        from jsonb_array_elements_text(new.options) option_value
      )
      or (
        select count(*)
        from jsonb_array_elements_text(new.options) option_value
        where app_private.normalize_practice_contract_value(
          option_value,
          strict_scoring
        ) = app_private.normalize_practice_contract_value(
          new.correct_answer,
          strict_scoring
        )
      ) <> 1
    then
      raise exception using
        errcode = '23514',
        message = 'model_cache_question_contract_invalid';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function app_private.guard_model_cache_promotion_insert()
from public, anon, authenticated, service_role;

create trigger practice_worksheet_model_cache_revisions_00_guard
before insert on app_private.practice_worksheet_model_cache_revisions
for each row execute function app_private.guard_model_cache_promotion_insert();

create trigger practice_worksheet_model_cache_questions_00_guard
before insert on app_private.practice_worksheet_model_cache_questions
for each row execute function app_private.guard_model_cache_promotion_insert();

create trigger practice_worksheet_model_cache_sources_00_guard
before insert on app_private.practice_worksheet_model_cache_sources
for each row execute function app_private.guard_model_cache_promotion_insert();

create trigger practice_worksheet_model_cache_revisions_immutable
before update or delete on app_private.practice_worksheet_model_cache_revisions
for each row execute function app_private.reject_worksheet_bank_history_mutation();

create trigger practice_worksheet_model_cache_questions_immutable
before update or delete on app_private.practice_worksheet_model_cache_questions
for each row execute function app_private.reject_worksheet_bank_history_mutation();

create trigger practice_worksheet_model_cache_sources_immutable
before update or delete on app_private.practice_worksheet_model_cache_sources
for each row execute function app_private.reject_worksheet_bank_history_mutation();

create trigger practice_worksheet_model_cache_withdrawals_immutable
before update or delete on app_private.practice_worksheet_model_cache_withdrawals
for each row execute function app_private.reject_worksheet_bank_history_mutation();

create or replace function app_private.guard_model_cache_withdrawal_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_setting('app.model_cache_withdrawal', true) is distinct from 'on'
  then
    raise exception using
      errcode = '42501',
      message = 'model_cache_withdrawal_required';
  end if;
  return new;
end;
$$;

revoke all on function app_private.guard_model_cache_withdrawal_insert()
from public, anon, authenticated, service_role;

create trigger practice_worksheet_model_cache_withdrawals_00_guard
before insert on app_private.practice_worksheet_model_cache_withdrawals
for each row execute function app_private.guard_model_cache_withdrawal_insert();

create or replace function app_private.practice_worksheet_model_cache_revision_sha256(
  target_revision_id uuid
)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'worksheet', pg_catalog.jsonb_build_object(
            'level', revision.level,
            'grammar_topic', pg_catalog.jsonb_build_object(
              'slug', topic.slug,
              'name', topic.name
            ),
            'difficulty', revision.difficulty,
            'title', revision.title,
            'description', revision.description,
            'mini_lesson', revision.mini_lesson
          ),
          'questions', coalesce((
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'question_number', question.question_number,
                'question_type', question.question_type,
                'evaluation_mode', question.evaluation_mode,
                'prompt', question.prompt,
                'options', question.options,
                'correct_answer', question.correct_answer,
                'accepted_answers', question.accepted_answers,
                'rubric', question.rubric,
                'answer_contract_version', question.answer_contract_version,
                'explanation', question.explanation
              ) order by question.question_number
            )
            from app_private.practice_worksheet_model_cache_questions question
            where question.revision_id = revision.id
          ), '[]'::jsonb)
        )::text,
        'UTF8'
      )
    ),
    'hex'
  )
  from app_private.practice_worksheet_model_cache_revisions revision
  join public.grammar_topics topic on topic.id = revision.grammar_topic_id
  where revision.id = target_revision_id;
$$;

revoke all on function
  app_private.practice_worksheet_model_cache_revision_sha256(uuid)
from public, anon, authenticated, service_role;

create or replace function app_private.model_cache_validation_checks_pass(
  evidence jsonb
)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select coalesce(
    jsonb_typeof(evidence) = 'object'
    and jsonb_typeof(evidence -> 'checks') = 'object'
    and evidence #> '{checks,ambiguity_free}' = 'true'::jsonb
    and evidence #> '{checks,no_answer_leakage}' = 'true'::jsonb
    and evidence #> '{checks,duplicate_free}' = 'true'::jsonb
    and evidence #> '{checks,level_fit}' = 'true'::jsonb
    and evidence #> '{checks,topic_fit}' = 'true'::jsonb
    and evidence #> '{checks,type_balance}' = 'true'::jsonb
    and evidence #> '{checks,scoring_safe}' = 'true'::jsonb
    and jsonb_typeof(evidence -> 'content_checks') = 'object'
    and evidence #> '{content_checks,mini_lesson_scope_accurate}' = 'true'::jsonb
    and evidence #> '{content_checks,learner_cues_semantically_aligned}' = 'true'::jsonb
    and evidence #> '{content_checks,examples_rubrics_consistent}' = 'true'::jsonb,
    false
  );
$$;

revoke all on function app_private.model_cache_validation_checks_pass(jsonb)
from public, anon, authenticated, service_role;

create or replace function app_private.practice_worksheet_model_cache_revision_is_current(
  target_revision_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(exists (
    select 1
    from app_private.practice_worksheet_model_cache_revisions revision
    join app_private.worksheet_generation_completions_v2 completion
      on completion.job_id = revision.source_completion_job_id
     and completion.practice_test_id = revision.source_practice_test_id
    where revision.id = target_revision_id
      and completion.completion_mode = 'generated'
      and completion.provider_source = revision.generator_provider
      and completion.generator_model = revision.generator_model
      and completion.candidate_sha256 = revision.candidate_sha256
      and completion.primary_critic_provider = revision.primary_critic_provider
      and completion.primary_critic_model = revision.primary_critic_model
      and completion.primary_verdict_sha256 = revision.primary_verdict_sha256
      and completion.secondary_critic_provider = revision.secondary_critic_provider
      and completion.secondary_critic_model = revision.secondary_critic_model
      and completion.secondary_verdict_sha256 = revision.secondary_verdict_sha256
      and completion.content_sha256 = revision.content_sha256
      and app_private.practice_worksheet_model_cache_revision_sha256(revision.id)
        = revision.content_sha256
      and not exists (
        select 1
        from app_private.practice_worksheet_model_cache_withdrawals withdrawal
        where withdrawal.revision_id = revision.id
      )
      and (
        select count(*)
        from app_private.practice_worksheet_model_cache_questions question
        where question.revision_id = revision.id
      ) = case when revision.level = 'A2' then 9 else 8 end
  ), false);
$$;

revoke all on function
  app_private.practice_worksheet_model_cache_revision_is_current(uuid)
from public, anon, authenticated, service_role;

create or replace function app_private.promote_model_validated_worksheet(
  target_practice_test_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  source_test public.practice_tests%rowtype;
  completion app_private.worksheet_generation_completions_v2%rowtype;
  validation jsonb;
  deepseek_critic jsonb;
  gemini_critic jsonb;
  source_content_sha256 text;
  existing_revision_id uuid;
  promoted_revision_id uuid;
  expected_question_count integer;
  strict_scoring boolean := false;
begin
  perform app_private.assert_service_role();

  if target_practice_test_id is null then
    raise exception using errcode = '22023', message = 'model_cache_source_required';
  end if;

  -- Serialize the complete check-then-copy boundary for a source worksheet.
  -- A content-hash conflict alone is insufficient because two workers may
  -- promote the same source before either unique source key becomes visible.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_practice_test_id::text, 13153000)
  );

  select test.*
  into source_test
  from public.practice_tests test
  where test.id = target_practice_test_id
  for share;

  if source_test.id is null then
    raise exception using errcode = 'P0002', message = 'model_cache_source_not_found';
  end if;

  select evidence.*
  into completion
  from app_private.worksheet_generation_completions_v2 evidence
  where evidence.practice_test_id = source_test.id
    and evidence.job_id = source_test.generation_job_id
  for share;

  select source_link.revision_id
  into existing_revision_id
  from app_private.practice_worksheet_model_cache_sources source_link
  where source_link.source_practice_test_id = source_test.id
     or (
       completion.job_id is not null
       and source_link.source_completion_job_id = completion.job_id
     )
  order by source_link.linked_at, source_link.revision_id
  limit 1;

  if existing_revision_id is not null then
    if not exists (
      select 1
      from app_private.practice_worksheet_model_cache_sources source_link
      where source_link.source_practice_test_id = source_test.id
        and source_link.revision_id = existing_revision_id
        and source_link.source_completion_job_id = completion.job_id
        and source_link.source_content_sha256 =
          app_private.practice_test_content_sha256(source_test.id)
    ) then
      raise exception using
        errcode = '55000',
        message = 'model_cache_existing_source_mismatch';
    end if;
    if not app_private.practice_worksheet_model_cache_revision_is_current(
      existing_revision_id
    ) then
      raise exception using
        errcode = '55000',
        message = 'model_cache_existing_revision_invalid';
    end if;
    return existing_revision_id;
  end if;

  validation := source_test.generation_metadata -> 'validation';
  deepseek_critic := validation #> '{critics,deepseek}';
  gemini_critic := validation #> '{critics,gemini}';
  source_content_sha256 := app_private.practice_test_content_sha256(source_test.id);
  expected_question_count := case when source_test.level = 'A2' then 9 else 8 end;

  select coalesce(
    app_private.is_practice_topic_strict_scoring(topic.name, topic.slug),
    false
  ) or coalesce(
    app_private.is_practice_topic_punctuation_scoring(topic.name, topic.slug),
    false
  )
  into strict_scoring
  from public.grammar_topics topic
  where topic.id = source_test.grammar_topic_id;

  if completion.job_id is null
    or completion.completion_mode <> 'generated'
    or source_test.quality_status <> 'approved'
    or source_test.approval_source <> 'independent_model_validation'
    or not source_test.created_by_ai
    or source_test.teacher_reviewed
    or source_test.visibility <> 'workspace'
    or source_test.generation_source not in ('deepseek', 'gemini')
    or completion.provider_source is distinct from source_test.generation_source
    or completion.generator_model is distinct from source_test.generator_model
    or completion.content_sha256 is distinct from source_content_sha256
    or validation -> 'deterministic' is distinct from 'true'::jsonb
    or validation -> 'independent_model' is distinct from 'true'::jsonb
    or jsonb_typeof(validation -> 'attempt_count') is distinct from 'number'
    or validation ->> 'attempt_count' not in ('1', '2')
    or not app_private.model_cache_validation_checks_pass(validation)
    or jsonb_typeof(validation -> 'rejection_reasons') is distinct from 'array'
    or jsonb_array_length(validation -> 'rejection_reasons') <> 0
    or completion.candidate_sha256 is null
    or validation ->> 'candidate_sha256' is distinct from completion.candidate_sha256
    or deepseek_critic ->> 'provider' <> 'deepseek'
    or deepseek_critic ->> 'model' is distinct from completion.primary_critic_model
    or deepseek_critic ->> 'candidate_sha256' is distinct from completion.candidate_sha256
    or deepseek_critic -> 'approved' is distinct from 'true'::jsonb
    or not app_private.model_cache_validation_checks_pass(deepseek_critic)
    or jsonb_typeof(deepseek_critic -> 'rejection_reasons') is distinct from 'array'
    or jsonb_array_length(deepseek_critic -> 'rejection_reasons') <> 0
    or deepseek_critic ->> 'verdict_sha256'
      is distinct from completion.primary_verdict_sha256
    or app_private.worksheet_critic_verdict_sha256(deepseek_critic)
      is distinct from completion.primary_verdict_sha256
    or gemini_critic ->> 'provider' <> 'gemini'
    or gemini_critic ->> 'model' is distinct from completion.secondary_critic_model
    or gemini_critic ->> 'candidate_sha256' is distinct from completion.candidate_sha256
    or gemini_critic -> 'approved' is distinct from 'true'::jsonb
    or not app_private.model_cache_validation_checks_pass(gemini_critic)
    or jsonb_typeof(gemini_critic -> 'rejection_reasons') is distinct from 'array'
    or jsonb_array_length(gemini_critic -> 'rejection_reasons') <> 0
    or gemini_critic ->> 'verdict_sha256'
      is distinct from completion.secondary_verdict_sha256
    or app_private.worksheet_critic_verdict_sha256(gemini_critic)
      is distinct from completion.secondary_verdict_sha256
    or (
      select count(*)
      from public.practice_test_questions question
      where question.practice_test_id = source_test.id
    ) <> expected_question_count
    or exists (
      select 1
      from public.practice_test_questions question
      where question.practice_test_id = source_test.id
        and (
          question.question_type <> 'multiple_choice'
          or question.evaluation_mode <> 'local_exact'
          or question.answer_contract_version <> 1
          or question.rubric is not null
          or jsonb_typeof(question.options) is distinct from 'array'
          or jsonb_array_length(question.options) not between 3 and 4
          or jsonb_typeof(question.accepted_answers) is distinct from 'array'
          or jsonb_array_length(question.accepted_answers) <> 1
          or jsonb_typeof(question.accepted_answers #> '{0}') is distinct from 'string'
          or question.accepted_answers #>> '{0}' is distinct from question.correct_answer
          or exists (
            select 1
            from jsonb_array_elements(question.options) option_value(value)
            where jsonb_typeof(option_value.value) is distinct from 'string'
              or length(btrim(option_value.value #>> '{}')) = 0
          )
          or (
            select count(*) <> count(distinct
              app_private.normalize_practice_contract_value(
                option_value,
                strict_scoring
              )
            )
            from jsonb_array_elements_text(question.options) option_value
          )
          or (
            select count(*)
            from jsonb_array_elements_text(question.options) option_value
            where app_private.normalize_practice_contract_value(
              option_value,
              strict_scoring
            ) = app_private.normalize_practice_contract_value(
              question.correct_answer,
              strict_scoring
            )
          ) <> 1
        )
    )
  then
    raise exception using
      errcode = '22023',
      message = 'model_cache_source_validation_invalid';
  end if;

  perform set_config('app.model_cache_promotion', 'on', true);
  insert into app_private.practice_worksheet_model_cache_revisions (
    grammar_topic_id,
    level,
    difficulty,
    title,
    description,
    mini_lesson,
    generator_provider,
    generator_model,
    validation_profile,
    validation_metadata,
    source_practice_test_id,
    source_completion_job_id,
    candidate_sha256,
    primary_critic_provider,
    primary_critic_model,
    primary_verdict_sha256,
    secondary_critic_provider,
    secondary_critic_model,
    secondary_verdict_sha256,
    content_sha256
  ) values (
    source_test.grammar_topic_id,
    source_test.level,
    source_test.difficulty,
    source_test.title,
    source_test.description,
    source_test.mini_lesson,
    completion.provider_source,
    completion.generator_model,
    'mcq_safe_v1',
    validation,
    source_test.id,
    completion.job_id,
    completion.candidate_sha256,
    completion.primary_critic_provider,
    completion.primary_critic_model,
    completion.primary_verdict_sha256,
    completion.secondary_critic_provider,
    completion.secondary_critic_model,
    completion.secondary_verdict_sha256,
    source_content_sha256
  )
  on conflict (grammar_topic_id, level, content_sha256) do nothing
  returning id into promoted_revision_id;

  if promoted_revision_id is null then
    select revision.id
    into promoted_revision_id
    from app_private.practice_worksheet_model_cache_revisions revision
    where revision.grammar_topic_id = source_test.grammar_topic_id
      and revision.level = source_test.level
      and revision.content_sha256 = source_content_sha256;
  else
    insert into app_private.practice_worksheet_model_cache_questions (
      revision_id,
      question_number,
      question_type,
      evaluation_mode,
      prompt,
      options,
      correct_answer,
      accepted_answers,
      rubric,
      answer_contract_version,
      explanation
    )
    select
      promoted_revision_id,
      question.question_number,
      question.question_type,
      question.evaluation_mode,
      question.prompt,
      question.options,
      question.correct_answer,
      question.accepted_answers,
      question.rubric,
      question.answer_contract_version,
      question.explanation
    from public.practice_test_questions question
    where question.practice_test_id = source_test.id
    order by question.question_number;
  end if;

  insert into app_private.practice_worksheet_model_cache_sources (
    source_practice_test_id,
    revision_id,
    source_completion_job_id,
    source_content_sha256
  ) values (
    source_test.id,
    promoted_revision_id,
    completion.job_id,
    source_content_sha256
  )
  on conflict (source_practice_test_id) do nothing;
  perform set_config('app.model_cache_promotion', 'off', true);

  if promoted_revision_id is null
    or not app_private.practice_worksheet_model_cache_revision_is_current(
      promoted_revision_id
    )
    or not exists (
      select 1
      from app_private.practice_worksheet_model_cache_sources source_link
      where source_link.source_practice_test_id = source_test.id
        and source_link.revision_id = promoted_revision_id
        and source_link.source_completion_job_id = completion.job_id
        and source_link.source_content_sha256 = source_content_sha256
    )
  then
    raise exception using
      errcode = '55000',
      message = 'model_cache_promotion_hash_mismatch';
  end if;

  return promoted_revision_id;
end;
$$;

revoke all on function app_private.promote_model_validated_worksheet(uuid)
from public, anon, authenticated, service_role;

create or replace function api.promote_model_validated_worksheet(
  target_practice_test_id uuid
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select app_private.promote_model_validated_worksheet(
    target_practice_test_id
  );
$$;

revoke all on function api.promote_model_validated_worksheet(uuid)
from public, anon, authenticated, service_role;
grant execute on function api.promote_model_validated_worksheet(uuid)
to service_role;

create or replace function api.withdraw_model_validated_worksheet_cache(
  target_revision_id uuid,
  expected_content_sha256 text,
  withdrawn_by_profile_id uuid,
  withdrawal_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_revision app_private.practice_worksheet_model_cache_revisions%rowtype;
  selected_withdrawal app_private.practice_worksheet_model_cache_withdrawals%rowtype;
  clean_reason text := btrim(coalesce(withdrawal_reason, ''));
begin
  perform app_private.assert_service_role();

  if target_revision_id is null
    or coalesce(expected_content_sha256, '') !~ '^[a-f0-9]{64}$'
    or withdrawn_by_profile_id is null
    or length(clean_reason) not between 8 and 1000
  then
    raise exception using errcode = '22023', message = 'model_cache_withdrawal_invalid';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    concat('model-cache-withdrawal:', target_revision_id::text),
    0
  ));

  select revision.*
  into selected_revision
  from app_private.practice_worksheet_model_cache_revisions revision
  where revision.id = target_revision_id
  for share;

  if selected_revision.id is null then
    raise exception using errcode = 'P0002', message = 'model_cache_revision_not_found';
  end if;
  if selected_revision.content_sha256 <> expected_content_sha256 then
    raise exception using errcode = '22023', message = 'model_cache_withdrawal_hash_mismatch';
  end if;
  if not exists (
    select 1
    from public.profiles profile
    where profile.id = withdrawn_by_profile_id
      and profile.global_role = 'platform_admin'
  ) then
    raise exception using errcode = '42501', message = 'platform_admin_required';
  end if;

  select withdrawal.*
  into selected_withdrawal
  from app_private.practice_worksheet_model_cache_withdrawals withdrawal
  where withdrawal.revision_id = selected_revision.id;

  if selected_withdrawal.revision_id is not null then
    if selected_withdrawal.withdrawn_by is distinct from withdrawn_by_profile_id
      or selected_withdrawal.reason is distinct from clean_reason
    then
      raise exception using
        errcode = '55000',
        message = 'model_cache_withdrawal_replay_mismatch';
    end if;

    return jsonb_build_object(
      'schema_version', 1,
      'revision_id', selected_revision.id,
      'withdrawn', true,
      'created', false,
      'withdrawn_by', selected_withdrawal.withdrawn_by,
      'withdrawn_at', selected_withdrawal.withdrawn_at
    );
  end if;

  perform set_config('app.model_cache_withdrawal', 'on', true);
  insert into app_private.practice_worksheet_model_cache_withdrawals (
    revision_id,
    withdrawn_by,
    reason
  ) values (
    selected_revision.id,
    withdrawn_by_profile_id,
    clean_reason
  ) returning * into selected_withdrawal;
  perform set_config('app.model_cache_withdrawal', 'off', true);

  return jsonb_build_object(
    'schema_version', 1,
    'revision_id', selected_revision.id,
    'withdrawn', true,
    'created', true,
    'withdrawn_by', selected_withdrawal.withdrawn_by,
    'withdrawn_at', selected_withdrawal.withdrawn_at
  );
end;
$$;

revoke all on function api.withdraw_model_validated_worksheet_cache(
  uuid, text, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function api.withdraw_model_validated_worksheet_cache(
  uuid, text, uuid, text
) to service_role;

-- Public workspace clones keep truthful model-validation provenance without
-- inheriting a source workspace, teacher-review flag or certified-bank link.
alter table public.practice_tests
  add column worksheet_model_cache_revision_id uuid,
  add column model_cache_content_sha256 text;

alter table public.practice_tests
  add constraint practice_tests_model_cache_revision_fk
    foreign key (worksheet_model_cache_revision_id)
    references app_private.practice_worksheet_model_cache_revisions(id)
    on delete restrict,
  add constraint practice_tests_model_cache_content_hash_check
    check (
      model_cache_content_sha256 is null
      or model_cache_content_sha256 ~ '^[a-f0-9]{64}$'
    ),
  add constraint practice_tests_model_cache_clone_shape_check
    check (
      (
        worksheet_model_cache_revision_id is null
        and model_cache_content_sha256 is null
      )
      or (
        worksheet_model_cache_revision_id is not null
        and model_cache_content_sha256 is not null
        and worksheet_template_revision_id is null
        and worksheet_template_release_id is null
        and template_content_sha256 is null
        and approval_source = 'independent_model_validation'
        and generation_source in ('deepseek', 'gemini')
        and created_by_ai
        and not teacher_reviewed
        and visibility = 'workspace'
        and quality_status = 'approved'
      )
    );

create unique index practice_tests_one_model_cache_clone_per_workspace_idx
on public.practice_tests (workspace_id, worksheet_model_cache_revision_id)
where worksheet_model_cache_revision_id is not null;

create index practice_tests_model_cache_revision_idx
on public.practice_tests (worksheet_model_cache_revision_id)
where worksheet_model_cache_revision_id is not null;

-- A newly generated worksheet is usable by its original assignment before
-- the asynchronous cache-promotion sweep links it. Distinguish that short
-- window from legacy independent-model rows by rechecking the exact immutable
-- completion and typed 7+3 dual-critic evidence. Missing or string-coerced
-- fields fail closed because every predicate is inside EXISTS.
create or replace function app_private.practice_test_has_current_unlinked_model_evidence(
  target_practice_test_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(exists (
    select 1
    from public.practice_tests test
    join app_private.worksheet_generation_completions_v2 completion
      on completion.practice_test_id = test.id
     and completion.job_id = test.generation_job_id
    join app_private.async_jobs job
      on job.id = completion.job_id
     and job.job_kind = 'worksheet_generation'
     and job.status = 'succeeded'
     and job.entity_id = test.generated_from_assignment_id
    cross join lateral (
      select test.generation_metadata -> 'validation' as validation
    ) evidence
    cross join lateral (
      select
        evidence.validation #> '{critics,deepseek}' as deepseek_critic,
        evidence.validation #> '{critics,gemini}' as gemini_critic
    ) critics
    cross join lateral (
      select coalesce(
        app_private.is_practice_topic_strict_scoring(topic.name, topic.slug),
        false
      ) or coalesce(
        app_private.is_practice_topic_punctuation_scoring(
          topic.name,
          topic.slug
        ),
        false
      ) as strict_scoring
      from public.grammar_topics topic
      where topic.id = test.grammar_topic_id
    ) scoring
    where test.id = target_practice_test_id
      and test.worksheet_template_revision_id is null
      and test.worksheet_model_cache_revision_id is null
      and not exists (
        select 1
        from app_private.practice_worksheet_model_cache_sources source_link
        where source_link.source_practice_test_id = test.id
      )
      and test.quality_status = 'approved'
      and test.approval_source = 'independent_model_validation'
      and test.created_by_ai
      and not test.teacher_reviewed
      and test.visibility = 'workspace'
      and test.generation_source in ('deepseek', 'gemini')
      and (
        (
          test.generation_source = 'deepseek'
          and test.generator_model = 'deepseek-v4-pro'
        )
        or (
          test.generation_source = 'gemini'
          and test.generator_model = 'gemini-3.1-flash-lite'
        )
      )
      and completion.completion_mode = 'generated'
      and completion.evidence_version = 2
      and completion.provider_source = test.generation_source
      and completion.generator_model = test.generator_model
      and completion.provider_metadata = test.generation_metadata
      and completion.content_sha256 =
        app_private.practice_test_content_sha256(test.id)
      and evidence.validation ?& array[
        'deterministic',
        'independent_model',
        'critic_model',
        'candidate_sha256',
        'critics',
        'attempt_count',
        'checks',
        'content_checks',
        'rejection_reasons'
      ]
      and evidence.validation - array[
        'deterministic',
        'independent_model',
        'critic_model',
        'candidate_sha256',
        'critics',
        'attempt_count',
        'checks',
        'content_checks',
        'rejection_reasons'
      ]::text[] = '{}'::jsonb
      and evidence.validation -> 'deterministic' = 'true'::jsonb
      and evidence.validation -> 'independent_model' = 'true'::jsonb
      and evidence.validation ->> 'critic_model' = 'deepseek-v4-flash'
      and jsonb_typeof(evidence.validation -> 'attempt_count') = 'number'
      and evidence.validation ->> 'attempt_count' in ('1', '2')
      and evidence.validation -> 'critics' ?& array['deepseek', 'gemini']
      and (evidence.validation -> 'critics')
        - array['deepseek', 'gemini']::text[] = '{}'::jsonb
      and evidence.validation -> 'checks' ?& array[
        'ambiguity_free',
        'no_answer_leakage',
        'duplicate_free',
        'level_fit',
        'topic_fit',
        'type_balance',
        'scoring_safe'
      ]
      and (evidence.validation -> 'checks') - array[
        'ambiguity_free',
        'no_answer_leakage',
        'duplicate_free',
        'level_fit',
        'topic_fit',
        'type_balance',
        'scoring_safe'
      ]::text[] = '{}'::jsonb
      and evidence.validation -> 'content_checks' ?& array[
        'mini_lesson_scope_accurate',
        'learner_cues_semantically_aligned',
        'examples_rubrics_consistent'
      ]
      and (evidence.validation -> 'content_checks') - array[
        'mini_lesson_scope_accurate',
        'learner_cues_semantically_aligned',
        'examples_rubrics_consistent'
      ]::text[] = '{}'::jsonb
      and app_private.model_cache_validation_checks_pass(
        evidence.validation
      )
      and jsonb_typeof(evidence.validation -> 'rejection_reasons') = 'array'
      and jsonb_array_length(evidence.validation -> 'rejection_reasons') = 0
      and evidence.validation ->> 'candidate_sha256' =
        completion.candidate_sha256
      and critics.deepseek_critic ->> 'provider' = 'deepseek'
      and critics.deepseek_critic ->> 'model' =
        completion.primary_critic_model
      and critics.deepseek_critic ->> 'candidate_sha256' =
        completion.candidate_sha256
      and critics.deepseek_critic -> 'approved' = 'true'::jsonb
      and app_private.is_valid_worksheet_checkpoint_critic(
        critics.deepseek_critic,
        'deepseek',
        'deepseek-v4-flash',
        completion.candidate_sha256
      )
      and app_private.model_cache_validation_checks_pass(
        critics.deepseek_critic
      )
      and jsonb_typeof(critics.deepseek_critic -> 'rejection_reasons') = 'array'
      and jsonb_array_length(
        critics.deepseek_critic -> 'rejection_reasons'
      ) = 0
      and critics.deepseek_critic ->> 'verdict_sha256' =
        completion.primary_verdict_sha256
      and app_private.worksheet_critic_verdict_sha256(
        critics.deepseek_critic
      ) = completion.primary_verdict_sha256
      and critics.gemini_critic ->> 'provider' = 'gemini'
      and critics.gemini_critic ->> 'model' =
        completion.secondary_critic_model
      and completion.secondary_critic_model = 'gemini-3.1-flash-lite'
      and critics.gemini_critic ->> 'candidate_sha256' =
        completion.candidate_sha256
      and critics.gemini_critic -> 'approved' = 'true'::jsonb
      and app_private.is_valid_worksheet_checkpoint_critic(
        critics.gemini_critic,
        'gemini',
        'gemini-3.1-flash-lite',
        completion.candidate_sha256
      )
      and app_private.model_cache_validation_checks_pass(
        critics.gemini_critic
      )
      and jsonb_typeof(critics.gemini_critic -> 'rejection_reasons') = 'array'
      and jsonb_array_length(
        critics.gemini_critic -> 'rejection_reasons'
      ) = 0
      and critics.gemini_critic ->> 'verdict_sha256' =
        completion.secondary_verdict_sha256
      and app_private.worksheet_critic_verdict_sha256(
        critics.gemini_critic
      ) = completion.secondary_verdict_sha256
      and (
        select count(*)
        from public.practice_test_questions question
        where question.practice_test_id = test.id
      ) = case when test.level = 'A2' then 9 else 8 end
      and not exists (
        select 1
        from public.practice_test_questions question
        where question.practice_test_id = test.id
          and (
            question.question_type <> 'multiple_choice'
            or question.evaluation_mode <> 'local_exact'
            or question.answer_contract_version <> 1
            or question.rubric is not null
            or jsonb_typeof(question.options) is distinct from 'array'
            or jsonb_array_length(question.options) not between 3 and 4
            or jsonb_typeof(question.accepted_answers)
              is distinct from 'array'
            or jsonb_array_length(question.accepted_answers) <> 1
            or jsonb_typeof(question.accepted_answers #> '{0}')
              is distinct from 'string'
            or question.accepted_answers #>> '{0}'
              is distinct from question.correct_answer
            or exists (
              select 1
              from jsonb_array_elements(question.options) option_value(value)
              where jsonb_typeof(option_value.value) is distinct from 'string'
                or length(btrim(option_value.value #>> '{}')) = 0
            )
            or (
              select count(*) <> count(distinct
                app_private.normalize_practice_contract_value(
                  option_value,
                  scoring.strict_scoring
                )
              )
              from jsonb_array_elements_text(question.options) option_value
            )
            or (
              select count(*)
              from jsonb_array_elements_text(question.options) option_value
              where app_private.normalize_practice_contract_value(
                option_value,
                scoring.strict_scoring
              ) = app_private.normalize_practice_contract_value(
                question.correct_answer,
                scoring.strict_scoring
              )
            ) <> 1
          )
      )
  ), false);
$$;

revoke all on function
  app_private.practice_test_has_current_unlinked_model_evidence(uuid)
from public, anon, authenticated, service_role;

-- Generalize the existing canonical-current predicate instead of adding a
-- parallel wrapper stack. All existing summary, question, draft, request and
-- generation-context boundaries already depend on this predicate and the
-- unstarted-clone helper below.
create or replace function app_private.practice_test_canonical_revision_is_current(
  target_practice_test_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select case
      -- The promoted source has no forward cache column. Resolve that source
      -- through the immutable reverse reference so withdrawing a cache entry
      -- also removes the original workspace worksheet from future reuse.
      when exists (
        select 1
        from app_private.practice_worksheet_model_cache_sources source_link
        where source_link.source_practice_test_id = test.id
      ) then exists (
        select 1
        from app_private.practice_worksheet_model_cache_sources source_link
        where source_link.source_practice_test_id = test.id
          and source_link.source_content_sha256 =
            app_private.practice_test_content_sha256(test.id)
          and app_private.practice_worksheet_model_cache_revision_is_current(
            source_link.revision_id
          )
      )
      when test.worksheet_model_cache_revision_id is not null then exists (
        select 1
        from app_private.practice_worksheet_model_cache_revisions cache_revision
        where cache_revision.id = test.worksheet_model_cache_revision_id
          and cache_revision.content_sha256 = test.model_cache_content_sha256
          and app_private.practice_worksheet_model_cache_revision_is_current(
            cache_revision.id
          )
      )
      -- Ordinary human/manual material keeps its established behavior. Legacy
      -- independent-model rows predate the mandatory content-check evidence
      -- and remain quarantined until promotion creates an immutable source
      -- link handled by the branch above.
      when test.worksheet_template_revision_id is null then
        test.approval_source is distinct from 'independent_model_validation'
        or app_private.practice_test_has_current_unlinked_model_evidence(
          test.id
        )
      else exists (
        select 1
        from app_private.practice_worksheet_template_revisions revision
        join app_private.practice_worksheet_template_reviews review
          on review.revision_id = revision.id
         and review.decision = 'approved'
         and review.content_sha256 = revision.content_sha256
        join app_private.practice_worksheet_template_releases release
          on release.id = test.worksheet_template_release_id
         and release.revision_id = revision.id
         and release.review_id = review.id
         and release.content_sha256 = revision.content_sha256
        join app_private.practice_worksheet_bank_reviewers reviewer
          on reviewer.user_id = review.reviewer_id
         and reviewer.active
         and reviewer.can_certify
         and reviewer.verified_at <= review.reviewed_at
         and (
           reviewer.expires_at is null
           or reviewer.expires_at > greatest(review.reviewed_at, now())
         )
        join app_private.practice_worksheet_bank_reviewers releaser
          on releaser.user_id = release.released_by
         and releaser.active
         and releaser.can_release
         and releaser.verified_at <= release.released_at
         and (
           releaser.expires_at is null
           or releaser.expires_at > greatest(release.released_at, now())
         )
        where revision.id = test.worksheet_template_revision_id
          and revision.state = 'released'
          and revision.content_sha256 = test.template_content_sha256
          and revision.content_sha256 =
            app_private.practice_worksheet_template_revision_sha256(
              revision.id
            )
          and not exists (
            select 1
            from app_private.practice_worksheet_template_withdrawals withdrawal
            where withdrawal.revision_id = revision.id
          )
      )
    end
    from public.practice_tests test
    where test.id = target_practice_test_id
  ), false);
$$;

revoke all on function app_private.practice_test_canonical_revision_is_current(uuid)
from public, anon, authenticated, service_role;

create or replace function app_private.practice_assignment_has_withdrawn_unstarted_clone(
  target_assignment_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select
      assignment.status = 'unlocked'
      and assignment.started_at is null
      and assignment.latest_attempt_id is null
      and assignment.practice_test_id is not null
      and not app_private.practice_test_canonical_revision_is_current(
        assignment.practice_test_id
      )
      and exists (
        select 1
        from public.practice_tests worksheet
        where worksheet.id = assignment.practice_test_id
          and (
            worksheet.worksheet_template_revision_id is not null
            or worksheet.worksheet_model_cache_revision_id is not null
            or worksheet.approval_source = 'independent_model_validation'
            or exists (
              select 1
              from app_private.practice_worksheet_model_cache_sources source_link
              where source_link.source_practice_test_id = worksheet.id
            )
          )
      )
      and not exists (
        select 1
        from app_private.practice_drafts draft
        where draft.assignment_id = assignment.id
      )
      and not exists (
        select 1
        from public.practice_test_attempts attempt
        where attempt.assignment_id = assignment.id
      )
    from public.student_practice_assignments assignment
    where assignment.id = target_assignment_id
  ), false);
$$;

revoke all on function
  app_private.practice_assignment_has_withdrawn_unstarted_clone(uuid)
from public, anon, authenticated, service_role;

-- The existing assignment trigger already points at this function. Replacing
-- it extends the same fail-closed attachment boundary to cache clones without
-- adding a second trigger or wrapper stack.
create or replace function app_private.guard_withdrawn_canonical_practice_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_template_revision_id uuid;
  selected_cache_revision_id uuid;
  selected_source_revision_id uuid;
  selected_revision_state text;
begin
  if new.practice_test_id is not null
    and (tg_op = 'INSERT' or new.practice_test_id is distinct from old.practice_test_id)
  then
    select
      test.worksheet_template_revision_id,
      test.worksheet_model_cache_revision_id,
      (
        select source_link.revision_id
        from app_private.practice_worksheet_model_cache_sources source_link
        where source_link.source_practice_test_id = test.id
      )
    into
      selected_template_revision_id,
      selected_cache_revision_id,
      selected_source_revision_id
    from public.practice_tests test
    where test.id = new.practice_test_id;

    if selected_source_revision_id is not null then
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        pg_catalog.concat(
          'model-cache-withdrawal:',
          selected_source_revision_id::text
        ),
        0
      ));

      if not app_private.practice_test_canonical_revision_is_current(
        new.practice_test_id
      ) then
        raise exception using
          errcode = '55000',
          message = 'withdrawn_canonical_worksheet_not_reusable';
      end if;
    elsif selected_cache_revision_id is not null then
      -- Serialize future attachment against the exact withdrawal operation.
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        pg_catalog.concat(
          'model-cache-withdrawal:',
          selected_cache_revision_id::text
        ),
        0
      ));

      if not app_private.practice_test_canonical_revision_is_current(
        new.practice_test_id
      ) then
        raise exception using
          errcode = '55000',
          message = 'withdrawn_canonical_worksheet_not_reusable';
      end if;
    elsif selected_template_revision_id is not null then
      select revision.state
      into selected_revision_state
      from app_private.practice_worksheet_template_revisions revision
      where revision.id = selected_template_revision_id
      for share;

      if selected_revision_state is distinct from 'released'
        or not app_private.practice_test_canonical_revision_is_current(
          new.practice_test_id
        )
      then
        raise exception using
          errcode = '55000',
          message = 'withdrawn_canonical_worksheet_not_reusable';
      end if;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function app_private.guard_withdrawn_canonical_practice_assignment()
from public, anon, authenticated, service_role;

-- Preserve in-progress draft completion exactly as the canonical withdrawal
-- policy does, while blocking every new attempt on an unstarted withdrawn
-- cache clone.
create or replace function app_private.guard_withdrawn_canonical_practice_attempt()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_template_revision_id uuid;
  selected_cache_revision_id uuid;
  selected_source_revision_id uuid;
  selected_independent_model boolean := false;
  selected_revision_state text;
  worksheet_withdrawn boolean := false;
begin
  select
    worksheet.worksheet_template_revision_id,
    worksheet.worksheet_model_cache_revision_id,
    worksheet.approval_source = 'independent_model_validation',
    (
      select source_link.revision_id
      from app_private.practice_worksheet_model_cache_sources source_link
      where source_link.source_practice_test_id = worksheet.id
    )
  into
    selected_template_revision_id,
    selected_cache_revision_id,
    selected_independent_model,
    selected_source_revision_id
  from public.practice_tests worksheet
  where worksheet.id = new.practice_test_id;

  if selected_source_revision_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      pg_catalog.concat(
        'model-cache-withdrawal:',
        selected_source_revision_id::text
      ),
      0
    ));
    worksheet_withdrawn := not
      app_private.practice_test_canonical_revision_is_current(
        new.practice_test_id
      );
  elsif selected_cache_revision_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      pg_catalog.concat(
        'model-cache-withdrawal:',
        selected_cache_revision_id::text
      ),
      0
    ));
    worksheet_withdrawn := not
      app_private.practice_test_canonical_revision_is_current(
        new.practice_test_id
      );
  elsif selected_template_revision_id is not null then
    select revision.state
    into selected_revision_state
    from app_private.practice_worksheet_template_revisions revision
    where revision.id = selected_template_revision_id
    for share;
    worksheet_withdrawn := selected_revision_state is distinct from 'released'
      or not app_private.practice_test_canonical_revision_is_current(
        new.practice_test_id
      );
  elsif selected_independent_model then
    worksheet_withdrawn := not
      app_private.practice_test_canonical_revision_is_current(
        new.practice_test_id
      );
  end if;

  if worksheet_withdrawn then
    if new.assignment_id is null
      or not exists (
        select 1
        from public.student_practice_assignments assignment
        join app_private.practice_drafts draft
          on draft.assignment_id = assignment.id
         and draft.student_id = assignment.student_id
         and draft.workspace_id = assignment.workspace_id
        where assignment.id = new.assignment_id
          and assignment.practice_test_id = new.practice_test_id
          and assignment.student_id = new.student_id
          and assignment.workspace_id = new.workspace_id
          and assignment.status = 'in_progress'
          and assignment.started_at is not null
      )
    then
      raise exception using
        errcode = '55000',
        message = 'worksheet_withdrawn_replacement_required';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function app_private.guard_withdrawn_canonical_practice_attempt()
from public, anon, authenticated, service_role;

comment on function app_private.practice_test_canonical_revision_is_current(uuid)
is
  'Current-source predicate for ordinary workspace material, qualified canonical clones, and model-validated cache clones. A withdrawn source makes every future unstarted use fail closed.';

create or replace function app_private.guard_model_cache_clone_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_parent_is_cache boolean := false;
  new_parent_is_cache boolean := false;
begin
  if tg_table_name = 'practice_tests' then
    if tg_op = 'INSERT' then
      if new.worksheet_model_cache_revision_id is not null
        and current_setting('app.model_cache_clone', true) is distinct from 'on'
      then
        raise exception using
          errcode = '42501',
          message = 'model_cache_clone_required';
      end if;
      return new;
    end if;

    if old.worksheet_model_cache_revision_id is not null
      or (tg_op = 'UPDATE' and new.worksheet_model_cache_revision_id is not null)
    then
      raise exception using
        errcode = '55000',
        message = 'model_cache_clone_immutable';
    end if;
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op in ('UPDATE', 'DELETE') then
    select exists (
      select 1
      from public.practice_tests test
      where test.id = old.practice_test_id
        and test.worksheet_model_cache_revision_id is not null
    ) into old_parent_is_cache;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    select exists (
      select 1
      from public.practice_tests test
      where test.id = new.practice_test_id
        and test.worksheet_model_cache_revision_id is not null
    ) into new_parent_is_cache;
  end if;

  if tg_op = 'INSERT' then
    if new_parent_is_cache
      and current_setting('app.model_cache_clone', true) = 'on'
    then
      return new;
    end if;
    if new_parent_is_cache then
      raise exception using
        errcode = '55000',
        message = 'model_cache_clone_immutable';
    end if;
    return new;
  end if;

  -- UPDATE checks both parents. Otherwise a row could be moved out of a cache
  -- clone by changing practice_test_id and evade a NEW-parent-only guard.
  if old_parent_is_cache or new_parent_is_cache then
    raise exception using
      errcode = '55000',
      message = 'model_cache_clone_immutable';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function app_private.guard_model_cache_clone_mutation()
from public, anon, authenticated, service_role;

create trigger practice_tests_09_model_cache_clone_guard
before insert or update or delete on public.practice_tests
for each row execute function app_private.guard_model_cache_clone_mutation();

create trigger practice_test_questions_09_model_cache_clone_guard
before insert or update or delete on public.practice_test_questions
for each row execute function app_private.guard_model_cache_clone_mutation();

create or replace function app_private.select_model_validated_worksheet_cache(
  target_workspace_id uuid,
  target_student_id uuid,
  target_grammar_topic_id uuid,
  target_level text,
  target_cycle_id uuid default null,
  allow_reuse boolean default false
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select revision.id
  from app_private.practice_worksheet_model_cache_revisions revision
  left join lateral (
    select
      count(*)::integer as assignment_count,
      max(assignment.updated_at) as last_assigned_at
    from public.student_practice_assignments assignment
    join public.practice_tests test on test.id = assignment.practice_test_id
    where assignment.workspace_id = target_workspace_id
      and assignment.student_id = target_student_id
      and test.worksheet_model_cache_revision_id = revision.id
  ) usage on true
  where target_workspace_id is not null
    and target_student_id is not null
    and target_grammar_topic_id is not null
    and target_level in ('A1', 'A2', 'B1', 'B2')
    and exists (
      select 1
      from public.workspace_members membership
      where membership.workspace_id = target_workspace_id
        and membership.user_id = target_student_id
        and membership.role = 'student'
    )
    and revision.grammar_topic_id = target_grammar_topic_id
    and revision.level = target_level
    and app_private.practice_topic_level_gate_satisfied(
      target_grammar_topic_id,
      target_level,
      target_cycle_id
    )
    and app_private.practice_worksheet_model_cache_revision_is_current(
      revision.id
    )
    and (
      coalesce(allow_reuse, false)
      or coalesce(usage.assignment_count, 0) = 0
    )
  order by
    case when coalesce(usage.assignment_count, 0) = 0 then 0 else 1 end,
    coalesce(usage.assignment_count, 0),
    usage.last_assigned_at nulls first,
    case revision.difficulty when 'easy' then 1 when 'medium' then 2 else 3 end,
    revision.promoted_at,
    revision.id
  limit 1;
$$;

revoke all on function app_private.select_model_validated_worksheet_cache(
  uuid, uuid, uuid, text, uuid, boolean
) from public, anon, authenticated, service_role;

create or replace function app_private.clone_model_validated_worksheet_cache(
  target_workspace_id uuid,
  target_revision_id uuid,
  target_cycle_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_revision app_private.practice_worksheet_model_cache_revisions%rowtype;
  existing_test public.practice_tests%rowtype;
  cloned_test_id uuid;
  actual_clone_hash text;
begin
  if target_workspace_id is null or target_revision_id is null then
    raise exception using errcode = '22023', message = 'model_cache_clone_context_required';
  end if;
  if not exists (
    select 1 from public.workspaces workspace where workspace.id = target_workspace_id
  ) then
    raise exception using errcode = 'P0002', message = 'workspace_not_found';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    concat('model-cache-withdrawal:', target_revision_id::text),
    0
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    concat(
      'model-cache-clone:',
      target_workspace_id::text,
      ':',
      target_revision_id::text
    ),
    0
  ));

  select revision.*
  into selected_revision
  from app_private.practice_worksheet_model_cache_revisions revision
  where revision.id = target_revision_id
  for share;

  if selected_revision.id is null
    or not app_private.practice_worksheet_model_cache_revision_is_current(
      selected_revision.id
    )
  then
    raise exception using errcode = 'P0002', message = 'model_cache_revision_not_available';
  end if;
  if not app_private.practice_topic_level_gate_satisfied(
    selected_revision.grammar_topic_id,
    selected_revision.level,
    target_cycle_id
  ) then
    raise exception using
      errcode = '42501',
      message = 'practice_level_fit_provider_generation_not_approved';
  end if;

  select test.*
  into existing_test
  from public.practice_tests test
  where test.workspace_id = target_workspace_id
    and test.worksheet_model_cache_revision_id = selected_revision.id
  limit 1;

  if existing_test.id is not null then
    actual_clone_hash := app_private.practice_test_content_sha256(existing_test.id);
    if existing_test.model_cache_content_sha256 <> selected_revision.content_sha256
      or existing_test.approval_source <> 'independent_model_validation'
      or existing_test.teacher_reviewed
      or not existing_test.created_by_ai
      or existing_test.generation_source <> selected_revision.generator_provider
      or existing_test.generator_model <> selected_revision.generator_model
      or actual_clone_hash <> selected_revision.content_sha256
    then
      raise exception using
        errcode = '55000',
        message = 'model_cache_existing_clone_invalid';
    end if;
    return existing_test.id;
  end if;

  perform set_config('app.model_cache_clone', 'on', true);
  insert into public.practice_tests (
    workspace_id,
    grammar_topic_id,
    level,
    difficulty,
    title,
    description,
    created_by_ai,
    teacher_reviewed,
    visibility,
    created_by,
    mini_lesson,
    generation_source,
    quality_status,
    quality_notes,
    generator_model,
    generation_metadata,
    approval_source,
    worksheet_model_cache_revision_id,
    model_cache_content_sha256
  ) values (
    target_workspace_id,
    selected_revision.grammar_topic_id,
    selected_revision.level,
    selected_revision.difficulty,
    selected_revision.title,
    selected_revision.description,
    true,
    false,
    'workspace',
    null,
    selected_revision.mini_lesson,
    selected_revision.generator_provider,
    'approved',
    concat(
      'model_cache_revision=', selected_revision.id::text,
      '; content_sha256=', selected_revision.content_sha256
    ),
    selected_revision.generator_model,
    jsonb_build_object(
      'schema_version', 1,
      'validation', selected_revision.validation_metadata,
      'model_cache', jsonb_build_object(
        'schema_version', 1,
        'revision_id', selected_revision.id,
        'validation_profile', selected_revision.validation_profile,
        'content_sha256', selected_revision.content_sha256
      )
    ),
    'independent_model_validation',
    selected_revision.id,
    selected_revision.content_sha256
  ) returning id into cloned_test_id;

  insert into public.practice_test_questions (
    practice_test_id,
    question_number,
    question_type,
    evaluation_mode,
    prompt,
    options,
    correct_answer,
    accepted_answers,
    rubric,
    answer_contract_version,
    explanation
  )
  select
    cloned_test_id,
    question.question_number,
    question.question_type,
    question.evaluation_mode,
    question.prompt,
    question.options,
    question.correct_answer,
    question.accepted_answers,
    question.rubric,
    question.answer_contract_version,
    question.explanation
  from app_private.practice_worksheet_model_cache_questions question
  where question.revision_id = selected_revision.id
  order by question.question_number;
  perform set_config('app.model_cache_clone', 'off', true);

  actual_clone_hash := app_private.practice_test_content_sha256(cloned_test_id);
  if actual_clone_hash <> selected_revision.content_sha256 then
    raise exception using errcode = '55000', message = 'model_cache_clone_hash_mismatch';
  end if;

  return cloned_test_id;
end;
$$;

revoke all on function app_private.clone_model_validated_worksheet_cache(
  uuid, uuid, uuid
) from public, anon, authenticated, service_role;

-- Content-free attachment evidence covers synchronous requests, active-worker
-- terminal rescue and the independent recovery sweep.
create table app_private.practice_worksheet_model_cache_attachment_events (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null
    references public.student_practice_assignments(id) on delete restrict,
  job_id uuid references app_private.async_jobs(id) on delete restrict,
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  student_id uuid not null references public.profiles(id) on delete restrict,
  cache_revision_id uuid not null
    references app_private.practice_worksheet_model_cache_revisions(id)
    on delete restrict,
  cloned_practice_test_id uuid not null
    references public.practice_tests(id) on delete restrict,
  attachment_source text not null check (
    attachment_source in ('request', 'terminal_worker', 'recovery_sweep')
  ),
  requested_by uuid references public.profiles(id) on delete restrict,
  fallback_reason text check (
    fallback_reason is null
    or fallback_reason in (
      'provider_unavailable', 'provider_exhausted', 'candidates_rejected'
    )
  ),
  rejected_candidate_count smallint not null default 0
    check (rejected_candidate_count between 0 and 2),
  rejected_candidates_sha256 text check (
    rejected_candidates_sha256 is null
    or rejected_candidates_sha256 ~ '^[a-f0-9]{64}$'
  ),
  created_at timestamptz not null default now(),
  unique (attachment_source, assignment_id, cloned_practice_test_id),
  check (
    (
      attachment_source = 'terminal_worker'
      and job_id is not null
      and fallback_reason is not null
      and rejected_candidates_sha256 is not null
    )
    or (
      attachment_source <> 'terminal_worker'
      and fallback_reason is null
      and rejected_candidate_count = 0
      and rejected_candidates_sha256 is null
    )
  )
);

create unique index practice_worksheet_model_cache_attachment_job_idx
on app_private.practice_worksheet_model_cache_attachment_events (job_id)
where job_id is not null and attachment_source = 'terminal_worker';

alter table app_private.practice_worksheet_model_cache_attachment_events
  enable row level security;
revoke all on table app_private.practice_worksheet_model_cache_attachment_events
from public, anon, authenticated, service_role;

create or replace function app_private.guard_model_cache_attachment_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_setting('app.model_cache_attachment', true) is distinct from 'on'
    or not exists (
      select 1
      from public.student_practice_assignments assignment
      join public.practice_tests test
        on test.id = new.cloned_practice_test_id
       and test.workspace_id = assignment.workspace_id
       and test.worksheet_model_cache_revision_id = new.cache_revision_id
       and test.model_cache_content_sha256 is not null
       and test.approval_source = 'independent_model_validation'
      where assignment.id = new.assignment_id
        and assignment.workspace_id = new.workspace_id
        and assignment.student_id = new.student_id
        and assignment.practice_test_id = new.cloned_practice_test_id
        and assignment.generation_status = 'ready'
    )
  then
    raise exception using errcode = '42501', message = 'model_cache_attachment_required';
  end if;
  return new;
end;
$$;

revoke all on function app_private.guard_model_cache_attachment_insert()
from public, anon, authenticated, service_role;

create trigger practice_worksheet_model_cache_attachment_events_00_guard
before insert on app_private.practice_worksheet_model_cache_attachment_events
for each row execute function app_private.guard_model_cache_attachment_insert();

create trigger practice_worksheet_model_cache_attachment_events_immutable
before update or delete
on app_private.practice_worksheet_model_cache_attachment_events
for each row execute function app_private.reject_worksheet_bank_history_mutation();

-- The mature request function still owns authentication, class locking,
-- certified-bank preference, abuse limits and durable queuing. This wrapper
-- runs only after that boundary. A queued message is invisible before commit,
-- so a cache hit can archive it in the same transaction before any worker or
-- paid provider can observe it.
alter function public.request_practice_worksheet(uuid)
rename to request_practice_worksheet_before_model_cache;

revoke all on function public.request_practice_worksheet_before_model_cache(uuid)
from public, anon, authenticated, service_role;

create function public.request_practice_worksheet(
  target_assignment_id uuid
)
returns table (
  assignment_id uuid,
  job_id uuid,
  generation_status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  requested record;
  assignment_snapshot public.student_practice_assignments%rowtype;
  selected_assignment public.student_practice_assignments%rowtype;
  selected_job app_private.async_jobs%rowtype;
  selected_revision_id uuid;
  cloned_test_id uuid;
begin
  select prior.*
  into strict requested
  from public.request_practice_worksheet_before_model_cache(
    target_assignment_id
  ) prior;

  if requested.generation_status = 'ready' then
    return query select
      requested.assignment_id,
      requested.job_id,
      requested.generation_status;
    return;
  end if;

  select assignment.*
  into assignment_snapshot
  from public.student_practice_assignments assignment
  where assignment.id = target_assignment_id;

  if assignment_snapshot.id is null
    or assignment_snapshot.status not in ('unlocked', 'in_progress')
    or assignment_snapshot.practice_test_id is not null
    or assignment_snapshot.class_context_version is distinct from 1
    or assignment_snapshot.class_context_integrity not in (
      'writing_snapshot', 'teacher_verified'
    )
    or assignment_snapshot.batch_id is null
    or assignment_snapshot.worksheet_level not in ('A1', 'A2', 'B1', 'B2')
    or not app_private.practice_topic_level_gate_satisfied(
      assignment_snapshot.grammar_topic_id,
      assignment_snapshot.worksheet_level,
      assignment_snapshot.resolution_cycle_id
    )
  then
    return query select
      requested.assignment_id,
      requested.job_id,
      requested.generation_status;
    return;
  end if;

  -- Preserve the existing trust order. If an unseen approved worksheet is
  -- already present in this workspace, let the established worker context
  -- attach it ahead of the cross-workspace model cache.
  if exists (
    select 1
    from public.practice_tests test
    where test.workspace_id = assignment_snapshot.workspace_id
      and test.grammar_topic_id = assignment_snapshot.grammar_topic_id
      and test.level = assignment_snapshot.worksheet_level
      and test.visibility = 'workspace'
      and test.quality_status = 'approved'
      -- Cache clones are deliberately handled below by the cache selector,
      -- clone replay, and attachment ledger so they have one provenance path.
      and test.worksheet_model_cache_revision_id is null
      and test.approval_source in (
        'workspace_human_review',
        'independent_model_validation',
        'certified_template_bank'
      )
      and test.generation_source <> 'system_fallback'
      and app_private.practice_test_canonical_revision_is_current(test.id)
      and exists (
        select 1
        from public.practice_test_questions question
        where question.practice_test_id = test.id
          and question.answer_contract_version = 1
      )
      and not exists (
        select 1
        from public.practice_test_questions question
        where question.practice_test_id = test.id
          and question.answer_contract_version <> 1
      )
      and not exists (
        select 1
        from public.student_practice_assignments prior_assignment
        where prior_assignment.workspace_id = assignment_snapshot.workspace_id
          and prior_assignment.student_id = assignment_snapshot.student_id
          and prior_assignment.practice_test_id = test.id
          and prior_assignment.id <> assignment_snapshot.id
      )
  ) then
    return query select
      requested.assignment_id,
      requested.job_id,
      requested.generation_status;
    return;
  end if;

  if not app_private.lock_active_practice_class_context(
    assignment_snapshot.workspace_id,
    assignment_snapshot.student_id,
    assignment_snapshot.batch_id,
    assignment_snapshot.worksheet_level
  ) then
    return query select
      requested.assignment_id,
      requested.job_id,
      requested.generation_status;
    return;
  end if;

  select job.*
  into selected_job
  from app_private.async_jobs job
  where job.job_kind = 'worksheet_generation'
    and job.entity_id = assignment_snapshot.id
    and job.status in ('queued', 'retry', 'processing')
  order by job.entity_version desc
  limit 1
  for update;

  select assignment.*
  into selected_assignment
  from public.student_practice_assignments assignment
  where assignment.id = assignment_snapshot.id
  for update;

  if selected_assignment.id is null
    or selected_assignment.workspace_id is distinct from assignment_snapshot.workspace_id
    or selected_assignment.student_id is distinct from assignment_snapshot.student_id
    or selected_assignment.grammar_topic_id is distinct from assignment_snapshot.grammar_topic_id
    or selected_assignment.batch_id is distinct from assignment_snapshot.batch_id
    or selected_assignment.worksheet_level is distinct from assignment_snapshot.worksheet_level
    or selected_assignment.status not in ('unlocked', 'in_progress')
    or selected_assignment.practice_test_id is not null
    or not app_private.practice_topic_level_gate_satisfied(
      selected_assignment.grammar_topic_id,
      selected_assignment.worksheet_level,
      selected_assignment.resolution_cycle_id
    )
    or (
      selected_job.id is not null
      and selected_job.status = 'processing'
      and selected_job.lease_expires_at is not null
      and selected_job.lease_expires_at > now()
    )
  then
    return query select
      requested.assignment_id,
      requested.job_id,
      requested.generation_status;
    return;
  end if;

  selected_revision_id := app_private.select_model_validated_worksheet_cache(
    selected_assignment.workspace_id,
    selected_assignment.student_id,
    selected_assignment.grammar_topic_id,
    selected_assignment.worksheet_level,
    selected_assignment.resolution_cycle_id,
    true
  );

  if selected_revision_id is null then
    return query select
      requested.assignment_id,
      requested.job_id,
      requested.generation_status;
    return;
  end if;

  begin
    cloned_test_id := app_private.clone_model_validated_worksheet_cache(
      selected_assignment.workspace_id,
      selected_revision_id,
      selected_assignment.resolution_cycle_id
    );
  exception when sqlstate 'P0002' then
    if sqlerrm <> 'model_cache_revision_not_available' then raise; end if;
    return query select
      requested.assignment_id,
      requested.job_id,
      requested.generation_status;
    return;
  end;

  if selected_job.id is not null then
    if selected_job.queue_message_id is not null then
      perform pgmq.archive(selected_job.queue_name, selected_job.queue_message_id);
    end if;
    update app_private.async_jobs job
    set
      status = 'dead',
      worker_id = null,
      lease_expires_at = null,
      dead_at = now(),
      last_error_code = 'model_cache_attached'
    where job.id = selected_job.id;
  end if;

  update public.student_practice_assignments assignment
  set
    practice_test_id = cloned_test_id,
    generation_status = 'ready',
    generation_started_at = null,
    generation_completed_at = now(),
    generation_error = null
  where assignment.id = selected_assignment.id;

  perform set_config('app.model_cache_attachment', 'on', true);
  insert into app_private.practice_worksheet_model_cache_attachment_events (
    assignment_id,
    job_id,
    workspace_id,
    student_id,
    cache_revision_id,
    cloned_practice_test_id,
    attachment_source,
    requested_by
  ) values (
    selected_assignment.id,
    selected_job.id,
    selected_assignment.workspace_id,
    selected_assignment.student_id,
    selected_revision_id,
    cloned_test_id,
    'request',
    caller_id
  ) on conflict (
    attachment_source,
    assignment_id,
    cloned_practice_test_id
  ) do nothing;
  perform set_config('app.model_cache_attachment', 'off', true);

  return query select selected_assignment.id, null::uuid, 'ready'::text;
end;
$$;

revoke all on function public.request_practice_worksheet(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.request_practice_worksheet(uuid)
to authenticated;

-- Move the free cache/current-workspace decision in front of the Phase 13F
-- paid-enqueue predecessor. Phase 13F still owns authentication, exact class
-- locking, low-CEFR gating, withdrawn-clone repair, and certified-bank first
-- priority. This wrapper is the one point immediately before its provider
-- fallback, so only a genuine material miss can consume paid-work budget.
alter function public.request_practice_worksheet_before_phase_13f(uuid)
rename to request_practice_worksheet_before_phase_14b_paid;

revoke all on function
  public.request_practice_worksheet_before_phase_14b_paid(uuid)
from public, anon, authenticated, service_role;

create function public.request_practice_worksheet_before_phase_13f(
  target_assignment_id uuid
)
returns table (
  assignment_id uuid,
  job_id uuid,
  generation_status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  assignment_snapshot public.student_practice_assignments%rowtype;
  selected_assignment public.student_practice_assignments%rowtype;
  selected_job app_private.async_jobs%rowtype;
  same_workspace_test_id uuid;
  selected_revision_id uuid;
  cloned_test_id uuid;
begin
  -- Preserve the mature authorization and non-oracle boundary.
  perform public.get_practice_assignment_summary_internal(target_assignment_id);

  select assignment.*
  into assignment_snapshot
  from public.student_practice_assignments assignment
  where assignment.id = target_assignment_id;

  -- Legacy assignments retain their exact paid predecessor behavior. Cache
  -- reuse is deliberately limited to the immutable V1 class snapshot.
  if assignment_snapshot.id is null
    or assignment_snapshot.class_context_version is distinct from 1
    or assignment_snapshot.class_context_integrity not in (
      'writing_snapshot', 'teacher_verified'
    )
    or assignment_snapshot.batch_id is null
    or assignment_snapshot.worksheet_level not in ('A1', 'A2', 'B1', 'B2')
  then
    return query
    select paid.*
    from public.request_practice_worksheet_before_phase_14b_paid(
      target_assignment_id
    ) paid;
    return;
  end if;

  if not app_private.lock_active_practice_class_context(
    assignment_snapshot.workspace_id,
    assignment_snapshot.student_id,
    assignment_snapshot.batch_id,
    assignment_snapshot.worksheet_level
  ) then
    raise exception using
      errcode = '42501',
      message = 'active_class_membership_required';
  end if;

  select job.*
  into selected_job
  from app_private.async_jobs job
  where job.job_kind = 'worksheet_generation'
    and job.entity_id = assignment_snapshot.id
    and job.status in ('queued', 'retry', 'processing')
  order by job.entity_version desc
  limit 1
  for update;

  select assignment.*
  into selected_assignment
  from public.student_practice_assignments assignment
  where assignment.id = assignment_snapshot.id
  for update;

  if selected_assignment.id is null
    or selected_assignment.workspace_id is distinct from assignment_snapshot.workspace_id
    or selected_assignment.student_id is distinct from assignment_snapshot.student_id
    or selected_assignment.grammar_topic_id is distinct from assignment_snapshot.grammar_topic_id
    or selected_assignment.batch_id is distinct from assignment_snapshot.batch_id
    or selected_assignment.worksheet_level is distinct from assignment_snapshot.worksheet_level
    or selected_assignment.class_context_version is distinct from 1
    or selected_assignment.class_context_integrity not in (
      'writing_snapshot', 'teacher_verified'
    )
  then
    raise exception using
      errcode = '55000',
      message = 'practice_assignment_context_changed';
  end if;

  if selected_assignment.status not in ('unlocked', 'in_progress')
    or selected_assignment.practice_test_id is not null
  then
    return query
    select paid.*
    from public.request_practice_worksheet_before_phase_14b_paid(
      target_assignment_id
    ) paid;
    return;
  end if;

  if not app_private.practice_topic_level_gate_satisfied(
    selected_assignment.grammar_topic_id,
    selected_assignment.worksheet_level,
    selected_assignment.resolution_cycle_id
  ) then
    if app_private.hold_unapproved_restricted_provider_fallback(
      selected_assignment.id
    ) then
      return query
      select selected_assignment.id, null::uuid, 'needs_review'::text;
      return;
    end if;
    raise exception using
      errcode = '42501',
      message = 'practice_level_fit_provider_generation_not_approved';
  end if;

  -- Never replace a provider call that may already have been dispatched.
  if selected_job.id is not null
    and selected_job.status = 'processing'
    and selected_job.lease_expires_at is not null
    and selected_job.lease_expires_at > now()
  then
    return query
    select paid.*
    from public.request_practice_worksheet_before_phase_14b_paid(
      target_assignment_id
    ) paid;
    return;
  end if;

  -- Certified material has already been attempted by Phase 13F. Next prefer
  -- an unseen, current worksheet in the exact workspace. Cache clones are
  -- excluded so the cache branch below remains their only attachment ledger.
  select test.id
  into same_workspace_test_id
  from public.practice_tests test
  where test.workspace_id = selected_assignment.workspace_id
    and test.grammar_topic_id = selected_assignment.grammar_topic_id
    and test.level = selected_assignment.worksheet_level
    and test.visibility = 'workspace'
    and test.quality_status = 'approved'
    and test.worksheet_model_cache_revision_id is null
    and test.approval_source in (
      'workspace_human_review',
      'independent_model_validation'
    )
    and test.generation_source <> 'system_fallback'
    and app_private.practice_test_canonical_revision_is_current(test.id)
    and exists (
      select 1
      from public.practice_test_questions question
      where question.practice_test_id = test.id
        and question.answer_contract_version = 1
    )
    and not exists (
      select 1
      from public.practice_test_questions question
      where question.practice_test_id = test.id
        and question.answer_contract_version <> 1
    )
    and not exists (
      select 1
      from public.student_practice_assignments prior_assignment
      where prior_assignment.workspace_id = selected_assignment.workspace_id
        and prior_assignment.student_id = selected_assignment.student_id
        and prior_assignment.practice_test_id = test.id
        and prior_assignment.id <> selected_assignment.id
    )
  order by
    case test.approval_source
      when 'workspace_human_review' then 1
      else 2
    end,
    case test.difficulty when 'easy' then 1 when 'medium' then 2 else 3 end,
    test.created_at,
    test.id
  limit 1;

  if same_workspace_test_id is null then
    selected_revision_id := app_private.select_model_validated_worksheet_cache(
      selected_assignment.workspace_id,
      selected_assignment.student_id,
      selected_assignment.grammar_topic_id,
      selected_assignment.worksheet_level,
      selected_assignment.resolution_cycle_id,
      true
    );

    if selected_revision_id is not null then
      begin
        cloned_test_id := app_private.clone_model_validated_worksheet_cache(
          selected_assignment.workspace_id,
          selected_revision_id,
          selected_assignment.resolution_cycle_id
        );
      exception when sqlstate 'P0002' then
        if sqlerrm <> 'model_cache_revision_not_available' then raise; end if;
        selected_revision_id := null;
        cloned_test_id := null;
      end;
    end if;
  else
    cloned_test_id := same_workspace_test_id;
  end if;

  if cloned_test_id is null then
    return query
    select paid.*
    from public.request_practice_worksheet_before_phase_14b_paid(
      target_assignment_id
    ) paid;
    return;
  end if;

  -- A free hit may supersede only work that was never actively leased. The
  -- historical reservation remains auditable; no new reservation is created.
  if selected_job.id is not null then
    if selected_job.queue_message_id is not null then
      perform pgmq.archive(selected_job.queue_name, selected_job.queue_message_id);
    end if;
    update app_private.async_jobs job
    set
      status = 'dead',
      worker_id = null,
      lease_expires_at = null,
      dead_at = now(),
      last_error_code = case
        when same_workspace_test_id is not null
          then 'workspace_worksheet_attached'
        else 'model_cache_attached'
      end
    where job.id = selected_job.id;
  end if;

  update public.student_practice_assignments assignment
  set
    practice_test_id = cloned_test_id,
    generation_status = 'ready',
    generation_started_at = null,
    generation_completed_at = now(),
    generation_error = null
  where assignment.id = selected_assignment.id;

  if selected_revision_id is not null then
    perform set_config('app.model_cache_attachment', 'on', true);
    insert into app_private.practice_worksheet_model_cache_attachment_events (
      assignment_id,
      job_id,
      workspace_id,
      student_id,
      cache_revision_id,
      cloned_practice_test_id,
      attachment_source,
      requested_by
    ) values (
      selected_assignment.id,
      selected_job.id,
      selected_assignment.workspace_id,
      selected_assignment.student_id,
      selected_revision_id,
      cloned_test_id,
      'request',
      caller_id
    ) on conflict (
      attachment_source,
      assignment_id,
      cloned_practice_test_id
    ) do nothing;
    perform set_config('app.model_cache_attachment', 'off', true);
  end if;

  return query select selected_assignment.id, null::uuid, 'ready'::text;
end;
$$;

revoke all on function public.request_practice_worksheet_before_phase_13f(uuid)
from public, anon, authenticated, service_role;

-- The public entrypoint now delegates to Phase 13F, whose final paid-fallback
-- hook above performs free same-workspace/cache attachment before enqueue.
create or replace function public.request_practice_worksheet(
  target_assignment_id uuid
)
returns table (
  assignment_id uuid,
  job_id uuid,
  generation_status text
)
language sql
security definer
set search_path = ''
as $$
  select requested.*
  from public.request_practice_worksheet_before_model_cache(
    target_assignment_id
  ) requested;
$$;

revoke all on function public.request_practice_worksheet(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.request_practice_worksheet(uuid)
to authenticated;

create or replace function api.try_complete_current_model_cache_fallback(
  target_job_id uuid,
  target_queue_message_id bigint,
  target_worker_id uuid,
  target_fallback_reason text,
  rejected_candidates jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  assignment_snapshot public.student_practice_assignments%rowtype;
  selected_assignment public.student_practice_assignments%rowtype;
  selected_job app_private.async_jobs%rowtype;
  selected_revision_id uuid;
  cloned_test_id uuid;
  recorded_event app_private.practice_worksheet_model_cache_attachment_events%rowtype;
  rejected_hash text;
begin
  perform app_private.assert_service_role();

  if target_job_id is null
    or target_queue_message_id is null
    or target_worker_id is null
    or coalesce(target_fallback_reason, '') not in (
      'provider_unavailable', 'provider_exhausted', 'candidates_rejected'
    )
    or jsonb_typeof(rejected_candidates) <> 'array'
    or jsonb_array_length(rejected_candidates) > 2
    or (
      target_fallback_reason = 'candidates_rejected'
      and jsonb_array_length(rejected_candidates) = 0
    )
    or (
      target_fallback_reason <> 'candidates_rejected'
      and jsonb_array_length(rejected_candidates) <> 0
    )
    or exists (
      select 1
      from jsonb_array_elements(rejected_candidates) candidate(item)
      where jsonb_typeof(candidate.item) <> 'object'
        or not (candidate.item ?& array[
          'attempt_number',
          'provider',
          'model',
          'rejection_reasons',
          'candidate'
        ])
        or coalesce(candidate.item ->> 'attempt_number', '') !~ '^[12]$'
        or coalesce(candidate.item ->> 'provider', '') not in (
          'deepseek', 'gemini'
        )
        or coalesce(candidate.item ->> 'model', '') !~ '^[a-zA-Z0-9._:/-]{1,100}$'
        or jsonb_typeof(candidate.item -> 'rejection_reasons') <> 'array'
        or jsonb_array_length(candidate.item -> 'rejection_reasons') not between 1 and 8
        or jsonb_typeof(candidate.item -> 'candidate') <> 'object'
        or octet_length((candidate.item -> 'candidate')::text) > 131072
    )
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_terminal_model_cache_rescue_context_invalid';
  end if;

  rejected_hash := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(rejected_candidates::text, 'UTF8')),
    'hex'
  );

  select assignment.*
  into assignment_snapshot
  from app_private.async_jobs job
  join public.student_practice_assignments assignment
    on assignment.id = job.entity_id
  where job.id = target_job_id
    and job.job_kind = 'worksheet_generation';

  if assignment_snapshot.id is null then
    raise exception using errcode = 'P0002', message = 'worksheet_generation_job_not_found';
  end if;

  if assignment_snapshot.class_context_version is distinct from 1
    or assignment_snapshot.class_context_integrity not in (
      'writing_snapshot', 'teacher_verified'
    )
    or assignment_snapshot.batch_id is null
    or assignment_snapshot.worksheet_level not in ('A1', 'A2', 'B1', 'B2')
  then
    return jsonb_build_object(
      'schema_version', 1,
      'rescued', false,
      'assignment_id', assignment_snapshot.id,
      'practice_test_id', null
    );
  end if;

  if not app_private.lock_active_practice_class_context(
    assignment_snapshot.workspace_id,
    assignment_snapshot.student_id,
    assignment_snapshot.batch_id,
    assignment_snapshot.worksheet_level
  ) then
    return jsonb_build_object(
      'schema_version', 1,
      'rescued', false,
      'assignment_id', assignment_snapshot.id,
      'practice_test_id', null
    );
  end if;

  select job.*
  into selected_job
  from app_private.async_jobs job
  where job.id = target_job_id
  for update;

  select assignment.*
  into selected_assignment
  from public.student_practice_assignments assignment
  where assignment.id = assignment_snapshot.id
  for update;

  if selected_job.status = 'succeeded' then
    select event.*
    into recorded_event
    from app_private.practice_worksheet_model_cache_attachment_events event
    where event.job_id = selected_job.id
      and event.attachment_source = 'terminal_worker';

    if recorded_event.id is not null
      and recorded_event.assignment_id = selected_assignment.id
      and recorded_event.cloned_practice_test_id = selected_assignment.practice_test_id
      and recorded_event.fallback_reason = target_fallback_reason
      and recorded_event.rejected_candidates_sha256 = rejected_hash
    then
      return jsonb_build_object(
        'schema_version', 1,
        'rescued', true,
        'assignment_id', selected_assignment.id,
        'practice_test_id', recorded_event.cloned_practice_test_id
      );
    end if;
    return jsonb_build_object(
      'schema_version', 1,
      'rescued', false,
      'assignment_id', selected_assignment.id,
      'practice_test_id', null
    );
  end if;

  if selected_job.id is null
    or selected_job.job_kind <> 'worksheet_generation'
    or selected_job.entity_id is distinct from assignment_snapshot.id
    or selected_job.status <> 'processing'
    or selected_job.queue_message_id is distinct from target_queue_message_id
    or selected_job.worker_id is distinct from target_worker_id
    or selected_job.lease_expires_at is null
    or selected_job.lease_expires_at <= now()
    or selected_job.entity_version is distinct from selected_assignment.generation_version
    or selected_assignment.workspace_id is distinct from assignment_snapshot.workspace_id
    or selected_assignment.student_id is distinct from assignment_snapshot.student_id
    or selected_assignment.grammar_topic_id is distinct from assignment_snapshot.grammar_topic_id
    or selected_assignment.batch_id is distinct from assignment_snapshot.batch_id
    or selected_assignment.worksheet_level is distinct from assignment_snapshot.worksheet_level
    or selected_assignment.status not in ('unlocked', 'in_progress')
    or selected_assignment.practice_test_id is not null
    or not app_private.practice_topic_level_gate_satisfied(
      selected_assignment.grammar_topic_id,
      selected_assignment.worksheet_level,
      selected_assignment.resolution_cycle_id
    )
  then
    return jsonb_build_object(
      'schema_version', 1,
      'rescued', false,
      'assignment_id', assignment_snapshot.id,
      'practice_test_id', null
    );
  end if;

  selected_revision_id := app_private.select_model_validated_worksheet_cache(
    selected_assignment.workspace_id,
    selected_assignment.student_id,
    selected_assignment.grammar_topic_id,
    selected_assignment.worksheet_level,
    selected_assignment.resolution_cycle_id,
    true
  );

  if selected_revision_id is null then
    return jsonb_build_object(
      'schema_version', 1,
      'rescued', false,
      'assignment_id', selected_assignment.id,
      'practice_test_id', null
    );
  end if;

  begin
    cloned_test_id := app_private.clone_model_validated_worksheet_cache(
      selected_assignment.workspace_id,
      selected_revision_id,
      selected_assignment.resolution_cycle_id
    );
  exception when sqlstate 'P0002' then
    if sqlerrm <> 'model_cache_revision_not_available' then raise; end if;
    return jsonb_build_object(
      'schema_version', 1,
      'rescued', false,
      'assignment_id', selected_assignment.id,
      'practice_test_id', null
    );
  end;

  update public.student_practice_assignments assignment
  set
    practice_test_id = cloned_test_id,
    generation_status = 'ready',
    generation_started_at = null,
    generation_completed_at = now(),
    generation_error = null
  where assignment.id = selected_assignment.id;

  update app_private.async_jobs job
  set
    status = 'succeeded',
    worker_id = null,
    lease_expires_at = null,
    completed_at = now(),
    last_error_code = null
  where job.id = selected_job.id;

  perform pgmq.archive(selected_job.queue_name, selected_job.queue_message_id);

  perform set_config('app.model_cache_attachment', 'on', true);
  insert into app_private.practice_worksheet_model_cache_attachment_events (
    assignment_id,
    job_id,
    workspace_id,
    student_id,
    cache_revision_id,
    cloned_practice_test_id,
    attachment_source,
    fallback_reason,
    rejected_candidate_count,
    rejected_candidates_sha256
  ) values (
    selected_assignment.id,
    selected_job.id,
    selected_assignment.workspace_id,
    selected_assignment.student_id,
    selected_revision_id,
    cloned_test_id,
    'terminal_worker',
    target_fallback_reason,
    jsonb_array_length(rejected_candidates),
    rejected_hash
  );
  perform set_config('app.model_cache_attachment', 'off', true);

  return jsonb_build_object(
    'schema_version', 1,
    'rescued', true,
    'assignment_id', selected_assignment.id,
    'practice_test_id', cloned_test_id
  );
end;
$$;

revoke all on function api.try_complete_current_model_cache_fallback(
  uuid, bigint, uuid, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function api.try_complete_current_model_cache_fallback(
  uuid, bigint, uuid, text, jsonb
) to service_role;

-- Bounded promotion recovery prevents one malformed historical completion from
-- starving later valid cache candidates. Only IDs, counters, timestamps and a
-- stable safe code are retained.
create table app_private.practice_worksheet_model_cache_promotion_failures (
  source_practice_test_id uuid primary key
    references public.practice_tests(id) on delete restrict,
  source_completion_job_id uuid not null
    references app_private.worksheet_generation_completions_v2(job_id)
    on delete restrict,
  failure_count integer not null check (failure_count between 1 and 5),
  first_failed_at timestamptz not null,
  last_attempt_at timestamptz not null,
  next_retry_at timestamptz not null,
  last_safe_error_code text not null check (
    last_safe_error_code ~ '^[a-z0-9_]{1,80}$'
  ),
  resolved_at timestamptz,
  check (resolved_at is null or resolved_at >= last_attempt_at)
);

create index practice_worksheet_model_cache_promotion_failures_due_idx
on app_private.practice_worksheet_model_cache_promotion_failures (
  next_retry_at,
  source_practice_test_id
)
where resolved_at is null and failure_count < 5;

alter table app_private.practice_worksheet_model_cache_promotion_failures
  enable row level security;
revoke all on table app_private.practice_worksheet_model_cache_promotion_failures
from public, anon, authenticated, service_role;

create or replace function api.promote_pending_model_validated_worksheets(
  max_worksheets integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  clean_limit integer := least(greatest(coalesce(max_worksheets, 25), 0), 50);
  candidate record;
  attempted_count integer := 0;
  succeeded_count integer := 0;
  failed_count integer := 0;
  deferred_count integer := 0;
  exhausted_count integer := 0;
  failure_sqlstate text;
  failure_message text;
  safe_error_code text;
begin
  perform app_private.assert_service_role();

  for candidate in
    select
      test.id as practice_test_id,
      completion.job_id,
      completion.content_sha256
    from app_private.worksheet_generation_completions_v2 completion
    join public.practice_tests test on test.id = completion.practice_test_id
    left join app_private.practice_worksheet_model_cache_promotion_failures failure
      on failure.source_practice_test_id = test.id
    where completion.completion_mode = 'generated'
      and completion.completed_at <= now() - interval '5 minutes'
      and test.quality_status = 'approved'
      and test.approval_source = 'independent_model_validation'
      and test.created_by_ai
      and not test.teacher_reviewed
      and test.generation_source in ('deepseek', 'gemini')
      and test.generation_job_id = completion.job_id
      and test.generation_metadata #>> '{validation,deterministic}' = 'true'
      and test.generation_metadata #>> '{validation,independent_model}' = 'true'
      and (
        select count(*)
        from public.practice_test_questions question
        where question.practice_test_id = test.id
      ) = case when test.level = 'A2' then 9 else 8 end
      and not exists (
        select 1
        from public.practice_test_questions question
        where question.practice_test_id = test.id
          and (
            question.question_type <> 'multiple_choice'
            or question.evaluation_mode <> 'local_exact'
            or question.answer_contract_version <> 1
            or question.rubric is not null
          )
      )
      and not exists (
        select 1
        from app_private.practice_worksheet_model_cache_sources source_link
        where source_link.source_practice_test_id = test.id
          and source_link.source_completion_job_id = completion.job_id
      )
      and (
        failure.source_practice_test_id is null
        or failure.resolved_at is not null
        or (
          failure.failure_count < 5
          and failure.next_retry_at <= now()
        )
      )
    order by
      coalesce(failure.failure_count, 0),
      completion.completed_at,
      test.id
    limit clean_limit * 4
  loop
    exit when attempted_count >= clean_limit;
    attempted_count := attempted_count + 1;

    begin
      perform app_private.promote_model_validated_worksheet(
        candidate.practice_test_id
      );
      update app_private.practice_worksheet_model_cache_promotion_failures failure
      set
        last_attempt_at = now(),
        next_retry_at = now(),
        last_safe_error_code = 'model_cache_promotion_resolved',
        resolved_at = now()
      where failure.source_practice_test_id = candidate.practice_test_id
        and failure.resolved_at is null;
      succeeded_count := succeeded_count + 1;
    exception when others then
      get stacked diagnostics
        failure_sqlstate = returned_sqlstate,
        failure_message = message_text;
      safe_error_code := case
        when failure_sqlstate = '40001' then 'model_cache_promotion_serialization_failure'
        when failure_sqlstate = '40P01' then 'model_cache_promotion_deadlock'
        when failure_sqlstate = '55P03' then 'model_cache_promotion_lock_unavailable'
        when failure_sqlstate = '57014' then 'model_cache_promotion_query_cancelled'
        when failure_message = 'model_cache_source_validation_invalid'
          then 'model_cache_promotion_source_invalid'
        when failure_message = 'model_cache_promotion_hash_mismatch'
          then 'model_cache_promotion_hash_mismatch'
        else 'model_cache_promotion_internal_failure'
      end;

      insert into app_private.practice_worksheet_model_cache_promotion_failures (
        source_practice_test_id,
        source_completion_job_id,
        failure_count,
        first_failed_at,
        last_attempt_at,
        next_retry_at,
        last_safe_error_code,
        resolved_at
      ) values (
        candidate.practice_test_id,
        candidate.job_id,
        1,
        now(),
        now(),
        now() + interval '30 seconds',
        safe_error_code,
        null
      )
      on conflict (source_practice_test_id) do update
      set
        source_completion_job_id = excluded.source_completion_job_id,
        failure_count = least(
          5,
          app_private.practice_worksheet_model_cache_promotion_failures.failure_count + 1
        ),
        last_attempt_at = now(),
        next_retry_at = now() + case
          when app_private.practice_worksheet_model_cache_promotion_failures.failure_count = 1
            then interval '1 minute'
          when app_private.practice_worksheet_model_cache_promotion_failures.failure_count = 2
            then interval '5 minutes'
          when app_private.practice_worksheet_model_cache_promotion_failures.failure_count = 3
            then interval '15 minutes'
          else interval '30 minutes'
        end,
        last_safe_error_code = excluded.last_safe_error_code,
        resolved_at = null;
      failed_count := failed_count + 1;
    end;
  end loop;

  select least(count(*)::integer, clean_limit * 4)
  into deferred_count
  from app_private.practice_worksheet_model_cache_promotion_failures failure
  where failure.resolved_at is null
    and failure.failure_count < 5
    and failure.next_retry_at > now();

  select count(*)::integer
  into exhausted_count
  from app_private.practice_worksheet_model_cache_promotion_failures failure
  where failure.resolved_at is null
    and failure.failure_count >= 5
    and not exists (
      select 1
      from app_private.practice_worksheet_model_cache_revisions revision
      where revision.source_practice_test_id = failure.source_practice_test_id
         or revision.source_completion_job_id = failure.source_completion_job_id
    );

  return jsonb_build_object(
    'schema_version', 1,
    'attempted', attempted_count,
    'succeeded', succeeded_count,
    'failed', failed_count,
    'deferred', deferred_count,
    'exhausted', exhausted_count
  );
end;
$$;

revoke all on function api.promote_pending_model_validated_worksheets(integer)
from public, anon, authenticated, service_role;
grant execute on function api.promote_pending_model_validated_worksheets(integer)
to service_role;

create table app_private.practice_worksheet_model_cache_recovery_failures (
  assignment_id uuid primary key
    references public.student_practice_assignments(id) on delete restrict,
  cache_revision_id uuid not null
    references app_private.practice_worksheet_model_cache_revisions(id)
    on delete restrict,
  failure_count integer not null check (failure_count between 0 and 5),
  first_failed_at timestamptz,
  last_attempt_at timestamptz not null,
  next_retry_at timestamptz not null,
  last_safe_error_code text not null check (
    last_safe_error_code ~ '^[a-z0-9_]{1,80}$'
  ),
  resolved_at timestamptz,
  check (
    (failure_count = 0 and first_failed_at is null)
    or (failure_count > 0 and first_failed_at is not null)
  ),
  check (resolved_at is null or resolved_at >= last_attempt_at)
);

create index practice_worksheet_model_cache_recovery_failures_due_idx
on app_private.practice_worksheet_model_cache_recovery_failures (
  next_retry_at,
  assignment_id
)
where resolved_at is null and failure_count < 5;

alter table app_private.practice_worksheet_model_cache_recovery_failures
  enable row level security;
revoke all on table app_private.practice_worksheet_model_cache_recovery_failures
from public, anon, authenticated, service_role;

create or replace function app_private.attach_current_model_cache_for_recovery(
  target_assignment_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  assignment_snapshot public.student_practice_assignments%rowtype;
  selected_assignment public.student_practice_assignments%rowtype;
  selected_job app_private.async_jobs%rowtype;
  selected_revision_id uuid;
  cloned_test_id uuid;
begin
  select assignment.*
  into assignment_snapshot
  from public.student_practice_assignments assignment
  where assignment.id = target_assignment_id;

  if assignment_snapshot.id is null
    or assignment_snapshot.status <> 'unlocked'
    or assignment_snapshot.practice_test_id is not null
    or assignment_snapshot.started_at is not null
    or assignment_snapshot.latest_attempt_id is not null
    or assignment_snapshot.class_context_version is distinct from 1
    or assignment_snapshot.class_context_integrity not in (
      'writing_snapshot', 'teacher_verified'
    )
    or assignment_snapshot.batch_id is null
    or assignment_snapshot.worksheet_level not in ('A1', 'A2', 'B1', 'B2')
    or not app_private.practice_topic_level_gate_satisfied(
      assignment_snapshot.grammar_topic_id,
      assignment_snapshot.worksheet_level,
      assignment_snapshot.resolution_cycle_id
    )
  then
    return false;
  end if;

  if not app_private.lock_active_practice_class_context(
    assignment_snapshot.workspace_id,
    assignment_snapshot.student_id,
    assignment_snapshot.batch_id,
    assignment_snapshot.worksheet_level
  ) then
    return false;
  end if;

  select job.*
  into selected_job
  from app_private.async_jobs job
  where job.job_kind = 'worksheet_generation'
    and job.entity_id = assignment_snapshot.id
    and job.status in ('queued', 'retry', 'processing')
  order by job.entity_version desc
  limit 1
  for update;

  select assignment.*
  into selected_assignment
  from public.student_practice_assignments assignment
  where assignment.id = assignment_snapshot.id
  for update;

  if selected_assignment.id is null
    or selected_assignment.workspace_id is distinct from assignment_snapshot.workspace_id
    or selected_assignment.student_id is distinct from assignment_snapshot.student_id
    or selected_assignment.grammar_topic_id is distinct from assignment_snapshot.grammar_topic_id
    or selected_assignment.batch_id is distinct from assignment_snapshot.batch_id
    or selected_assignment.worksheet_level is distinct from assignment_snapshot.worksheet_level
    or selected_assignment.status <> 'unlocked'
    or selected_assignment.practice_test_id is not null
    or selected_assignment.started_at is not null
    or selected_assignment.latest_attempt_id is not null
    or not app_private.practice_topic_level_gate_satisfied(
      selected_assignment.grammar_topic_id,
      selected_assignment.worksheet_level,
      selected_assignment.resolution_cycle_id
    )
    or (
      selected_job.id is not null
      and selected_job.status = 'processing'
      and selected_job.lease_expires_at is not null
      and selected_job.lease_expires_at > now()
    )
  then
    return false;
  end if;

  selected_revision_id := app_private.select_model_validated_worksheet_cache(
    selected_assignment.workspace_id,
    selected_assignment.student_id,
    selected_assignment.grammar_topic_id,
    selected_assignment.worksheet_level,
    selected_assignment.resolution_cycle_id,
    true
  );
  if selected_revision_id is null then return false; end if;

  begin
    cloned_test_id := app_private.clone_model_validated_worksheet_cache(
      selected_assignment.workspace_id,
      selected_revision_id,
      selected_assignment.resolution_cycle_id
    );
  exception when sqlstate 'P0002' then
    if sqlerrm <> 'model_cache_revision_not_available' then raise; end if;
    return false;
  end;

  if selected_job.id is not null then
    if selected_job.queue_message_id is not null then
      perform pgmq.archive(selected_job.queue_name, selected_job.queue_message_id);
    end if;
    update app_private.async_jobs job
    set
      status = 'dead',
      worker_id = null,
      lease_expires_at = null,
      dead_at = now(),
      last_error_code = 'model_cache_attached'
    where job.id = selected_job.id;
  end if;

  update public.student_practice_assignments assignment
  set
    practice_test_id = cloned_test_id,
    generation_status = 'ready',
    generation_started_at = null,
    generation_completed_at = now(),
    generation_error = null
  where assignment.id = selected_assignment.id;

  perform set_config('app.model_cache_attachment', 'on', true);
  insert into app_private.practice_worksheet_model_cache_attachment_events (
    assignment_id,
    job_id,
    workspace_id,
    student_id,
    cache_revision_id,
    cloned_practice_test_id,
    attachment_source
  ) values (
    selected_assignment.id,
    selected_job.id,
    selected_assignment.workspace_id,
    selected_assignment.student_id,
    selected_revision_id,
    cloned_test_id,
    'recovery_sweep'
  ) on conflict (
    attachment_source,
    assignment_id,
    cloned_practice_test_id
  ) do nothing;
  perform set_config('app.model_cache_attachment', 'off', true);

  return true;
end;
$$;

revoke all on function app_private.attach_current_model_cache_for_recovery(uuid)
from public, anon, authenticated, service_role;

create or replace function api.recover_current_model_cache_assignments(
  max_assignments integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  clean_limit integer := least(greatest(coalesce(max_assignments, 25), 0), 50);
  candidate record;
  processed_count integer := 0;
  attempted_count integer := 0;
  succeeded_count integer := 0;
  failed_count integer := 0;
  deferred_count integer := 0;
  exhausted_count integer := 0;
  failure_sqlstate text;
  failure_message text;
  safe_error_code text;
begin
  perform app_private.assert_service_role();

  for candidate in
    select assignment.id, eligible.cache_revision_id
    from public.student_practice_assignments assignment
    cross join lateral (
      select app_private.select_model_validated_worksheet_cache(
        assignment.workspace_id,
        assignment.student_id,
        assignment.grammar_topic_id,
        assignment.worksheet_level,
        assignment.resolution_cycle_id,
        true
      ) as cache_revision_id
    ) eligible
    left join app_private.practice_worksheet_model_cache_recovery_failures failure
      on failure.assignment_id = assignment.id
    where assignment.status = 'unlocked'
      and assignment.practice_test_id is null
      and assignment.started_at is null
      and assignment.latest_attempt_id is null
      and assignment.class_context_version = 1
      and assignment.class_context_integrity in (
        'writing_snapshot', 'teacher_verified'
      )
      and assignment.batch_id is not null
      and assignment.worksheet_level in ('A1', 'A2', 'B1', 'B2')
      and app_private.practice_class_context_is_active(
        assignment.workspace_id,
        assignment.student_id,
        assignment.batch_id,
        assignment.worksheet_level
      )
      and eligible.cache_revision_id is not null
      and not exists (
        select 1
        from app_private.async_jobs active_job
        where active_job.job_kind = 'worksheet_generation'
          and active_job.entity_id = assignment.id
          and active_job.status = 'processing'
          and active_job.lease_expires_at is not null
          and active_job.lease_expires_at > now()
      )
      and (
        failure.assignment_id is null
        or failure.resolved_at is not null
        or failure.cache_revision_id is distinct from eligible.cache_revision_id
        or (
          failure.failure_count < 5
          and failure.next_retry_at <= now()
        )
      )
    order by
      coalesce(failure.failure_count, 0),
      assignment.updated_at,
      assignment.id
    limit clean_limit * 4
  loop
    exit when processed_count >= clean_limit;
    -- Every helper invocation consumes the operational bound, including a
    -- false/deferred result. `attempted` remains the Edge contract's terminal
    -- outcome count and therefore equals succeeded + failed.
    processed_count := processed_count + 1;

    begin
      if app_private.attach_current_model_cache_for_recovery(candidate.id) then
        update app_private.practice_worksheet_model_cache_recovery_failures failure
        set
          last_attempt_at = now(),
          next_retry_at = now(),
          last_safe_error_code = 'model_cache_recovery_resolved',
          resolved_at = now()
        where failure.assignment_id = candidate.id
          and failure.resolved_at is null;
        attempted_count := attempted_count + 1;
        succeeded_count := succeeded_count + 1;
      else
        insert into app_private.practice_worksheet_model_cache_recovery_failures (
          assignment_id,
          cache_revision_id,
          failure_count,
          first_failed_at,
          last_attempt_at,
          next_retry_at,
          last_safe_error_code,
          resolved_at
        ) values (
          candidate.id,
          candidate.cache_revision_id,
          0,
          null,
          now(),
          now() + interval '15 seconds',
          'model_cache_recovery_deferred',
          null
        )
        on conflict (assignment_id) do update
        set
          cache_revision_id = excluded.cache_revision_id,
          failure_count = case
            when app_private.practice_worksheet_model_cache_recovery_failures.resolved_at is null
              and app_private.practice_worksheet_model_cache_recovery_failures.cache_revision_id
                = excluded.cache_revision_id
            then app_private.practice_worksheet_model_cache_recovery_failures.failure_count
            else 0
          end,
          first_failed_at = case
            when app_private.practice_worksheet_model_cache_recovery_failures.resolved_at is null
              and app_private.practice_worksheet_model_cache_recovery_failures.cache_revision_id
                = excluded.cache_revision_id
            then app_private.practice_worksheet_model_cache_recovery_failures.first_failed_at
            else null
          end,
          last_attempt_at = now(),
          next_retry_at = now() + interval '15 seconds',
          last_safe_error_code = 'model_cache_recovery_deferred',
          resolved_at = null;
        deferred_count := deferred_count + 1;
      end if;
    exception when others then
      get stacked diagnostics
        failure_sqlstate = returned_sqlstate,
        failure_message = message_text;
      safe_error_code := case
        when failure_sqlstate = '40001' then 'model_cache_recovery_serialization_failure'
        when failure_sqlstate = '40P01' then 'model_cache_recovery_deadlock'
        when failure_sqlstate = '55P03' then 'model_cache_recovery_lock_unavailable'
        when failure_sqlstate = '57014' then 'model_cache_recovery_query_cancelled'
        when failure_message = 'model_cache_revision_not_available'
          then 'model_cache_recovery_revision_not_available'
        when failure_message = 'model_cache_clone_hash_mismatch'
          then 'model_cache_recovery_hash_mismatch'
        else 'model_cache_recovery_internal_failure'
      end;

      insert into app_private.practice_worksheet_model_cache_recovery_failures (
        assignment_id,
        cache_revision_id,
        failure_count,
        first_failed_at,
        last_attempt_at,
        next_retry_at,
        last_safe_error_code,
        resolved_at
      ) values (
        candidate.id,
        candidate.cache_revision_id,
        1,
        now(),
        now(),
        now() + interval '30 seconds',
        safe_error_code,
        null
      )
      on conflict (assignment_id) do update
      set
        cache_revision_id = excluded.cache_revision_id,
        failure_count = case
          when app_private.practice_worksheet_model_cache_recovery_failures.resolved_at is null
            and app_private.practice_worksheet_model_cache_recovery_failures.cache_revision_id
              = excluded.cache_revision_id
          then least(
            5,
            app_private.practice_worksheet_model_cache_recovery_failures.failure_count + 1
          )
          else 1
        end,
        first_failed_at = case
          when app_private.practice_worksheet_model_cache_recovery_failures.resolved_at is null
            and app_private.practice_worksheet_model_cache_recovery_failures.cache_revision_id
              = excluded.cache_revision_id
            and app_private.practice_worksheet_model_cache_recovery_failures.failure_count > 0
          then app_private.practice_worksheet_model_cache_recovery_failures.first_failed_at
          else now()
        end,
        last_attempt_at = now(),
        next_retry_at = now() + case
          when app_private.practice_worksheet_model_cache_recovery_failures.failure_count <= 0
            then interval '30 seconds'
          when app_private.practice_worksheet_model_cache_recovery_failures.failure_count = 1
            then interval '1 minute'
          when app_private.practice_worksheet_model_cache_recovery_failures.failure_count = 2
            then interval '5 minutes'
          when app_private.practice_worksheet_model_cache_recovery_failures.failure_count = 3
            then interval '15 minutes'
          else interval '30 minutes'
        end,
        last_safe_error_code = excluded.last_safe_error_code,
        resolved_at = null;
      attempted_count := attempted_count + 1;
      failed_count := failed_count + 1;
    end;
  end loop;

  select least(count(*)::integer, clean_limit * 4)
  into deferred_count
  from app_private.practice_worksheet_model_cache_recovery_failures failure
  where failure.resolved_at is null
    and failure.failure_count < 5
    and failure.next_retry_at > now();

  select count(*)::integer
  into exhausted_count
  from app_private.practice_worksheet_model_cache_recovery_failures failure
  join public.student_practice_assignments assignment
    on assignment.id = failure.assignment_id
  where failure.resolved_at is null
    and failure.failure_count >= 5
    and assignment.status = 'unlocked'
    and assignment.practice_test_id is null
    and app_private.practice_worksheet_model_cache_revision_is_current(
      failure.cache_revision_id
    );

  return jsonb_build_object(
    'schema_version', 1,
    'attempted', attempted_count,
    'succeeded', succeeded_count,
    'failed', failed_count,
    'deferred', deferred_count,
    'exhausted', exhausted_count
  );
end;
$$;

revoke all on function api.recover_current_model_cache_assignments(integer)
from public, anon, authenticated, service_role;
grant execute on function api.recover_current_model_cache_assignments(integer)
to service_role;

comment on table app_private.practice_worksheet_model_cache_revisions is
  'Immutable provider-validated, content-addressed objective worksheet cache. It is separate from and never represents qualified human certification.';
comment on function api.promote_pending_model_validated_worksheets(integer) is
  'Service-only bounded promotion of completed all-MCQ worksheets after immutable DeepSeek and Gemini critic evidence is revalidated.';
comment on function api.try_complete_current_model_cache_fallback(
  uuid, bigint, uuid, text, jsonb
) is
  'Service-only active-lease rescue after the qualified bank misses. It atomically attaches exact model-cache material without bypassing the low-CEFR gate.';
comment on function api.recover_current_model_cache_assignments(integer) is
  'Service-only bounded recovery for untouched assignments stranded after provider work, with exact context, gate and cache-hash revalidation.';
comment on function public.request_practice_worksheet(uuid) is
  'Authorized exact-class request. Qualified and same-workspace approved material retain priority; an exact model-cache hit is attached before queued work becomes provider-visible.';

notify pgrst, 'reload schema';
