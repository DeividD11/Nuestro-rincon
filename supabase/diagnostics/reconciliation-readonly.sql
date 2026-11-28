-- Diagnóstico de reconciliación. Solo lectura: no crea tablas temporales ni modifica datos.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '3s';

SELECT jsonb_build_object(
  'generatedAt', now(),
  'database', current_database(),
  'serverVersion', current_setting('server_version'),
  'remoteMigrations', coalesce((
    SELECT jsonb_agg(jsonb_build_object('version', version, 'name', name) ORDER BY version)
    FROM supabase_migrations.schema_migrations
  ), '[]'::jsonb),
  'functions', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'name', p.proname,
      'arguments', pg_get_function_identity_arguments(p.oid),
      'owner', pg_get_userbyid(p.proowner),
      'securityDefiner', p.prosecdef,
      'anonExecute', has_function_privilege('anon', p.oid, 'EXECUTE'),
      'authenticatedExecute', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
      'serviceRoleExecute', has_function_privilege('service_role', p.oid, 'EXECUTE'),
      'definitionMd5', md5(pg_get_functiondef(p.oid)),
      'searchPath', coalesce((SELECT string_agg(setting, ', ' ORDER BY ordinality) FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) WITH ORDINALITY AS cfg(setting, ordinality) WHERE setting LIKE 'search_path=%'), '')
    ) ORDER BY p.proname, pg_get_function_identity_arguments(p.oid))
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY (ARRAY[
        'change_app_password',
        'check_app_registration_invite',
        'claim_app_push_delivery',
        'claim_private_media_cleanup_jobs',
        'complete_app_login_attempt',
        'complete_app_registration_invite_attempt',
        'confirm_letter_permanent_deletion',
        'consume_app_api_rate_limit',
        'consume_app_recovery_code',
        'create_app_registration_invite',
        'create_app_session_with_refresh',
        'create_letter_draft',
        'create_letter_reply',
        'delete_app_account',
        'finish_private_media_cleanup_job',
        'get_app_registration_invitation_status',
        'list_user_letters',
        'list_user_letters_cursor',
        'mark_thread_letters_read',
        'move_letter_to_trash',
        'register_app_user_with_invite_idempotent',
        'register_app_user_with_invite_idempotent_bundle',
        'rename_app_profile',
        'restore_letter_from_trash',
        'revoke_app_registration_invite',
        'revoke_other_app_sessions',
        'rotate_app_recovery_code',
        'rotate_app_recovery_codes_bundle',
        'rotate_app_refresh_token',
        'save_letter_draft',
        'send_letter_draft',
        'set_letter_archive_state',
        'set_letter_favorite_state',
        'start_app_auth_attempt',
        'start_app_login_attempt',
        'start_app_registration_invite_attempt',
        'upsert_app_push_subscription'
      ])
  ), '[]'::jsonb),
  'tables', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'schema', n.nspname,
      'name', c.relname,
      'rlsEnabled', c.relrowsecurity,
      'rlsForced', c.relforcerowsecurity,
      'anonSelect', has_table_privilege('anon', c.oid, 'SELECT'),
      'anonInsert', has_table_privilege('anon', c.oid, 'INSERT'),
      'authenticatedSelect', has_table_privilege('authenticated', c.oid, 'SELECT'),
      'authenticatedInsert', has_table_privilege('authenticated', c.oid, 'INSERT'),
      'serviceRoleSelect', has_table_privilege('service_role', c.oid, 'SELECT'),
      'serviceRoleInsert', has_table_privilege('service_role', c.oid, 'INSERT')
    ) ORDER BY c.relname)
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  ), '[]'::jsonb),
  'indexes', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'table', t.relname,
      'name', i.relname,
      'definition', pg_get_indexdef(i.oid)
    ) ORDER BY t.relname, i.relname)
    FROM pg_index x
    JOIN pg_class t ON t.oid = x.indrelid
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = ANY (ARRAY['letters', 'letter_user_state', 'notifications'])
  ), '[]'::jsonb),
  'triggers', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'table', t.relname,
      'name', g.tgname,
      'definition', pg_get_triggerdef(g.oid, true)
    ) ORDER BY t.relname, g.tgname)
    FROM pg_trigger g
    JOIN pg_class t ON t.oid = g.tgrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND NOT g.tgisinternal
      AND t.relname = ANY (ARRAY['app_users', 'letters'])
  ), '[]'::jsonb)
)::text AS reconciliation_json;

COMMIT;
