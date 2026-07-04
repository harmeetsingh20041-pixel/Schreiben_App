-- Split broad FOR ALL management policies so they do not create duplicate
-- permissive SELECT policies for the same role/action.

drop policy if exists "batches_manage_teachers" on public.batches;
create policy "batches_insert_teachers"
on public.batches for insert
to authenticated
with check (public.is_platform_admin() or public.has_workspace_role(workspace_id, array['owner', 'teacher']));
create policy "batches_update_teachers"
on public.batches for update
to authenticated
using (public.is_platform_admin() or public.has_workspace_role(workspace_id, array['owner', 'teacher']))
with check (public.is_platform_admin() or public.has_workspace_role(workspace_id, array['owner', 'teacher']));
create policy "batches_delete_teachers"
on public.batches for delete
to authenticated
using (public.is_platform_admin() or public.has_workspace_role(workspace_id, array['owner', 'teacher']));

drop policy if exists "batch_students_manage_teachers" on public.batch_students;
create policy "batch_students_insert_teachers"
on public.batch_students for insert
to authenticated
with check (public.is_platform_admin() or public.has_workspace_role(workspace_id, array['owner', 'teacher']));
create policy "batch_students_update_teachers"
on public.batch_students for update
to authenticated
using (public.is_platform_admin() or public.has_workspace_role(workspace_id, array['owner', 'teacher']))
with check (public.is_platform_admin() or public.has_workspace_role(workspace_id, array['owner', 'teacher']));
create policy "batch_students_delete_teachers"
on public.batch_students for delete
to authenticated
using (public.is_platform_admin() or public.has_workspace_role(workspace_id, array['owner', 'teacher']));

drop policy if exists "questions_manage_teachers" on public.questions;
create policy "questions_insert_teachers"
on public.questions for insert
to authenticated
with check (public.is_platform_admin() or public.has_workspace_role(workspace_id, array['owner', 'teacher']));
create policy "questions_update_teachers"
on public.questions for update
to authenticated
using (public.is_platform_admin() or public.has_workspace_role(workspace_id, array['owner', 'teacher']))
with check (public.is_platform_admin() or public.has_workspace_role(workspace_id, array['owner', 'teacher']));
create policy "questions_delete_teachers"
on public.questions for delete
to authenticated
using (public.is_platform_admin() or public.has_workspace_role(workspace_id, array['owner', 'teacher']));

drop policy if exists "grammar_topics_manage_admin" on public.grammar_topics;
create policy "grammar_topics_insert_admin"
on public.grammar_topics for insert
to authenticated
with check (public.is_platform_admin());
create policy "grammar_topics_update_admin"
on public.grammar_topics for update
to authenticated
using (public.is_platform_admin())
with check (public.is_platform_admin());
create policy "grammar_topics_delete_admin"
on public.grammar_topics for delete
to authenticated
using (public.is_platform_admin());

drop policy if exists "practice_tests_manage_teachers" on public.practice_tests;
create policy "practice_tests_insert_teachers"
on public.practice_tests for insert
to authenticated
with check (public.is_platform_admin() or public.has_workspace_role(workspace_id, array['owner', 'teacher']));
create policy "practice_tests_update_teachers"
on public.practice_tests for update
to authenticated
using (public.is_platform_admin() or public.has_workspace_role(workspace_id, array['owner', 'teacher']))
with check (public.is_platform_admin() or public.has_workspace_role(workspace_id, array['owner', 'teacher']));
create policy "practice_tests_delete_teachers"
on public.practice_tests for delete
to authenticated
using (public.is_platform_admin() or public.has_workspace_role(workspace_id, array['owner', 'teacher']));

drop policy if exists "practice_test_questions_manage_teachers" on public.practice_test_questions;
create policy "practice_test_questions_insert_teachers"
on public.practice_test_questions for insert
to authenticated
with check (
  exists (
    select 1
    from public.practice_tests pt
    where pt.id = practice_test_questions.practice_test_id
      and (public.is_platform_admin() or public.has_workspace_role(pt.workspace_id, array['owner', 'teacher']))
  )
);
create policy "practice_test_questions_update_teachers"
on public.practice_test_questions for update
to authenticated
using (
  exists (
    select 1
    from public.practice_tests pt
    where pt.id = practice_test_questions.practice_test_id
      and (public.is_platform_admin() or public.has_workspace_role(pt.workspace_id, array['owner', 'teacher']))
  )
)
with check (
  exists (
    select 1
    from public.practice_tests pt
    where pt.id = practice_test_questions.practice_test_id
      and (public.is_platform_admin() or public.has_workspace_role(pt.workspace_id, array['owner', 'teacher']))
  )
);
create policy "practice_test_questions_delete_teachers"
on public.practice_test_questions for delete
to authenticated
using (
  exists (
    select 1
    from public.practice_tests pt
    where pt.id = practice_test_questions.practice_test_id
      and (public.is_platform_admin() or public.has_workspace_role(pt.workspace_id, array['owner', 'teacher']))
  )
);

drop policy if exists "teacher_notes_manage_teachers" on public.teacher_notes;
create policy "teacher_notes_insert_teachers"
on public.teacher_notes for insert
to authenticated
with check (
  exists (
    select 1
    from public.submissions s
    where s.id = teacher_notes.submission_id
      and (public.is_platform_admin() or public.has_workspace_role(s.workspace_id, array['owner', 'teacher']))
  )
);
create policy "teacher_notes_update_teachers"
on public.teacher_notes for update
to authenticated
using (
  exists (
    select 1
    from public.submissions s
    where s.id = teacher_notes.submission_id
      and (public.is_platform_admin() or public.has_workspace_role(s.workspace_id, array['owner', 'teacher']))
  )
)
with check (
  exists (
    select 1
    from public.submissions s
    where s.id = teacher_notes.submission_id
      and (public.is_platform_admin() or public.has_workspace_role(s.workspace_id, array['owner', 'teacher']))
  )
);
create policy "teacher_notes_delete_teachers"
on public.teacher_notes for delete
to authenticated
using (
  exists (
    select 1
    from public.submissions s
    where s.id = teacher_notes.submission_id
      and (public.is_platform_admin() or public.has_workspace_role(s.workspace_id, array['owner', 'teacher']))
  )
);
