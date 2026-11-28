begin;
select plan(20);

select ok(
  has_function_privilege('service_role', 'public.confirm_letter_permanent_deletion(uuid,uuid)', 'execute'),
  'solo service_role puede confirmar la eliminación compartida'
);
select ok(
  not has_function_privilege('anon', 'public.confirm_letter_permanent_deletion(uuid,uuid)', 'execute'),
  'anon no puede confirmar la eliminación compartida'
);
select ok(
  has_function_privilege('service_role', 'public.withdraw_sent_letter_to_draft(uuid,uuid)', 'execute'),
  'service_role puede retirar una creación enviada a Borradores'
);
select ok(
  not has_function_privilege('anon', 'public.withdraw_sent_letter_to_draft(uuid,uuid)', 'execute'),
  'anon no puede retirar cartas enviadas'
);
select ok(
  not has_function_privilege('authenticated', 'public.withdraw_sent_letter_to_draft(uuid,uuid)', 'execute'),
  'authenticated tampoco puede retirar cartas: la aplicación usa sesiones propias'
);

-- Fixture aislada, íntegramente revertida al finalizar este archivo.
insert into public.app_users(id, username, email, display_name, password_hash, status)
values
  ('11111111-1111-4111-8111-111111111111', 'purge-test-a', 'purge-test-a@example.invalid', 'Purge Test A', repeat('a', 64), 'active'),
  ('22222222-2222-4222-8222-222222222222', 'purge-test-b', 'purge-test-b@example.invalid', 'Purge Test B', repeat('b', 64), 'active');

insert into public.letter_threads(id, participant_a_id, participant_b_id, created_by_user_id)
values (
  '33333333-3333-4333-8333-333333333333',
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111'
);

insert into public.letters(
  id, thread_id, sender_id, recipient_id, title, body, status, sent_at, created_at, updated_at
) values (
  '44444444-4444-4444-8444-444444444444',
  '33333333-3333-4333-8333-333333333333',
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  'Carta original de prueba', '<p>Contenido original</p>', 'sent',
  now() - interval '2 minutes', now() - interval '2 minutes', now() - interval '2 minutes'
);

insert into public.letters(id, thread_id, sender_id, recipient_id, reply_to_letter_id, title, body, status, sent_at, created_at, updated_at)
values (
  '55555555-5555-4555-8555-555555555555',
  '33333333-3333-4333-8333-333333333333',
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  '44444444-4444-4444-8444-444444444444',
  'Respuesta de prueba', '<p>Contenido de respuesta</p>', 'sent',
  now() - interval '1 minute', now() - interval '1 minute', now() - interval '1 minute'
);

insert into public.letter_user_state(letter_id, user_id, trashed_at)
select l.id, u.id, now()
from public.letters l
cross join public.app_users u
where l.id in (
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555'
)
and u.id in (
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222'
);

-- Un borrador descartado debe rechazar un autoguardado que llegue tarde.
insert into public.letters(
  id, thread_id, sender_id, recipient_id, creation_request_id, title, body, status
) values (
  '66666666-6666-4666-8666-666666666666',
  '33333333-3333-4333-8333-333333333333',
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '66666666-6666-4666-8666-666666666666',
  'Borrador descartado', '<p>Texto original</p>', 'draft'
);
insert into public.letter_user_state(letter_id, user_id, trashed_at)
values ('66666666-6666-4666-8666-666666666666', '11111111-1111-4111-8111-111111111111', now());

select is(
  public.save_letter_draft(
    '11111111-1111-4111-8111-111111111111',
    '66666666-6666-4666-8666-666666666666',
    'Texto tardío', '<p>Texto tardío</p>', 1
  )->>'status',
  'discarded',
  'un autoguardado atrasado no puede sacar un borrador de Papelera'
);
select is(
  (select body from public.letters where id = '66666666-6666-4666-8666-666666666666'),
  '<p>Texto original</p>',
  'el contenido del borrador descartado permanece sin cambios'
);

select is(
  public.confirm_letter_permanent_deletion('11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444444')->>'status',
  'purged',
  'el autor elimina su propia carta sin requerir la autorización del destinatario'
);
select is(
  public.confirm_letter_permanent_deletion('22222222-2222-4222-8222-222222222222', '44444444-4444-4444-8444-444444444444')->>'status',
  'already_purged',
  'el destinatario no puede provocar una segunda eliminación del mismo contenido'
);
select is(
  (select status from public.letters where id = '44444444-4444-4444-8444-444444444444'),
  'purged',
  'la carta original queda purgada'
);
select is(
  public.confirm_letter_permanent_deletion('11111111-1111-4111-8111-111111111111', '55555555-5555-4555-8555-555555555555')->>'status',
  'pending_other_participant',
  'el destinatario puede registrar su confirmación, pero no borrar la creación ajena'
);
select is(
  public.confirm_letter_permanent_deletion('11111111-1111-4111-8111-111111111111', '55555555-5555-4555-8555-555555555555')->>'status',
  'already_confirmed_waiting',
  'repetir la confirmación del destinatario es idempotente'
);
select is(
  public.confirm_letter_permanent_deletion('22222222-2222-4222-8222-222222222222', '55555555-5555-4555-8555-555555555555')->>'status',
  'purged',
  'el autor elimina su respuesta aunque la carta padre ya esté purgada'
);
select is(
  (select status from public.letters where id = '55555555-5555-4555-8555-555555555555'),
  'purged',
  'la respuesta termina purgada sin borrar la integridad referencial'
);

-- Una carta retirada vuelve a Borradores del autor y puede volver a enviarse.
insert into public.letters(
  id, thread_id, sender_id, recipient_id, title, body, status, sent_at, created_at, updated_at
) values (
  '77777777-7777-4777-8777-777777777777',
  '33333333-3333-4333-8333-333333333333',
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  'Carta que se retira', '<p>Texto para volver a borradores</p>', 'sent',
  now(), now(), now()
);
insert into public.letter_user_state(letter_id, user_id)
values
  ('77777777-7777-4777-8777-777777777777', '11111111-1111-4111-8111-111111111111'),
  ('77777777-7777-4777-8777-777777777777', '22222222-2222-4222-8222-222222222222');
select is(
  public.withdraw_sent_letter_to_draft('11111111-1111-4111-8111-111111111111', '77777777-7777-4777-8777-777777777777')->>'status',
  'withdrawn',
  'el autor puede retirar su carta enviada a borradores'
);
select is(
  (select status || ':' || coalesce(recipient_id::text, 'null') from public.letters where id = '77777777-7777-4777-8777-777777777777'),
  'draft:null',
  'la carta retirada deja de ser visible como mensaje enviado al destinatario'
);
select is(
  public.send_letter_draft('11111111-1111-4111-8111-111111111111', '77777777-7777-4777-8777-777777777777', 2)->>'status',
  'sent',
  'el borrador retirado se puede volver a enviar con su revisión actual'
);

-- Si una cuenta se elimina, su estado privado se borra y ya no puede confirmar.
-- La cuenta activa que sí confirmó debe poder completar la purga automáticamente.
insert into public.letter_threads(id, participant_a_id, participant_b_id, created_by_user_id)
values (
  '88888888-8888-4888-8888-888888888888',
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111'
);
insert into public.letters(
  id, thread_id, sender_id, recipient_id, title, body, status, sent_at, created_at, updated_at
) values (
  '99999999-9999-4999-8999-999999999999',
  '88888888-8888-4888-8888-888888888888',
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  'Carta de cuenta eliminada', '<p>Contenido que debe poder borrarse</p>', 'sent',
  now(), now(), now()
);
insert into public.letter_user_state(letter_id, user_id, trashed_at)
values
  ('99999999-9999-4999-8999-999999999999', '11111111-1111-4111-8111-111111111111', now()),
  ('99999999-9999-4999-8999-999999999999', '22222222-2222-4222-8222-222222222222', now());
select is(
  public.confirm_letter_permanent_deletion('11111111-1111-4111-8111-111111111111', '99999999-9999-4999-8999-999999999999')->>'status',
  'pending_other_participant',
  'la cuenta activa guarda su confirmación mientras la otra sigue activa'
);
delete from public.letter_user_state
where letter_id = '99999999-9999-4999-8999-999999999999'
  and user_id = '22222222-2222-4222-8222-222222222222';
update public.app_users set status = 'disabled'
where id = '22222222-2222-4222-8222-222222222222';
select is(
  (select status from public.letters where id = '99999999-9999-4999-8999-999999999999'),
  'purged',
  'al eliminarse la otra cuenta, la confirmación pendiente no deja la carta bloqueada'
);
select is(
  (select body from public.letters where id = '99999999-9999-4999-8999-999999999999'),
  null,
  'la purga automática elimina el contenido en claro'
);

select * from finish();
rollback;
