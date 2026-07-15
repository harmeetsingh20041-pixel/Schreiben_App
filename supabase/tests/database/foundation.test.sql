begin;

select plan(6);

select has_table('public', 'profiles', 'profiles table exists after migration reset');
select has_table('public', 'batches', 'batches table exists after migration reset');
select has_table('public', 'submissions', 'submissions table exists after migration reset');
select has_table(
  'public',
  'student_practice_assignments',
  'student practice assignments table exists after migration reset'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.submissions'::regclass),
  'row-level security is enabled on submissions'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.student_practice_assignments'::regclass),
  'row-level security is enabled on student practice assignments'
);

select * from finish();
rollback;
