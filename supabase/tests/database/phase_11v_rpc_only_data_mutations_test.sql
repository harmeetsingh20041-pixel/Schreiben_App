begin;

select plan(10);

select ok(
  not exists (
    select 1
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relkind in ('r', 'p')
      and (
        has_table_privilege('authenticated', relation.oid, 'INSERT')
        or has_table_privilege('authenticated', relation.oid, 'UPDATE')
        or has_table_privilege('authenticated', relation.oid, 'DELETE')
        or has_table_privilege('authenticated', relation.oid, 'TRUNCATE')
        or has_table_privilege('authenticated', relation.oid, 'REFERENCES')
        or has_table_privilege('authenticated', relation.oid, 'TRIGGER')
        or has_table_privilege('authenticated', relation.oid, 'MAINTAIN')
      )
  ),
  'authenticated has no direct DML or ownership-like privilege on public tables'
);

select ok(
  not exists (
    select 1
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relkind in ('r', 'p')
      and (
        has_table_privilege('anon', relation.oid, 'INSERT')
        or has_table_privilege('anon', relation.oid, 'UPDATE')
        or has_table_privilege('anon', relation.oid, 'DELETE')
        or has_table_privilege('anon', relation.oid, 'TRUNCATE')
        or has_table_privilege('anon', relation.oid, 'REFERENCES')
        or has_table_privilege('anon', relation.oid, 'TRIGGER')
        or has_table_privilege('anon', relation.oid, 'MAINTAIN')
      )
  ),
  'anon has no direct DML or ownership-like privilege on public tables'
);

with protected_relations as materialized (
  select relation.oid
  from pg_class relation
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname in ('public', 'api', 'app_private')
    and relation.relkind in ('r', 'p', 'm', 'f')
), denied_roles(role_name) as (
  values ('anon'::text), ('authenticated'), ('service_role'), ('authenticator')
)
select ok(
  not exists (
    select 1
    from protected_relations relation
    cross join denied_roles denied
    where has_table_privilege(denied.role_name, relation.oid, 'MAINTAIN')
  ),
  'Data API and gateway roles cannot maintain any application relation'
);

select ok(
  not exists (
    select 1
    from pg_default_acl defaults
    cross join lateral aclexplode(defaults.defaclacl) privilege
    left join pg_roles grantee on grantee.oid = privilege.grantee
    where defaults.defaclrole = 'postgres'::regrole
      and defaults.defaclnamespace in (
        'public'::regnamespace,
        'api'::regnamespace,
        'app_private'::regnamespace
      )
      and defaults.defaclobjtype = 'r'
      and privilege.privilege_type = 'MAINTAIN'
      and (
        privilege.grantee = 0
        or grantee.rolname in (
          'anon',
          'authenticated',
          'service_role',
          'authenticator'
        )
      )
  ),
  'migration-owner defaults cannot restore browser maintenance privileges'
);

select ok(
  not has_table_privilege(
    'authenticated',
    'public.student_practice_assignments',
    'INSERT,UPDATE,DELETE'
  )
    and not has_table_privilege(
      'authenticated',
      'public.practice_test_attempts',
      'INSERT,UPDATE,DELETE'
    )
    and not has_table_privilege(
      'authenticated',
      'public.practice_attempt_question_reviews',
      'INSERT,UPDATE,DELETE'
    )
    and not has_table_privilege(
      'authenticated',
      'public.student_grammar_stats',
      'INSERT,UPDATE,DELETE'
    ),
  'practice assignments, attempts, reviews, and weakness results are RPC-only'
);

select ok(
  not has_table_privilege(
    'authenticated',
    'public.submissions',
    'INSERT,UPDATE,DELETE'
  )
    and not has_table_privilege(
      'authenticated',
      'public.submission_lines',
      'INSERT,UPDATE,DELETE'
    )
    and not has_table_privilege(
      'authenticated',
      'public.submission_grammar_topics',
      'INSERT,UPDATE,DELETE'
    ),
  'writing submissions and released feedback children are RPC-only'
);

with public_sequences as materialized (
  select sequence_relation.oid
  from pg_class sequence_relation
  join pg_namespace namespace
    on namespace.oid = sequence_relation.relnamespace
  where namespace.nspname = 'public'
    and sequence_relation.relkind = 'S'
)
select ok(
  not exists (
    select 1
    from public_sequences sequence_relation
    where has_sequence_privilege(
        'authenticated',
        sequence_relation.oid,
        'USAGE,SELECT,UPDATE'
      )
  ),
  'authenticated cannot allocate or inspect public sequences directly'
);

select ok(
  not has_schema_privilege('authenticated', 'app_private', 'USAGE')
    and not has_schema_privilege('anon', 'app_private', 'USAGE'),
  'browser roles have no usage on the private implementation schema'
);

select ok(
  not exists (
    select 1
    from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'app_private'
      and (
        has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
        or has_function_privilege('anon', procedure.oid, 'EXECUTE')
      )
  ),
  'browser roles cannot execute private implementation functions directly'
);

select ok(
  has_function_privilege(
    'authenticated',
    'api.submit_writing(uuid,text,uuid,text)',
    'EXECUTE'
  )
    and has_function_privilege(
      'authenticated',
      'api.save_writing_draft(uuid,uuid,text,uuid,text,integer)',
      'EXECUTE'
    )
    and has_function_privilege(
      'authenticated',
      'api.submit_practice_attempt(uuid,integer)',
      'EXECUTE'
    )
    and has_function_privilege(
      'authenticated',
      'api.request_batch_join(text)',
      'EXECUTE'
    ),
  'reviewed api mutation facades remain available after direct grants are removed'
);

select * from finish();
rollback;
