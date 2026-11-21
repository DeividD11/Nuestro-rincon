begin;

select plan(7);

select ok(
  to_regprocedure('public.list_user_letters_cursor(uuid,text,text,timestamp with time zone,uuid,integer)') is not null,
  'la función de paginación keyset está instalada'
);

select ok(
  has_function_privilege('service_role', 'public.list_user_letters_cursor(uuid,text,text,timestamp with time zone,uuid,integer)', 'execute'),
  'solo el backend puede invocar la consulta keyset'
);

select ok(
  not has_function_privilege('anon', 'public.list_user_letters_cursor(uuid,text,text,timestamp with time zone,uuid,integer)', 'execute'),
  'anon no puede invocar la consulta keyset'
);

select ok(
  not has_function_privilege('authenticated', 'public.list_user_letters_cursor(uuid,text,text,timestamp with time zone,uuid,integer)', 'execute'),
  'authenticated no puede omitir la sesión propia de la Edge Function'
);

select function_returns(
  'public', 'list_user_letters_cursor',
  ARRAY['uuid','text','text','timestamp with time zone','uuid','integer'],
  'jsonb'
);

select ok(
  position('(e.sort_at, e.id) < (p_cursor_sort_at, p_cursor_id)' in
    pg_get_functiondef('public.list_user_letters_cursor(uuid,text,text,timestamp with time zone,uuid,integer)'::regprocedure)) > 0,
  'el cursor usa la tupla fecha e identificador para evitar saltos con fechas iguales'
);

select ok(
  position('limit p_limit + 1' in
    pg_get_functiondef('public.list_user_letters_cursor(uuid,text,text,timestamp with time zone,uuid,integer)'::regprocedure)) > 0
  and position('select count(*) > p_limit from page_candidates' in
    pg_get_functiondef('public.list_user_letters_cursor(uuid,text,text,timestamp with time zone,uuid,integer)'::regprocedure)) > 0,
  'solo cuenta la página acotada de hasta límite + 1, no el total completo del buzón'
);

select * from finish();
rollback;
