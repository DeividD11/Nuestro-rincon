begin;
select plan(19);

select ok(has_function_privilege('service_role', 'public.claim_private_media_cleanup_jobs(integer,timestamp with time zone)', 'execute'), 'service_role puede reclamar trabajos de limpieza');
select ok(has_function_privilege('service_role', 'public.finish_private_media_cleanup_job(uuid,boolean,text,timestamp with time zone)', 'execute'), 'service_role puede completar o reintentar trabajos');
select ok(not has_function_privilege('anon', 'public.claim_private_media_cleanup_jobs(integer,timestamp with time zone)', 'execute'), 'anon no puede reclamar trabajos');
select ok(not has_function_privilege('authenticated', 'public.finish_private_media_cleanup_job(uuid,boolean,text,timestamp with time zone)', 'execute'), 'authenticated no puede completar trabajos');
select ok((select relrowsecurity from pg_class where oid='public.private_media_cleanup_jobs'::regclass), 'la cola tiene RLS activado');
select ok(not has_table_privilege('anon', 'public.private_media_cleanup_jobs', 'select'), 'anon no puede consultar rutas privadas');
select ok(not has_table_privilege('authenticated', 'public.private_media_cleanup_jobs', 'insert'), 'authenticated no puede insertar trabajos');
select ok(has_function_privilege('service_role', 'public.enqueue_private_media_cleanup_from_html(text)', 'execute') and has_function_privilege('service_role', 'public.capture_letter_media_cleanup_from_letter()', 'execute') and has_function_privilege('service_role', 'public.capture_letter_media_cleanup_from_version()', 'execute'), 'service_role puede ejecutar los helpers internos de triggers');

insert into public.app_users(id, username, email, display_name, password_hash, status)
values
 ('a1000000-0000-4000-8000-000000000001', 'media-cleanup-test', 'media-cleanup-test@example.invalid', 'Media Cleanup Test', repeat('c', 64), 'active'),
 ('22222222-2222-4222-8222-222222222222', 'media-cleanup-peer', 'media-cleanup-peer@example.invalid', 'Media Cleanup Peer', repeat('d', 64), 'active');
insert into public.letter_threads(id, participant_a_id, participant_b_id, created_by_user_id)
values ('a2000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'a1000000-0000-4000-8000-000000000001');
insert into public.letters(id, thread_id, sender_id, recipient_id, title, body, status)
values (
  'a3000000-0000-4000-8000-000000000003',
  'a2000000-0000-4000-8000-000000000002',
  'a1000000-0000-4000-8000-000000000001',
  '22222222-2222-4222-8222-222222222222',
  'Limpieza de medios',
  '<p><img data-image-path="letters/a3000000-0000-4000-8000-000000000003/a1000000-0000-4000-8000-000000000001/a4000000-0000-4000-8000-000000000004.webp" alt="Imagen"></p>',
  'draft'
);
insert into public.letter_versions(id, letter_id, version_no, created_by_user_id, title_snapshot, body_snapshot)
values (
  'a5000000-0000-4000-8000-000000000005',
  'a3000000-0000-4000-8000-000000000003',
  1,
  'a1000000-0000-4000-8000-000000000001',
  'Limpieza de medios',
  '<p><img data-image-path="letters/a3000000-0000-4000-8000-000000000003/a1000000-0000-4000-8000-000000000001/a4000000-0000-4000-8000-000000000004.webp" alt="Imagen"></p>'
);

set local role service_role;
update public.letters set body = '<p>Sin imagen</p>' where id='a3000000-0000-4000-8000-000000000003';
reset role;
select is((select count(*)::integer from public.private_media_cleanup_jobs where object_path='letters/a3000000-0000-4000-8000-000000000003/a1000000-0000-4000-8000-000000000001/a4000000-0000-4000-8000-000000000004.webp'), 1, 'al quitar la imagen, el trigger encola una sola ruta');
select is((select count(*)::integer from public.claim_private_media_cleanup_jobs(20, clock_timestamp())), 0, 'la ruta no se reclama mientras una versión todavía la referencia');

set local role service_role;
delete from public.letter_versions where id='a5000000-0000-4000-8000-000000000005';
reset role;
create temporary table claimed_media_cleanup on commit drop as
select * from public.claim_private_media_cleanup_jobs(20, clock_timestamp());
select is((select count(*)::integer from claimed_media_cleanup), 1, 'la ruta se reclama al desaparecer la última referencia');
select is((select object_path from claimed_media_cleanup limit 1), 'letters/a3000000-0000-4000-8000-000000000003/a1000000-0000-4000-8000-000000000001/a4000000-0000-4000-8000-000000000004.webp', 'la cola conserva únicamente la ruta validada');
select is(public.finish_private_media_cleanup_job((select id from claimed_media_cleanup limit 1), false, 'SIMULATED_STORAGE_FAILURE', clock_timestamp())->>'status', 'retry_scheduled', 'un fallo de Storage programa un reintento y no pierde el trabajo');
select is((select status from public.private_media_cleanup_jobs limit 1), 'pending', 'el trabajo fallido vuelve a pendiente');
create temporary table retried_media_cleanup on commit drop as
select * from public.claim_private_media_cleanup_jobs(20, clock_timestamp() + interval '1 day');
select is((select count(*)::integer from retried_media_cleanup), 1, 'el trabajo vuelve a reclamarse tras el backoff');
select is(public.finish_private_media_cleanup_job((select id from retried_media_cleanup limit 1), true, null, clock_timestamp())->>'status', 'completed', 'un borrado exitoso marca el trabajo completado');
select is((select status from public.private_media_cleanup_jobs limit 1), 'completed', 'el estado completado queda registrado');
select is((select count(*)::integer from public.claim_private_media_cleanup_jobs(20, clock_timestamp() + interval '1 day')), 0, 'un trabajo completado no se vuelve a reclamar');

select ok(not exists (select 1 from public.private_media_cleanup_jobs where object_path !~ '^letters/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$'), 'ningún trabajo almacena rutas fuera del patrón de cartas');
select * from finish();
rollback;
