do $$
declare
  function_sql text;
begin
  select pg_get_functiondef('public.refresh_student_grammar_stats(uuid, uuid)'::regprocedure)
  into function_sql;

  function_sql := replace(
    function_sql,
    'student_grammar_stats_workspace_id_student_id_grammar_topic_id_key',
    'student_grammar_stats_workspace_id_student_id_grammar_topic_key'
  );

  function_sql := replace(
    function_sql,
    'student_grammar_stats_workspace_id_student_id_grammar_topic_id_',
    'student_grammar_stats_workspace_id_student_id_grammar_topic_key'
  );

  execute function_sql;
end;
$$;
