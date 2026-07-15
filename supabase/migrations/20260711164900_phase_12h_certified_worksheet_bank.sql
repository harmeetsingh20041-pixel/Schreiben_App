-- Phase 12H: certified global worksheet bank and verified workspace clones.
--
-- This migration deliberately seeds no reviewer entitlements, approvals, or
-- worksheets. A canonical revision becomes eligible only after explicit
-- qualified human certification and release attestations whose hashes match
-- the database-recomputed educational content hash.

create or replace function app_private.worksheet_review_checklist_is_complete(
  checklist jsonb
)
returns boolean
language sql
security invoker
set search_path = ''
immutable
parallel safe
as $$
  select coalesce(
    jsonb_typeof(checklist) = 'object'
    and checklist ?& array[
      'structural_valid',
      'ambiguity_free',
      'no_answer_leakage',
      'level_fit',
      'topic_fit',
      'type_balance',
      'scoring_safe'
    ]
    and checklist - array[
      'structural_valid',
      'ambiguity_free',
      'no_answer_leakage',
      'level_fit',
      'topic_fit',
      'type_balance',
      'scoring_safe'
    ]::text[] = '{}'::jsonb
    and not exists (
      select 1
      from jsonb_each(checklist) check_item
      where check_item.value <> 'true'::jsonb
    ),
    false
  );
$$;

revoke all on function app_private.worksheet_review_checklist_is_complete(jsonb)
from public, anon, authenticated, service_role;

create table app_private.practice_worksheet_bank_reviewers (
  user_id uuid primary key references public.profiles(id) on delete restrict,
  qualification text not null check (length(btrim(qualification)) between 8 and 500),
  can_certify boolean not null default false,
  can_release boolean not null default false,
  active boolean not null default true,
  verified_by uuid not null references public.profiles(id) on delete restrict,
  verified_at timestamptz not null default now(),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (can_certify or can_release),
  check (expires_at is null or expires_at > verified_at)
);

create table app_private.practice_worksheet_templates (
  id uuid primary key default gen_random_uuid(),
  template_key text not null unique
    check (template_key ~ '^[a-z0-9][a-z0-9._-]{5,119}$'),
  grammar_topic_id uuid not null
    references public.grammar_topics(id) on delete restrict,
  level text not null check (level in ('A1', 'A2', 'B1', 'B2')),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table app_private.practice_worksheet_template_revisions (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null
    references app_private.practice_worksheet_templates(id) on delete restrict,
  revision_number integer not null check (revision_number > 0),
  state text not null default 'draft'
    check (state in ('draft', 'certified', 'released', 'rejected', 'superseded')),
  difficulty text not null check (difficulty in ('easy', 'medium', 'hard')),
  title text not null check (length(btrim(title)) between 1 and 120),
  description text not null check (length(btrim(description)) between 1 and 1000),
  mini_lesson jsonb not null check (jsonb_typeof(mini_lesson) = 'object'),
  source_label text check (source_label is null or length(btrim(source_label)) between 1 and 120),
  tags jsonb not null default '[]'::jsonb check (jsonb_typeof(tags) = 'array'),
  import_payload_sha256 text not null check (import_payload_sha256 ~ '^[a-f0-9]{64}$'),
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (template_id, revision_number),
  unique (template_id, content_sha256),
  unique (id, template_id)
);

create table app_private.practice_worksheet_template_questions (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null
    references app_private.practice_worksheet_template_revisions(id) on delete restrict,
  question_number integer not null check (question_number > 0),
  question_type text not null check (question_type in (
    'multiple_choice',
    'fill_blank',
    'sentence_correction',
    'word_order',
    'transformation',
    'rewrite_sentence',
    'mini_writing'
  )),
  evaluation_mode text not null check (evaluation_mode in ('local_exact', 'open_evaluation')),
  prompt text not null check (length(btrim(prompt)) between 12 and 800),
  options jsonb check (options is null or jsonb_typeof(options) = 'array'),
  correct_answer text not null check (length(btrim(correct_answer)) between 1 and 500),
  accepted_answers jsonb not null default '[]'::jsonb
    check (jsonb_typeof(accepted_answers) = 'array'),
  rubric jsonb check (rubric is null or jsonb_typeof(rubric) = 'object'),
  answer_contract_version integer not null default 1 check (answer_contract_version = 1),
  explanation text not null check (length(btrim(explanation)) between 1 and 600),
  created_at timestamptz not null default now(),
  unique (revision_id, question_number)
);

create table app_private.practice_worksheet_template_reviews (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null unique
    references app_private.practice_worksheet_template_revisions(id) on delete restrict,
  reviewer_id uuid not null
    references app_private.practice_worksheet_bank_reviewers(user_id) on delete restrict,
  decision text not null check (decision = 'approved'),
  checklist jsonb not null
    check (app_private.worksheet_review_checklist_is_complete(checklist)),
  notes text not null check (length(btrim(notes)) between 8 and 1000),
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  reviewed_at timestamptz not null default now(),
  unique (id, revision_id)
);

create table app_private.practice_worksheet_template_releases (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null unique
    references app_private.practice_worksheet_template_revisions(id) on delete restrict,
  review_id uuid not null,
  released_by uuid not null
    references app_private.practice_worksheet_bank_reviewers(user_id) on delete restrict,
  release_notes text not null check (length(btrim(release_notes)) between 8 and 1000),
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  released_at timestamptz not null default now(),
  unique (id, revision_id),
  foreign key (review_id, revision_id)
    references app_private.practice_worksheet_template_reviews(id, revision_id)
    on delete restrict
);

create index practice_worksheet_templates_topic_level_idx
on app_private.practice_worksheet_templates (grammar_topic_id, level, id);

create index practice_worksheet_revisions_released_idx
on app_private.practice_worksheet_template_revisions (
  template_id,
  state,
  created_at desc,
  id
)
where state = 'released';

create index practice_worksheet_questions_revision_idx
on app_private.practice_worksheet_template_questions (revision_id, question_number);

create index practice_worksheet_releases_released_idx
on app_private.practice_worksheet_template_releases (released_at desc, revision_id);

alter table app_private.practice_worksheet_bank_reviewers enable row level security;
alter table app_private.practice_worksheet_templates enable row level security;
alter table app_private.practice_worksheet_template_revisions enable row level security;
alter table app_private.practice_worksheet_template_questions enable row level security;
alter table app_private.practice_worksheet_template_reviews enable row level security;
alter table app_private.practice_worksheet_template_releases enable row level security;

revoke all on table app_private.practice_worksheet_bank_reviewers
from public, anon, authenticated, service_role;
revoke all on table app_private.practice_worksheet_templates
from public, anon, authenticated, service_role;
revoke all on table app_private.practice_worksheet_template_revisions
from public, anon, authenticated, service_role;
revoke all on table app_private.practice_worksheet_template_questions
from public, anon, authenticated, service_role;
revoke all on table app_private.practice_worksheet_template_reviews
from public, anon, authenticated, service_role;
revoke all on table app_private.practice_worksheet_template_releases
from public, anon, authenticated, service_role;

drop trigger if exists practice_worksheet_bank_reviewers_set_updated_at
on app_private.practice_worksheet_bank_reviewers;
create trigger practice_worksheet_bank_reviewers_set_updated_at
before update on app_private.practice_worksheet_bank_reviewers
for each row execute function public.set_updated_at();

create or replace function app_private.reject_worksheet_bank_history_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'worksheet_bank_history_immutable';
end;
$$;

revoke all on function app_private.reject_worksheet_bank_history_mutation()
from public, anon, authenticated, service_role;

create trigger practice_worksheet_templates_immutable
before update or delete on app_private.practice_worksheet_templates
for each row execute function app_private.reject_worksheet_bank_history_mutation();

create trigger practice_worksheet_template_questions_immutable
before update or delete on app_private.practice_worksheet_template_questions
for each row execute function app_private.reject_worksheet_bank_history_mutation();

create trigger practice_worksheet_template_reviews_immutable
before update or delete on app_private.practice_worksheet_template_reviews
for each row execute function app_private.reject_worksheet_bank_history_mutation();

create trigger practice_worksheet_template_releases_immutable
before update or delete on app_private.practice_worksheet_template_releases
for each row execute function app_private.reject_worksheet_bank_history_mutation();

create or replace function app_private.guard_worksheet_template_revision_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'worksheet_bank_revision_immutable';
  end if;

  if new.id is distinct from old.id
    or new.template_id is distinct from old.template_id
    or new.revision_number is distinct from old.revision_number
    or new.difficulty is distinct from old.difficulty
    or new.title is distinct from old.title
    or new.description is distinct from old.description
    or new.mini_lesson is distinct from old.mini_lesson
    or new.source_label is distinct from old.source_label
    or new.tags is distinct from old.tags
    or new.import_payload_sha256 is distinct from old.import_payload_sha256
    or new.content_sha256 is distinct from old.content_sha256
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at
  then
    raise exception using errcode = '55000', message = 'worksheet_bank_revision_immutable';
  end if;

  if new.state is distinct from old.state then
    if current_setting('app.worksheet_bank_state_transition', true) <> 'on'
      or (old.state, new.state) not in (
        ('draft', 'certified'),
        ('draft', 'rejected'),
        ('certified', 'released'),
        ('released', 'superseded')
      )
    then
      raise exception using errcode = '55000', message = 'worksheet_bank_state_transition_invalid';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function app_private.guard_worksheet_template_revision_mutation()
from public, anon, authenticated, service_role;

create trigger practice_worksheet_template_revisions_guard
before update or delete on app_private.practice_worksheet_template_revisions
for each row execute function app_private.guard_worksheet_template_revision_mutation();

create or replace function app_private.guard_worksheet_template_question_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from app_private.practice_worksheet_template_revisions revision
    where revision.id = new.revision_id
      and revision.state = 'draft'
  ) then
    raise exception using errcode = '55000', message = 'worksheet_bank_revision_not_draft';
  end if;
  return new;
end;
$$;

revoke all on function app_private.guard_worksheet_template_question_insert()
from public, anon, authenticated, service_role;

create trigger practice_worksheet_template_questions_00_guard_insert
before insert on app_private.practice_worksheet_template_questions
for each row execute function app_private.guard_worksheet_template_question_insert();

-- Reuse the same answer-contract gate as workspace worksheets. The private
-- bank table intentionally carries the same educational question columns.
create trigger practice_worksheet_template_questions_01_validate_contract
before insert on app_private.practice_worksheet_template_questions
for each row execute function app_private.validate_practice_question_contract();

create or replace function app_private.practice_worksheet_template_revision_sha256(
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
            'level', template.level,
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
            from app_private.practice_worksheet_template_questions question
            where question.revision_id = revision.id
          ), '[]'::jsonb)
        )::text,
        'UTF8'
      )
    ),
    'hex'
  )
  from app_private.practice_worksheet_template_revisions revision
  join app_private.practice_worksheet_templates template
    on template.id = revision.template_id
  join public.grammar_topics topic on topic.id = template.grammar_topic_id
  where revision.id = target_revision_id;
$$;

revoke all on function app_private.practice_worksheet_template_revision_sha256(uuid)
from public, anon, authenticated, service_role;

create or replace function app_private.practice_worksheet_template_payload_sha256(
  target_grammar_topic_id uuid,
  worksheet jsonb
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
            'level', worksheet ->> 'level',
            'grammar_topic', pg_catalog.jsonb_build_object(
              'slug', topic.slug,
              'name', topic.name
            ),
            'difficulty', worksheet ->> 'difficulty',
            'title', btrim(worksheet ->> 'title'),
            'description', coalesce(
              nullif(btrim(worksheet ->> 'description'), ''),
              btrim(worksheet #>> '{mini_lesson,short_explanation}')
            ),
            'mini_lesson', worksheet -> 'mini_lesson'
          ),
          'questions', coalesce((
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'question_number', (question.item ->> 'question_number')::integer,
                'question_type', question.item ->> 'question_type',
                'evaluation_mode', question.item ->> 'evaluation_mode',
                'prompt', btrim(question.item ->> 'prompt'),
                'options', case
                  when jsonb_typeof(question.item -> 'options') = 'array'
                    and jsonb_array_length(question.item -> 'options') > 0
                    then question.item -> 'options'
                  else null
                end,
                'correct_answer', btrim(question.item ->> 'correct_answer'),
                'accepted_answers', coalesce(question.item -> 'accepted_answers', '[]'::jsonb),
                'rubric', nullif(question.item -> 'rubric', 'null'::jsonb),
                'answer_contract_version', 1,
                'explanation', btrim(question.item ->> 'explanation')
              ) order by (question.item ->> 'question_number')::integer
            )
            from jsonb_array_elements(worksheet -> 'questions') question(item)
          ), '[]'::jsonb)
        )::text,
        'UTF8'
      )
    ),
    'hex'
  )
  from public.grammar_topics topic
  where topic.id = target_grammar_topic_id;
$$;

revoke all on function app_private.practice_worksheet_template_payload_sha256(uuid, jsonb)
from public, anon, authenticated, service_role;

create or replace function app_private.worksheet_template_payload_is_structurally_valid(
  worksheet jsonb
)
returns boolean
language plpgsql
security invoker
set search_path = ''
immutable
parallel safe
as $$
begin
  return coalesce(
    jsonb_typeof(worksheet) = 'object'
    and worksheet - array[
      'title',
      'description',
      'level',
      'grammar_topic',
      'difficulty',
      'visibility',
      'source',
      'source_label',
      'tags',
      'mini_lesson',
      'questions'
    ]::text[] = '{}'::jsonb
    and worksheet ->> 'level' in ('A1', 'A2', 'B1', 'B2')
    and worksheet ->> 'difficulty' in ('easy', 'medium', 'hard')
    and worksheet ->> 'source' in ('manual_import', 'teacher_created')
    and worksheet ->> 'visibility' in ('workspace', 'private')
    and jsonb_typeof(worksheet -> 'grammar_topic') = 'object'
    and coalesce(
      nullif(btrim(worksheet #>> '{grammar_topic,slug}'), ''),
      nullif(btrim(worksheet #>> '{grammar_topic,name}'), '')
    ) is not null
    and jsonb_typeof(worksheet -> 'tags') = 'array'
    and jsonb_array_length(worksheet -> 'tags') <= 20
    and not exists (
      select 1
      from jsonb_array_elements(worksheet -> 'tags') tag(item)
      where jsonb_typeof(tag.item) <> 'string'
        or length(btrim(tag.item #>> '{}')) not between 1 and 60
    )
    and jsonb_typeof(worksheet -> 'mini_lesson') = 'object'
    and (worksheet -> 'mini_lesson') ?& array[
      'short_explanation',
      'key_rule',
      'correct_examples',
      'common_mistake_warning',
      'what_to_revise'
    ]
    and (worksheet -> 'mini_lesson') - array[
      'short_explanation',
      'key_rule',
      'correct_examples',
      'common_mistake_warning',
      'what_to_revise'
    ]::text[] = '{}'::jsonb
    and length(btrim(worksheet #>> '{mini_lesson,short_explanation}')) between 1 and 500
    and length(btrim(worksheet #>> '{mini_lesson,key_rule}')) between 1 and 400
    and length(btrim(worksheet #>> '{mini_lesson,common_mistake_warning}')) between 0 and 300
    and length(btrim(worksheet #>> '{mini_lesson,what_to_revise}')) between 0 and 300
    and jsonb_typeof(worksheet #> '{mini_lesson,correct_examples}') = 'array'
    and jsonb_array_length(worksheet #> '{mini_lesson,correct_examples}') between 1 and 2
    and not exists (
      select 1
      from jsonb_array_elements(worksheet #> '{mini_lesson,correct_examples}') example(item)
      where jsonb_typeof(example.item) <> 'string'
        or length(btrim(example.item #>> '{}')) not between 1 and 180
    )
    and jsonb_typeof(worksheet -> 'questions') = 'array'
    and jsonb_array_length(worksheet -> 'questions') between 2 and 20
    and not exists (
      select 1
      from jsonb_array_elements(worksheet -> 'questions') with ordinality question(item, ordinal)
      where jsonb_typeof(question.item) <> 'object'
        or not (question.item ?& array[
          'question_number',
          'question_type',
          'prompt',
          'options',
          'correct_answer',
          'accepted_answers',
          'rubric',
          'answer_contract_version',
          'explanation',
          'evaluation_mode'
        ])
        or question.item - array[
          'question_number',
          'question_type',
          'prompt',
          'options',
          'correct_answer',
          'accepted_answers',
          'rubric',
          'answer_contract_version',
          'explanation',
          'evaluation_mode'
        ]::text[] <> '{}'::jsonb
        or coalesce(question.item ->> 'question_number', '') !~ '^[1-9][0-9]*$'
        or case
          when coalesce(question.item ->> 'question_number', '') ~ '^[1-9][0-9]*$'
            then (question.item ->> 'question_number')::integer
          else null
        end <> question.ordinal
        or question.item ->> 'question_type' not in (
          'multiple_choice',
          'fill_blank',
          'sentence_correction',
          'word_order',
          'transformation',
          'rewrite_sentence',
          'mini_writing'
        )
        or question.item ->> 'evaluation_mode' not in ('local_exact', 'open_evaluation')
        or jsonb_typeof(question.item -> 'prompt') <> 'string'
        or length(btrim(question.item ->> 'prompt')) not between 12 and 800
        or jsonb_typeof(question.item -> 'options') <> 'array'
        or jsonb_typeof(question.item -> 'correct_answer') <> 'string'
        or length(btrim(question.item ->> 'correct_answer')) not between 1 and 500
        or jsonb_typeof(question.item -> 'accepted_answers') <> 'array'
        or jsonb_typeof(question.item -> 'rubric') not in ('object', 'null')
        or question.item ->> 'answer_contract_version' <> '1'
        or jsonb_typeof(question.item -> 'explanation') <> 'string'
        or length(btrim(question.item ->> 'explanation')) not between 1 and 600
    )
    and (
      select count(*) = count(distinct lower(regexp_replace(
        btrim(question.item ->> 'prompt'),
        '\s+',
        ' ',
        'g'
      )))
      from jsonb_array_elements(worksheet -> 'questions') question(item)
    )
    and (
      select count(*) filter (
        where question.item ->> 'evaluation_mode' = 'open_evaluation'
      ) <= 3
      from jsonb_array_elements(worksheet -> 'questions') question(item)
    ),
    false
  );
exception
  -- Provider/import payloads are untrusted. A malformed JSON shape or an
  -- overflowing numeric question number must fail closed as an invalid
  -- worksheet, never escape as a processor-breaking database error.
  when invalid_parameter_value or data_exception or numeric_value_out_of_range
    then return false;
end;
$$;

revoke all on function app_private.worksheet_template_payload_is_structurally_valid(jsonb)
from public, anon, authenticated, service_role;

create or replace function app_private.guard_worksheet_template_attestation_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actual_content_hash text;
begin
  if current_setting('app.worksheet_bank_attestation_insert', true) <> 'on' then
    raise exception using
      errcode = '55000',
      message = 'worksheet_bank_attestation_publisher_required';
  end if;

  actual_content_hash := app_private.practice_worksheet_template_revision_sha256(
    new.revision_id
  );

  if tg_table_name = 'practice_worksheet_template_reviews' then
    if new.decision <> 'approved'
      or not app_private.worksheet_review_checklist_is_complete(new.checklist)
      or actual_content_hash is null
      or new.content_sha256 is distinct from actual_content_hash
      or not exists (
        select 1
        from app_private.practice_worksheet_template_revisions revision
        where revision.id = new.revision_id
          and revision.state = 'draft'
          and revision.content_sha256 = actual_content_hash
      )
      or not exists (
        select 1
        from app_private.practice_worksheet_bank_reviewers reviewer
        where reviewer.user_id = new.reviewer_id
          and reviewer.active
          and reviewer.can_certify
          and reviewer.verified_at <= now()
          and (reviewer.expires_at is null or reviewer.expires_at > now())
      )
    then
      raise exception using
        errcode = '55000',
        message = 'worksheet_bank_review_attestation_invalid';
    end if;
  elsif tg_table_name = 'practice_worksheet_template_releases' then
    if actual_content_hash is null
      or new.content_sha256 is distinct from actual_content_hash
      or not exists (
        select 1
        from app_private.practice_worksheet_template_revisions revision
        where revision.id = new.revision_id
          and revision.state = 'certified'
          and revision.content_sha256 = actual_content_hash
      )
      or not exists (
        select 1
        from app_private.practice_worksheet_template_reviews review
        where review.id = new.review_id
          and review.revision_id = new.revision_id
          and review.decision = 'approved'
          and review.content_sha256 = actual_content_hash
      )
      or not exists (
        select 1
        from app_private.practice_worksheet_bank_reviewers releaser
        where releaser.user_id = new.released_by
          and releaser.active
          and releaser.can_release
          and releaser.verified_at <= now()
          and (releaser.expires_at is null or releaser.expires_at > now())
      )
    then
      raise exception using
        errcode = '55000',
        message = 'worksheet_bank_release_attestation_invalid';
    end if;
  else
    raise exception using
      errcode = '55000',
      message = 'worksheet_bank_attestation_table_invalid';
  end if;

  return new;
end;
$$;

revoke all on function app_private.guard_worksheet_template_attestation_insert()
from public, anon, authenticated, service_role;

create trigger practice_worksheet_template_reviews_00_guard_insert
before insert on app_private.practice_worksheet_template_reviews
for each row execute function app_private.guard_worksheet_template_attestation_insert();

create trigger practice_worksheet_template_releases_00_guard_insert
before insert on app_private.practice_worksheet_template_releases
for each row execute function app_private.guard_worksheet_template_attestation_insert();

create or replace function app_private.publish_certified_worksheet_template(
  target_template_key text,
  worksheet jsonb,
  target_reviewer_id uuid,
  target_releaser_id uuid,
  review_checklist jsonb,
  review_notes text,
  release_notes text
)
returns table (
  template_id uuid,
  revision_id uuid,
  review_id uuid,
  release_id uuid,
  content_sha256 text,
  created boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_topic_id uuid;
  selected_template app_private.practice_worksheet_templates%rowtype;
  selected_revision app_private.practice_worksheet_template_revisions%rowtype;
  selected_review app_private.practice_worksheet_template_reviews%rowtype;
  selected_release app_private.practice_worksheet_template_releases%rowtype;
  requested_slug text := nullif(worksheet #>> '{grammar_topic,slug}', '');
  requested_name text := nullif(worksheet #>> '{grammar_topic,name}', '');
  import_hash text;
  expected_content_hash text;
  actual_content_hash text;
  next_revision integer;
  question_count integer;
  open_question_count integer;
begin
  if target_template_key is null
    or target_template_key !~ '^[a-z0-9][a-z0-9._-]{5,119}$'
    or worksheet is null
    or jsonb_typeof(worksheet) <> 'object'
    or coalesce(worksheet ->> 'level', '') not in ('A1', 'A2', 'B1', 'B2')
    or coalesce(worksheet ->> 'difficulty', '') not in ('easy', 'medium', 'hard')
    or length(btrim(coalesce(worksheet ->> 'title', ''))) not between 1 and 120
    or jsonb_typeof(worksheet -> 'mini_lesson') <> 'object'
    or jsonb_typeof(worksheet -> 'questions') <> 'array'
    or not app_private.worksheet_review_checklist_is_complete(review_checklist)
    or length(btrim(coalesce(review_notes, ''))) not between 8 and 1000
    or length(btrim(coalesce(release_notes, ''))) not between 8 and 1000
  then
    raise exception using errcode = '22023', message = 'worksheet_bank_publish_invalid';
  end if;

  if not app_private.worksheet_template_payload_is_structurally_valid(worksheet) then
    raise exception using errcode = '22023', message = 'worksheet_bank_payload_invalid';
  end if;

  question_count := jsonb_array_length(worksheet -> 'questions');
  select count(*) filter (
    where question.item ->> 'evaluation_mode' = 'open_evaluation'
  )::integer
  into open_question_count
  from jsonb_array_elements(worksheet -> 'questions') question(item);

  if question_count not between 2 and 20 or open_question_count > 3 then
    raise exception using errcode = '22023', message = 'worksheet_bank_question_count_invalid';
  end if;

  perform 1
  from app_private.practice_worksheet_bank_reviewers reviewer
  where reviewer.user_id = target_reviewer_id
    and reviewer.active
    and reviewer.can_certify
    and reviewer.verified_at <= now()
    and (reviewer.expires_at is null or reviewer.expires_at > now())
  for share;
  if not found then
    raise exception using errcode = '42501', message = 'worksheet_bank_reviewer_not_qualified';
  end if;

  perform 1
  from app_private.practice_worksheet_bank_reviewers releaser
  where releaser.user_id = target_releaser_id
    and releaser.active
    and releaser.can_release
    and releaser.verified_at <= now()
    and (releaser.expires_at is null or releaser.expires_at > now())
  for share;
  if not found then
    raise exception using errcode = '42501', message = 'worksheet_bank_releaser_not_qualified';
  end if;

  select topic.id
  into selected_topic_id
  from public.grammar_topics topic
  where (requested_slug is null or lower(topic.slug) = lower(requested_slug))
    and (requested_name is null or lower(topic.name) = lower(requested_name))
    and topic.level in (worksheet ->> 'level', 'A1_A2')
  order by
    case when topic.level = worksheet ->> 'level' then 0 else 1 end,
    topic.created_at,
    topic.id
  limit 1;

  if selected_topic_id is null then
    raise exception using errcode = 'P0002', message = 'worksheet_bank_topic_not_found';
  end if;

  expected_content_hash := app_private.practice_worksheet_template_payload_sha256(
    selected_topic_id,
    worksheet
  );
  import_hash := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(worksheet::text, 'UTF8')),
    'hex'
  );

  if expected_content_hash is null then
    raise exception using errcode = '55000', message = 'worksheet_bank_hash_failed';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    concat('worksheet-bank:', target_template_key, ':', expected_content_hash),
    0
  ));

  select template.*
  into selected_template
  from app_private.practice_worksheet_templates template
  where template.template_key = target_template_key
  for update;

  if selected_template.id is null then
    insert into app_private.practice_worksheet_templates (
      template_key,
      grammar_topic_id,
      level,
      created_by
    ) values (
      target_template_key,
      selected_topic_id,
      worksheet ->> 'level',
      target_reviewer_id
    )
    returning * into selected_template;
  elsif selected_template.grammar_topic_id <> selected_topic_id
    or selected_template.level <> worksheet ->> 'level'
  then
    raise exception using errcode = '55000', message = 'worksheet_bank_template_context_changed';
  end if;

  select revision.*
  into selected_revision
  from app_private.practice_worksheet_template_revisions revision
  where revision.template_id = selected_template.id
    and revision.content_sha256 = expected_content_hash
  limit 1;

  if selected_revision.id is not null then
    select review.* into selected_review
    from app_private.practice_worksheet_template_reviews review
    where review.revision_id = selected_revision.id
      and review.decision = 'approved';

    select release.* into selected_release
    from app_private.practice_worksheet_template_releases release
    where release.revision_id = selected_revision.id
      and release.review_id = selected_review.id;

    actual_content_hash := app_private.practice_worksheet_template_revision_sha256(
      selected_revision.id
    );
    if selected_revision.state <> 'released'
      or selected_review.id is null
      or selected_release.id is null
      or actual_content_hash is distinct from selected_revision.content_sha256
      or selected_review.content_sha256 is distinct from selected_revision.content_sha256
      or selected_release.content_sha256 is distinct from selected_revision.content_sha256
      or not exists (
        select 1
        from app_private.practice_worksheet_bank_reviewers reviewer
        where reviewer.user_id = selected_review.reviewer_id
          and reviewer.active
          and reviewer.can_certify
          and reviewer.verified_at <= selected_review.reviewed_at
          and (
            reviewer.expires_at is null
            or reviewer.expires_at > selected_review.reviewed_at
          )
      )
      or not exists (
        select 1
        from app_private.practice_worksheet_bank_reviewers releaser
        where releaser.user_id = selected_release.released_by
          and releaser.active
          and releaser.can_release
          and releaser.verified_at <= selected_release.released_at
          and (
            releaser.expires_at is null
            or releaser.expires_at > selected_release.released_at
          )
      )
    then
      raise exception using errcode = '55000', message = 'worksheet_bank_existing_revision_invalid';
    end if;

    return query select
      selected_template.id,
      selected_revision.id,
      selected_review.id,
      selected_release.id,
      selected_revision.content_sha256,
      false;
    return;
  end if;

  select coalesce(max(revision.revision_number), 0) + 1
  into next_revision
  from app_private.practice_worksheet_template_revisions revision
  where revision.template_id = selected_template.id;

  insert into app_private.practice_worksheet_template_revisions (
    template_id,
    revision_number,
    difficulty,
    title,
    description,
    mini_lesson,
    source_label,
    tags,
    import_payload_sha256,
    content_sha256,
    created_by
  ) values (
    selected_template.id,
    next_revision,
    worksheet ->> 'difficulty',
    btrim(worksheet ->> 'title'),
    coalesce(
      nullif(btrim(worksheet ->> 'description'), ''),
      btrim(worksheet #>> '{mini_lesson,short_explanation}')
    ),
    worksheet -> 'mini_lesson',
    nullif(btrim(worksheet ->> 'source_label'), ''),
    coalesce(worksheet -> 'tags', '[]'::jsonb),
    import_hash,
    expected_content_hash,
    target_reviewer_id
  )
  returning * into selected_revision;

  insert into app_private.practice_worksheet_template_questions (
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
    selected_revision.id,
    (question.item ->> 'question_number')::integer,
    question.item ->> 'question_type',
    question.item ->> 'evaluation_mode',
    btrim(question.item ->> 'prompt'),
    case
      when jsonb_typeof(question.item -> 'options') = 'array'
        and jsonb_array_length(question.item -> 'options') > 0
        then question.item -> 'options'
      else null
    end,
    btrim(question.item ->> 'correct_answer'),
    coalesce(question.item -> 'accepted_answers', '[]'::jsonb),
    nullif(question.item -> 'rubric', 'null'::jsonb),
    1,
    btrim(question.item ->> 'explanation')
  from jsonb_array_elements(worksheet -> 'questions') question(item)
  order by (question.item ->> 'question_number')::integer;

  actual_content_hash := app_private.practice_worksheet_template_revision_sha256(
    selected_revision.id
  );
  if actual_content_hash is distinct from expected_content_hash then
    raise exception using errcode = '55000', message = 'worksheet_bank_persisted_hash_mismatch';
  end if;

  perform set_config('app.worksheet_bank_attestation_insert', 'on', true);
  insert into app_private.practice_worksheet_template_reviews (
    revision_id,
    reviewer_id,
    decision,
    checklist,
    notes,
    content_sha256
  ) values (
    selected_revision.id,
    target_reviewer_id,
    'approved',
    review_checklist,
    btrim(review_notes),
    actual_content_hash
  ) returning * into selected_review;

  perform set_config('app.worksheet_bank_state_transition', 'on', true);
  update app_private.practice_worksheet_template_revisions revision
  set state = 'certified'
  where revision.id = selected_revision.id;

  insert into app_private.practice_worksheet_template_releases (
    revision_id,
    review_id,
    released_by,
    release_notes,
    content_sha256
  ) values (
    selected_revision.id,
    selected_review.id,
    target_releaser_id,
    btrim(release_notes),
    actual_content_hash
  ) returning * into selected_release;

  update app_private.practice_worksheet_template_revisions revision
  set state = 'released'
  where revision.id = selected_revision.id;
  perform set_config('app.worksheet_bank_state_transition', 'off', true);
  perform set_config('app.worksheet_bank_attestation_insert', 'off', true);

  return query select
    selected_template.id,
    selected_revision.id,
    selected_review.id,
    selected_release.id,
    actual_content_hash,
    true;
end;
$$;

revoke all on function app_private.publish_certified_worksheet_template(
  text, jsonb, uuid, uuid, jsonb, text, text
)
from public, anon, authenticated, service_role;

comment on function app_private.publish_certified_worksheet_template(
  text, jsonb, uuid, uuid, jsonb, text, text
) is
  'Postgres-only atomic publisher. It requires explicit qualified certifier/releaser registry rows and stores immutable hash-bound review and release attestations.';

-- Public worksheet clones retain explicit links to the canonical immutable
-- revision and release that authorized their use.
alter table public.practice_tests
add column if not exists worksheet_template_revision_id uuid,
add column if not exists worksheet_template_release_id uuid,
add column if not exists approval_source text,
add column if not exists template_content_sha256 text;

alter table public.practice_tests
drop constraint if exists practice_tests_generation_source_check;

alter table public.practice_tests
add constraint practice_tests_generation_source_check
check (generation_source in (
  'manual',
  'manual_import',
  'teacher_created',
  'deepseek',
  'openai',
  'fixture',
  'system_fallback',
  'certified_bank'
)) not valid;

alter table public.practice_tests
validate constraint practice_tests_generation_source_check;

-- Existing staging history can contain attempted worksheets. The established
-- immutable trigger correctly rejects ordinary updates to those revisions, so
-- pause only that trigger while this migration adds non-educational provenance.
-- ALTER TABLE holds an exclusive table lock until commit; no concurrent writer
-- can exploit the maintenance window, and any failure rolls the disable back.
alter table public.practice_tests
disable trigger practice_tests_prevent_used_mutation;
update public.practice_tests test
set approval_source = case
  when test.quality_status = 'approved' and test.teacher_reviewed
    then 'workspace_human_review'
  when test.quality_status = 'approved'
    and test.created_by_ai
    and not test.teacher_reviewed
    and test.generation_source in ('deepseek', 'openai')
    then 'independent_model_validation'
  else null
end
where test.approval_source is null;
alter table public.practice_tests
enable trigger practice_tests_prevent_used_mutation;

create or replace function app_private.populate_practice_test_approval_source()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.worksheet_template_revision_id is not null then
    if new.generation_source <> 'certified_bank'
      or not new.teacher_reviewed
      or new.created_by_ai
      or new.quality_status <> 'approved'
    then
      raise exception using
        errcode = '23514',
        message = 'certified_template_approval_source_invalid';
    end if;
    new.approval_source := 'certified_template_bank';
  elsif new.quality_status = 'approved' and new.teacher_reviewed then
    new.approval_source := 'workspace_human_review';
  elsif new.quality_status = 'approved'
    and new.created_by_ai
    and new.generation_source in ('deepseek', 'openai')
  then
    new.approval_source := 'independent_model_validation';
  else
    new.approval_source := null;
  end if;

  return new;
end;
$$;

revoke all on function app_private.populate_practice_test_approval_source()
from public, anon, authenticated, service_role;

create trigger practice_tests_10_populate_approval_source
before insert or update of
  worksheet_template_revision_id,
  generation_source,
  teacher_reviewed,
  created_by_ai,
  quality_status,
  approval_source
on public.practice_tests
for each row execute function app_private.populate_practice_test_approval_source();

alter table public.practice_tests
add constraint practice_tests_approval_source_check
check (
  approval_source is null
  or approval_source in (
    'workspace_human_review',
    'independent_model_validation',
    'certified_template_bank'
  )
),
add constraint practice_tests_approval_source_truth_check
check (
  approval_source is null
  or (
    approval_source = 'workspace_human_review'
    and teacher_reviewed
    and quality_status = 'approved'
    and worksheet_template_revision_id is null
  )
  or (
    approval_source = 'independent_model_validation'
    and created_by_ai
    and not teacher_reviewed
    and generation_source in ('deepseek', 'openai')
    and quality_status = 'approved'
    and worksheet_template_revision_id is null
  )
  or approval_source = 'certified_template_bank'
),
add constraint practice_tests_template_hash_check
check (
  template_content_sha256 is null
  or template_content_sha256 ~ '^[a-f0-9]{64}$'
),
add constraint practice_tests_template_revision_fk
foreign key (worksheet_template_revision_id)
  references app_private.practice_worksheet_template_revisions(id)
  on delete restrict,
add constraint practice_tests_template_release_fk
foreign key (worksheet_template_release_id, worksheet_template_revision_id)
  references app_private.practice_worksheet_template_releases(id, revision_id)
  on delete restrict,
add constraint practice_tests_template_clone_shape_check
check (
  (
    worksheet_template_revision_id is null
    and worksheet_template_release_id is null
    and template_content_sha256 is null
    and approval_source is distinct from 'certified_template_bank'
  )
  or (
    worksheet_template_revision_id is not null
    and worksheet_template_release_id is not null
    and template_content_sha256 is not null
    and approval_source = 'certified_template_bank'
    and generation_source = 'certified_bank'
    and created_by_ai = false
    and teacher_reviewed = true
    and visibility = 'workspace'
    and quality_status = 'approved'
  )
);

create unique index practice_tests_one_template_clone_per_workspace_idx
on public.practice_tests (workspace_id, worksheet_template_revision_id)
where worksheet_template_revision_id is not null;

create index practice_tests_template_release_idx
on public.practice_tests (worksheet_template_release_id)
where worksheet_template_release_id is not null;

create or replace function app_private.prevent_certified_template_clone_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.worksheet_template_revision_id is null then
      return new;
    end if;
    if current_setting('app.allow_certified_template_clone_insert', true) = 'on' then
      return new;
    end if;
    raise exception using errcode = '55000', message = 'certified_template_clone_publisher_required';
  end if;

  if old.worksheet_template_revision_id is not null
    or (tg_op = 'UPDATE' and new.worksheet_template_revision_id is not null)
  then
    raise exception using errcode = '55000', message = 'certified_template_clone_immutable';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function app_private.prevent_certified_template_clone_mutation()
from public, anon, authenticated, service_role;

create trigger practice_tests_00_prevent_template_clone_mutation
before insert or update or delete on public.practice_tests
for each row execute function app_private.prevent_certified_template_clone_mutation();

create or replace function app_private.prevent_certified_template_question_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_test_id uuid := case when tg_op = 'DELETE' then old.practice_test_id else new.practice_test_id end;
begin
  if exists (
    select 1
    from public.practice_tests test
    where test.id = selected_test_id
      and test.worksheet_template_revision_id is not null
  ) then
    if tg_op = 'INSERT'
      and current_setting('app.allow_certified_template_clone_insert', true) = 'on'
    then
      return new;
    end if;
    raise exception using errcode = '55000', message = 'certified_template_question_immutable';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function app_private.prevent_certified_template_question_mutation()
from public, anon, authenticated, service_role;

create trigger practice_test_questions_00_prevent_template_mutation
before insert or update or delete on public.practice_test_questions
for each row execute function app_private.prevent_certified_template_question_mutation();

create or replace function app_private.clone_released_worksheet_template(
  target_workspace_id uuid,
  target_revision_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_revision app_private.practice_worksheet_template_revisions%rowtype;
  selected_template app_private.practice_worksheet_templates%rowtype;
  selected_review app_private.practice_worksheet_template_reviews%rowtype;
  selected_release app_private.practice_worksheet_template_releases%rowtype;
  existing_test public.practice_tests%rowtype;
  cloned_test_id uuid;
  actual_template_hash text;
  actual_clone_hash text;
begin
  if target_workspace_id is null or target_revision_id is null then
    raise exception using errcode = '22023', message = 'worksheet_bank_clone_context_required';
  end if;
  if not exists (
    select 1 from public.workspaces workspace where workspace.id = target_workspace_id
  ) then
    raise exception using errcode = 'P0002', message = 'workspace_not_found';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    concat('worksheet-bank-clone:', target_workspace_id::text, ':', target_revision_id::text),
    0
  ));

  select revision.* into selected_revision
  from app_private.practice_worksheet_template_revisions revision
  where revision.id = target_revision_id
    and revision.state = 'released'
  for share;

  if selected_revision.id is null then
    raise exception using errcode = 'P0002', message = 'worksheet_bank_release_not_found';
  end if;

  select template.* into selected_template
  from app_private.practice_worksheet_templates template
  where template.id = selected_revision.template_id
  for share;

  select review.* into selected_review
  from app_private.practice_worksheet_template_reviews review
  where review.revision_id = selected_revision.id
    and review.decision = 'approved'
  for share;

  select release.* into selected_release
  from app_private.practice_worksheet_template_releases release
  where release.revision_id = selected_revision.id
    and release.review_id = selected_review.id
  for share;

  actual_template_hash := app_private.practice_worksheet_template_revision_sha256(
    selected_revision.id
  );
  if selected_template.id is null
    or selected_review.id is null
    or selected_release.id is null
    or actual_template_hash is distinct from selected_revision.content_sha256
    or selected_review.content_sha256 is distinct from selected_revision.content_sha256
    or selected_release.content_sha256 is distinct from selected_revision.content_sha256
    or not exists (
      select 1
      from app_private.practice_worksheet_bank_reviewers reviewer
      where reviewer.user_id = selected_review.reviewer_id
        and reviewer.active
        and reviewer.can_certify
        and reviewer.verified_at <= selected_review.reviewed_at
        and (
          reviewer.expires_at is null
          or reviewer.expires_at > selected_review.reviewed_at
        )
    )
    or not exists (
      select 1
      from app_private.practice_worksheet_bank_reviewers releaser
      where releaser.user_id = selected_release.released_by
        and releaser.active
        and releaser.can_release
        and releaser.verified_at <= selected_release.released_at
        and (
          releaser.expires_at is null
          or releaser.expires_at > selected_release.released_at
        )
    )
  then
    raise exception using errcode = '55000', message = 'worksheet_bank_release_hash_mismatch';
  end if;

  select test.* into existing_test
  from public.practice_tests test
  where test.workspace_id = target_workspace_id
    and test.worksheet_template_revision_id = selected_revision.id
  limit 1;

  if existing_test.id is not null then
    actual_clone_hash := app_private.practice_test_content_sha256(existing_test.id);
    if existing_test.worksheet_template_release_id <> selected_release.id
      or existing_test.approval_source <> 'certified_template_bank'
      or existing_test.template_content_sha256 <> selected_revision.content_sha256
      or actual_clone_hash is distinct from selected_revision.content_sha256
    then
      raise exception using errcode = '55000', message = 'worksheet_bank_existing_clone_invalid';
    end if;
    return existing_test.id;
  end if;

  perform set_config('app.allow_certified_template_clone_insert', 'on', true);
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
    reviewed_by,
    reviewed_at,
    generation_metadata,
    worksheet_template_revision_id,
    worksheet_template_release_id,
    approval_source,
    template_content_sha256
  ) values (
    target_workspace_id,
    selected_template.grammar_topic_id,
    selected_template.level,
    selected_revision.difficulty,
    selected_revision.title,
    selected_revision.description,
    false,
    true,
    'workspace',
    selected_revision.created_by,
    selected_revision.mini_lesson,
    'certified_bank',
    'approved',
    concat(
      'certified_template_revision=', selected_revision.id::text,
      '; template_release=', selected_release.id::text,
      '; content_sha256=', selected_revision.content_sha256
    ),
    selected_review.reviewer_id,
    selected_review.reviewed_at,
    jsonb_build_object(
      'schema_version', 1,
      'approval_source', 'certified_template_bank',
      'template_revision_id', selected_revision.id,
      'template_release_id', selected_release.id,
      'content_sha256', selected_revision.content_sha256
    ),
    selected_revision.id,
    selected_release.id,
    'certified_template_bank',
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
  from app_private.practice_worksheet_template_questions question
  where question.revision_id = selected_revision.id
  order by question.question_number;
  perform set_config('app.allow_certified_template_clone_insert', 'off', true);

  actual_clone_hash := app_private.practice_test_content_sha256(cloned_test_id);
  if actual_clone_hash is distinct from selected_revision.content_sha256 then
    raise exception using errcode = '55000', message = 'worksheet_bank_clone_hash_mismatch';
  end if;

  return cloned_test_id;
end;
$$;

revoke all on function app_private.clone_released_worksheet_template(uuid, uuid)
from public, anon, authenticated, service_role;

create or replace function public.clone_released_worksheet_template_internal(
  target_workspace_id uuid,
  target_revision_id uuid
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select app_private.clone_released_worksheet_template(
    target_workspace_id,
    target_revision_id
  );
$$;

revoke all on function public.clone_released_worksheet_template_internal(uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.clone_released_worksheet_template_internal(uuid, uuid)
to service_role;

create or replace function public.select_released_worksheet_template_internal(
  target_workspace_id uuid,
  target_student_id uuid,
  target_grammar_topic_id uuid,
  target_level text
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select revision.id
  from app_private.practice_worksheet_template_revisions revision
  join app_private.practice_worksheet_templates template
    on template.id = revision.template_id
  join app_private.practice_worksheet_template_reviews review
    on review.revision_id = revision.id
   and review.decision = 'approved'
   and review.content_sha256 = revision.content_sha256
  join app_private.practice_worksheet_template_releases release
    on release.revision_id = revision.id
   and release.review_id = review.id
   and release.content_sha256 = revision.content_sha256
  join app_private.practice_worksheet_bank_reviewers reviewer
    on reviewer.user_id = review.reviewer_id
   and reviewer.active
   and reviewer.can_certify
   and reviewer.verified_at <= review.reviewed_at
   and (reviewer.expires_at is null or reviewer.expires_at > review.reviewed_at)
  join app_private.practice_worksheet_bank_reviewers releaser
    on releaser.user_id = release.released_by
   and releaser.active
   and releaser.can_release
   and releaser.verified_at <= release.released_at
   and (releaser.expires_at is null or releaser.expires_at > release.released_at)
  where target_workspace_id is not null
    and target_student_id is not null
    and target_grammar_topic_id is not null
    and target_level in ('A1', 'A2', 'B1', 'B2')
    and revision.state = 'released'
    and template.grammar_topic_id = target_grammar_topic_id
    and template.level = target_level
    and exists (
      select 1
      from public.workspace_members membership
      where membership.workspace_id = target_workspace_id
        and membership.user_id = target_student_id
        and membership.role = 'student'
    )
    and not exists (
      select 1
      from public.student_practice_assignments prior_assignment
      join public.practice_tests prior_test
        on prior_test.id = prior_assignment.practice_test_id
      where prior_assignment.workspace_id = target_workspace_id
        and prior_assignment.student_id = target_student_id
        and prior_test.worksheet_template_revision_id = revision.id
    )
  order by
    case revision.difficulty when 'easy' then 1 when 'medium' then 2 else 3 end,
    release.released_at,
    revision.id
  limit 1;
$$;

revoke all on function public.select_released_worksheet_template_internal(
  uuid, uuid, uuid, text
)
from public, anon, authenticated, service_role;
grant execute on function public.select_released_worksheet_template_internal(
  uuid, uuid, uuid, text
)
to service_role;

comment on function public.select_released_worksheet_template_internal(
  uuid, uuid, uuid, text
) is
  'Service-only selector for one unseen released canonical revision in exact workspace, student, topic, and CEFR context. Clone-time hash verification remains mandatory.';

-- Phase 12G froze the level context and excluded all prior student use. Keep
-- those predicates intact while requiring a truthful approval source for every
-- ordinary reusable worksheet selected after this migration.
create or replace function app_private.select_practice_test_for_cycle(
  target_workspace_id uuid,
  target_student_id uuid,
  target_grammar_topic_id uuid
)
returns uuid
language sql
security definer
set search_path = ''
stable
as $$
  with selected_context as (
    select cycle.worksheet_level
    from app_private.practice_resolution_cycles cycle
    where cycle.workspace_id = target_workspace_id
      and cycle.student_id = target_student_id
      and cycle.grammar_topic_id = target_grammar_topic_id
      and cycle.resolved_at is null
      and cycle.class_context_version = 1
    order by cycle.cycle_number desc
    limit 1
  )
  select worksheet.id
  from public.practice_tests worksheet
  cross join selected_context context
  where worksheet.workspace_id = target_workspace_id
    and worksheet.grammar_topic_id = target_grammar_topic_id
    and worksheet.level = context.worksheet_level
    and worksheet.visibility = 'workspace'
    and worksheet.teacher_reviewed = true
    and worksheet.quality_status = 'approved'
    and worksheet.approval_source in (
      'workspace_human_review',
      'certified_template_bank'
    )
    and worksheet.difficulty in ('easy', 'medium')
    and exists (
      select 1
      from public.practice_test_questions question
      where question.practice_test_id = worksheet.id
    )
    and not exists (
      select 1
      from public.practice_test_questions question
      where question.practice_test_id = worksheet.id
        and question.answer_contract_version <> 1
    )
    and not exists (
      select 1
      from public.student_practice_assignments prior_assignment
      where prior_assignment.workspace_id = target_workspace_id
        and prior_assignment.student_id = target_student_id
        and prior_assignment.practice_test_id = worksheet.id
    )
  order by
    case worksheet.difficulty when 'easy' then 1 else 2 end,
    worksheet.created_at desc,
    worksheet.id
  limit 1;
$$;

revoke all on function app_private.select_practice_test_for_cycle(uuid, uuid, uuid)
from public, anon, authenticated, service_role;

-- Extend the stable Phase 12G service snapshot with one canonical revision ID.
-- No current class-level inference is reintroduced: the bank selector consumes
-- only the immutable assignment.worksheet_level snapshot.
drop function if exists api.get_worksheet_generation_context(uuid);
create function api.get_worksheet_generation_context(
  target_assignment_id uuid
)
returns table (
  assignment_id uuid,
  workspace_id uuid,
  grammar_topic_id uuid,
  attached_practice_test_id uuid,
  assignment_status text,
  batch_id uuid,
  batch_name text,
  worksheet_level text,
  topic_name text,
  topic_slug text,
  topic_level text,
  topic_description text,
  reusable_practice_test_id uuid,
  certified_template_revision_id uuid
)
language plpgsql
security invoker
set search_path = ''
stable
as $$
begin
  if current_user <> 'service_role' then
    raise exception using errcode = '42501', message = 'Permission denied.';
  end if;

  return query
  with assignment_context as (
    select
      assignment.id,
      assignment.workspace_id,
      assignment.student_id,
      assignment.grammar_topic_id,
      assignment.practice_test_id,
      assignment.status,
      assignment.batch_id,
      batch.name as batch_name,
      assignment.worksheet_level,
      assignment.class_context_version,
      topic.name,
      topic.slug,
      topic.level,
      topic.description
    from public.student_practice_assignments assignment
    join public.grammar_topics topic on topic.id = assignment.grammar_topic_id
    left join public.batches batch
      on batch.id = assignment.batch_id
     and batch.workspace_id = assignment.workspace_id
    where assignment.id = target_assignment_id
  )
  select
    context.id,
    context.workspace_id,
    context.grammar_topic_id,
    context.practice_test_id,
    context.status,
    context.batch_id,
    context.batch_name,
    context.worksheet_level,
    context.name,
    context.slug,
    context.level,
    context.description,
    reusable.id,
    certified.id
  from assignment_context context
  left join lateral (
    select worksheet.id
    from public.practice_tests worksheet
    where context.class_context_version = 1
      and worksheet.workspace_id = context.workspace_id
      and worksheet.grammar_topic_id = context.grammar_topic_id
      and worksheet.level = context.worksheet_level
      and worksheet.visibility = 'workspace'
      and worksheet.quality_status = 'approved'
      and worksheet.approval_source in (
        'workspace_human_review',
        'independent_model_validation',
        'certified_template_bank'
      )
      and worksheet.generation_source <> 'system_fallback'
      and (context.practice_test_id is null or worksheet.id = context.practice_test_id)
      and exists (
        select 1
        from public.practice_test_questions contract_question
        where contract_question.practice_test_id = worksheet.id
          and contract_question.answer_contract_version = 1
      )
      and not exists (
        select 1
        from public.practice_test_questions contract_question
        where contract_question.practice_test_id = worksheet.id
          and contract_question.answer_contract_version <> 1
      )
      and not exists (
        select 1
        from public.student_practice_assignments prior
        where prior.workspace_id = context.workspace_id
          and prior.student_id = context.student_id
          and prior.practice_test_id = worksheet.id
          and prior.id <> context.id
      )
    order by worksheet.created_at desc, worksheet.id
    limit 1
  ) reusable on true
  left join lateral (
    select public.select_released_worksheet_template_internal(
      context.workspace_id,
      context.student_id,
      context.grammar_topic_id,
      context.worksheet_level
    ) as id
    where context.class_context_version = 1
      and context.practice_test_id is null
      and context.worksheet_level in ('A1', 'A2', 'B1', 'B2')
  ) certified on true;
end;
$$;

revoke all on function api.get_worksheet_generation_context(uuid)
from public, anon, authenticated, service_role;
grant execute on function api.get_worksheet_generation_context(uuid)
to service_role;

comment on function api.get_worksheet_generation_context(uuid) is
  'Service-only generation snapshot using immutable class context. It returns an unseen released canonical bank revision without exposing bank content.';

-- Provider candidates rejected before assignment are retained privately for
-- teacher/operations diagnosis. They never become certified bank revisions.
create table app_private.worksheet_bank_fallback_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references app_private.async_jobs(id) on delete restrict,
  assignment_id uuid not null unique
    references public.student_practice_assignments(id) on delete restrict,
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  template_revision_id uuid not null
    references app_private.practice_worksheet_template_revisions(id) on delete restrict,
  cloned_practice_test_id uuid not null
    references public.practice_tests(id) on delete restrict,
  fallback_reason text not null check (fallback_reason in (
    'approved_bank_preferred',
    'provider_unavailable',
    'provider_exhausted',
    'candidates_rejected'
  )),
  rejection_count smallint not null default 0 check (rejection_count between 0 and 2),
  completion_payload_sha256 text not null
    check (completion_payload_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now()
);

create table app_private.worksheet_generation_rejections (
  id uuid primary key default gen_random_uuid(),
  fallback_event_id uuid not null
    references app_private.worksheet_bank_fallback_events(id) on delete restrict,
  attempt_number smallint not null check (attempt_number between 1 and 2),
  provider text not null check (provider in ('deepseek', 'openai')),
  model text not null check (model ~ '^[a-zA-Z0-9._:/-]{1,100}$'),
  rejection_reasons jsonb not null check (
    jsonb_typeof(rejection_reasons) = 'array'
    and jsonb_array_length(rejection_reasons) between 1 and 8
  ),
  candidate jsonb not null check (
    jsonb_typeof(candidate) = 'object'
    and octet_length(candidate::text) <= 131072
  ),
  candidate_sha256 text not null check (candidate_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  unique (fallback_event_id, attempt_number)
);

create index worksheet_generation_rejections_created_idx
on app_private.worksheet_generation_rejections (created_at desc, fallback_event_id);

alter table app_private.worksheet_bank_fallback_events enable row level security;
alter table app_private.worksheet_generation_rejections enable row level security;

revoke all on table app_private.worksheet_bank_fallback_events
from public, anon, authenticated, service_role;
revoke all on table app_private.worksheet_generation_rejections
from public, anon, authenticated, service_role;

create or replace function app_private.guard_worksheet_bank_fallback_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_setting('app.worksheet_bank_fallback_insert', true) <> 'on' then
    raise exception using
      errcode = '55000',
      message = 'worksheet_bank_fallback_completion_required';
  end if;

  if tg_table_name = 'worksheet_generation_rejections' then
    new.candidate_sha256 := pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(new.candidate::text, 'UTF8')),
      'hex'
    );
  end if;

  return new;
end;
$$;

revoke all on function app_private.guard_worksheet_bank_fallback_insert()
from public, anon, authenticated, service_role;

create trigger worksheet_bank_fallback_events_00_guard_insert
before insert on app_private.worksheet_bank_fallback_events
for each row execute function app_private.guard_worksheet_bank_fallback_insert();

create trigger worksheet_generation_rejections_00_guard_insert
before insert on app_private.worksheet_generation_rejections
for each row execute function app_private.guard_worksheet_bank_fallback_insert();

create trigger worksheet_bank_fallback_events_immutable
before update or delete on app_private.worksheet_bank_fallback_events
for each row execute function app_private.reject_worksheet_bank_history_mutation();

create trigger worksheet_generation_rejections_immutable
before update or delete on app_private.worksheet_generation_rejections
for each row execute function app_private.reject_worksheet_bank_history_mutation();

create or replace function app_private.complete_certified_worksheet_bank_fallback(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  worksheet jsonb
)
returns table (
  assignment_id uuid,
  practice_test_id uuid,
  generation_status text,
  quality_status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job app_private.async_jobs%rowtype;
  selected_assignment public.student_practice_assignments%rowtype;
  recorded_event app_private.worksheet_bank_fallback_events%rowtype;
  selected_worker_id uuid := worker_id;
  selected_revision_id uuid;
  eligible_revision_id uuid;
  cloned_test_id uuid;
  fallback_reason text;
  rejected_candidates jsonb;
  rejected_candidate jsonb;
  candidate_attempt integer;
  seen_attempts integer[] := array[]::integer[];
  rejection_count integer;
  payload_sha256 text;
begin
  perform app_private.assert_service_role();

  if worksheet is null
    or jsonb_typeof(worksheet) <> 'object'
    or not (worksheet ?& array[
      'schema_version',
      'mode',
      'template_revision_id',
      'fallback_reason',
      'rejected_candidates'
    ])
    or worksheet - array[
      'schema_version',
      'mode',
      'template_revision_id',
      'fallback_reason',
      'rejected_candidates'
    ]::text[] <> '{}'::jsonb
    or worksheet ->> 'schema_version' <> '1'
    or worksheet ->> 'mode' <> 'certified_bank'
    or coalesce(worksheet ->> 'template_revision_id', '')
      !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or coalesce(worksheet ->> 'fallback_reason', '') not in (
      'approved_bank_preferred',
      'provider_unavailable',
      'provider_exhausted',
      'candidates_rejected'
    )
    or jsonb_typeof(worksheet -> 'rejected_candidates') <> 'array'
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_bank_completion_payload_invalid';
  end if;

  if jsonb_array_length(worksheet -> 'rejected_candidates') > 2 then
    raise exception using
      errcode = '22023',
      message = 'worksheet_bank_completion_payload_invalid';
  end if;

  selected_revision_id := (worksheet ->> 'template_revision_id')::uuid;
  fallback_reason := worksheet ->> 'fallback_reason';
  rejected_candidates := worksheet -> 'rejected_candidates';
  rejection_count := jsonb_array_length(rejected_candidates);
  payload_sha256 := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(worksheet::text, 'UTF8')),
    'hex'
  );

  if (fallback_reason = 'approved_bank_preferred' and rejection_count <> 0)
    or (fallback_reason = 'candidates_rejected' and rejection_count = 0)
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_bank_completion_reason_invalid';
  end if;

  for rejected_candidate in
    select candidate.item
    from jsonb_array_elements(rejected_candidates) candidate(item)
  loop
    if jsonb_typeof(rejected_candidate) <> 'object'
      or not (rejected_candidate ?& array[
        'attempt_number',
        'provider',
        'model',
        'rejection_reasons',
        'candidate'
      ])
      or rejected_candidate - array[
        'attempt_number',
        'provider',
        'model',
        'rejection_reasons',
        'candidate'
      ]::text[] <> '{}'::jsonb
      or coalesce(rejected_candidate ->> 'attempt_number', '') !~ '^[12]$'
      or coalesce(rejected_candidate ->> 'provider', '') not in ('deepseek', 'openai')
      or coalesce(rejected_candidate ->> 'model', '') !~ '^[a-zA-Z0-9._:/-]{1,100}$'
      or jsonb_typeof(rejected_candidate -> 'rejection_reasons') <> 'array'
      or jsonb_typeof(rejected_candidate -> 'candidate') <> 'object'
      or octet_length((rejected_candidate -> 'candidate')::text) > 131072
    then
      raise exception using
        errcode = '22023',
        message = 'worksheet_bank_rejected_candidate_invalid';
    end if;

    candidate_attempt := (rejected_candidate ->> 'attempt_number')::integer;
    if candidate_attempt = any(seen_attempts)
      or jsonb_array_length(rejected_candidate -> 'rejection_reasons') not between 1 and 8
      or exists (
        select 1
        from jsonb_array_elements(
          rejected_candidate -> 'rejection_reasons'
        ) reason(item)
        where jsonb_typeof(reason.item) <> 'string'
          or length(btrim(reason.item #>> '{}')) not between 1 and 240
      )
      or rejected_candidate #>> '{candidate,schema_version}' <> '1'
      or rejected_candidate #>> '{candidate,mode}' <> 'generated'
      or rejected_candidate #>> '{candidate,generation_source}'
        <> rejected_candidate ->> 'provider'
      or rejected_candidate #>> '{candidate,generator_model}'
        <> rejected_candidate ->> 'model'
      or rejected_candidate #>> '{candidate,validation,independent_model}' <> 'false'
      or rejected_candidate #> '{candidate,validation,rejection_reasons}'
        is distinct from rejected_candidate -> 'rejection_reasons'
    then
      raise exception using
        errcode = '22023',
        message = 'worksheet_bank_rejected_candidate_invalid';
    end if;

    -- Reuse the pinned provider/model/source-count contract. The candidate is
    -- quarantined rather than assigned, but its provenance must still be real.
    perform 1
    from app_private.normalize_worksheet_generation_provenance(
      rejected_candidate -> 'candidate'
    );
    seen_attempts := array_append(seen_attempts, candidate_attempt);
  end loop;

  if selected_worker_id is null then
    raise exception using errcode = '22023', message = 'Worker id is required.';
  end if;

  select job.*
  into selected_job
  from app_private.async_jobs job
  where job.id = target_job_id
    and job.job_kind = 'worksheet_generation'
  for update;

  if selected_job.id is null then
    raise exception using
      errcode = '02000',
      message = 'Worksheet generation job not found.';
  end if;

  select assignment.*
  into selected_assignment
  from public.student_practice_assignments assignment
  where assignment.id = selected_job.entity_id
  for update;

  if selected_assignment.id is null then
    raise exception using
      errcode = '02000',
      message = 'Practice assignment not found.';
  end if;

  if selected_job.status = 'succeeded' then
    select event.*
    into recorded_event
    from app_private.worksheet_bank_fallback_events event
    where event.job_id = selected_job.id;

    if recorded_event.id is null
      or recorded_event.assignment_id <> selected_assignment.id
      or recorded_event.template_revision_id <> selected_revision_id
      or recorded_event.completion_payload_sha256 <> payload_sha256
      or recorded_event.rejection_count <> rejection_count
      or selected_assignment.practice_test_id
        is distinct from recorded_event.cloned_practice_test_id
    then
      raise exception using
        errcode = '55000',
        message = 'worksheet_bank_completion_replay_mismatch';
    end if;

    return query select
      selected_assignment.id,
      recorded_event.cloned_practice_test_id,
      selected_assignment.generation_status,
      'approved'::text;
    return;
  end if;

  if selected_job.status <> 'processing'
    or selected_job.queue_message_id <> target_queue_message_id
    or selected_job.worker_id <> selected_worker_id
    or selected_job.entity_version <> selected_assignment.generation_version
  then
    raise exception using
      errcode = '55000',
      message = 'Job lease is no longer active.';
  end if;

  if selected_assignment.status not in ('unlocked', 'in_progress')
    or selected_assignment.practice_test_id is not null
    or selected_assignment.class_context_version <> 1
    or selected_assignment.batch_id is null
    or selected_assignment.worksheet_level not in ('A1', 'A2', 'B1', 'B2')
    or not exists (
      select 1
      from public.workspace_members membership
      where membership.workspace_id = selected_assignment.workspace_id
        and membership.user_id = selected_assignment.student_id
        and membership.role = 'student'
    )
  then
    raise exception using
      errcode = '55000',
      message = 'Practice assignment is not active.';
  end if;

  eligible_revision_id := public.select_released_worksheet_template_internal(
    selected_assignment.workspace_id,
    selected_assignment.student_id,
    selected_assignment.grammar_topic_id,
    selected_assignment.worksheet_level
  );
  if eligible_revision_id is distinct from selected_revision_id then
    raise exception using
      errcode = '22023',
      message = 'worksheet_bank_revision_not_eligible';
  end if;

  cloned_test_id := app_private.clone_released_worksheet_template(
    selected_assignment.workspace_id,
    selected_revision_id
  );

  perform set_config('app.worksheet_bank_fallback_insert', 'on', true);
  insert into app_private.worksheet_bank_fallback_events (
    job_id,
    assignment_id,
    workspace_id,
    template_revision_id,
    cloned_practice_test_id,
    fallback_reason,
    rejection_count,
    completion_payload_sha256
  ) values (
    selected_job.id,
    selected_assignment.id,
    selected_assignment.workspace_id,
    selected_revision_id,
    cloned_test_id,
    fallback_reason,
    rejection_count,
    payload_sha256
  ) returning * into recorded_event;

  insert into app_private.worksheet_generation_rejections (
    fallback_event_id,
    attempt_number,
    provider,
    model,
    rejection_reasons,
    candidate,
    candidate_sha256
  )
  select
    recorded_event.id,
    (candidate.item ->> 'attempt_number')::smallint,
    candidate.item ->> 'provider',
    candidate.item ->> 'model',
    candidate.item -> 'rejection_reasons',
    candidate.item -> 'candidate',
    repeat('0', 64)
  from jsonb_array_elements(rejected_candidates) candidate(item);
  perform set_config('app.worksheet_bank_fallback_insert', 'off', true);

  update public.student_practice_assignments assignment
  set
    practice_test_id = cloned_test_id,
    generation_status = 'ready',
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

  return query select
    selected_assignment.id,
    cloned_test_id,
    'ready'::text,
    'approved'::text;
end;
$$;

revoke all on function app_private.complete_certified_worksheet_bank_fallback(
  uuid, bigint, uuid, jsonb
)
from public, anon, authenticated, service_role;
grant execute on function app_private.complete_certified_worksheet_bank_fallback(
  uuid, bigint, uuid, jsonb
)
to service_role;

create or replace function api.complete_worksheet_generation(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  worksheet jsonb
)
returns table (
  assignment_id uuid,
  practice_test_id uuid,
  generation_status text,
  quality_status text
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  normalized record;
  completed_assignment_id uuid;
  completed_practice_test_id uuid;
  completed_generation_status text;
  completed_quality_status text;
  completion_was_succeeded boolean := false;
begin
  if worksheet ->> 'mode' = 'certified_bank' then
    return query
    select result.assignment_id, result.practice_test_id,
      result.generation_status, result.quality_status
    from app_private.complete_certified_worksheet_bank_fallback(
      target_job_id,
      target_queue_message_id,
      worker_id,
      worksheet
    ) result;
    return;
  end if;

  select *
  into strict normalized
  from app_private.normalize_worksheet_generation_provenance(worksheet);

  completion_was_succeeded :=
    app_private.lock_worksheet_generation_completion(target_job_id);

  select
    result.assignment_id,
    result.practice_test_id,
    result.generation_status,
    result.quality_status
  into strict
    completed_assignment_id,
    completed_practice_test_id,
    completed_generation_status,
    completed_quality_status
  from public.complete_worksheet_generation(
    target_job_id,
    target_queue_message_id,
    worker_id,
    normalized.legacy_worksheet
  ) result;

  if normalized.provider_source = 'openai' and not completion_was_succeeded then
    update public.practice_tests test
    set
      generation_source = 'openai',
      generator_model = worksheet ->> 'generator_model',
      generation_metadata = normalized.provider_metadata
    where test.id = completed_practice_test_id
      and test.generation_job_id = target_job_id;

    if not found then
      raise exception using
        errcode = '55000',
        message = 'Generated worksheet provenance could not be persisted.';
    end if;
  end if;

  perform app_private.assert_or_record_worksheet_generation_completion(
    target_job_id,
    completed_practice_test_id,
    worksheet,
    completion_was_succeeded
  );

  return query
  select
    completed_assignment_id,
    completed_practice_test_id,
    completed_generation_status,
    completed_quality_status;
end;
$$;

revoke all on function api.complete_worksheet_generation(uuid, bigint, uuid, jsonb)
from public, anon, authenticated, service_role;
grant execute on function api.complete_worksheet_generation(uuid, bigint, uuid, jsonb)
to service_role;

comment on function app_private.complete_certified_worksheet_bank_fallback(
  uuid, bigint, uuid, jsonb
) is
  'Transactionally verifies and attaches one exact-context certified bank clone, records content-free job provenance plus bounded private rejected candidates, and archives the durable job.';

comment on table app_private.practice_worksheet_bank_reviewers is
  'Empty-by-default server-managed registry of explicitly qualified worksheet certifiers and releasers. Never expose through the Data API.';
comment on table app_private.practice_worksheet_template_revisions is
  'Content-addressed immutable canonical worksheet revisions. Released does not imply any seeded content; explicit review and release attestations are required.';
comment on table app_private.worksheet_generation_rejections is
  'Private bounded quarantine for actual rejected provider candidates retained when a certified bank fallback is attached.';

notify pgrst, 'reload schema';
