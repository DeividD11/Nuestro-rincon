-- Índices de soporte para las claves foráneas añadidas por el sistema de invitaciones.
create index if not exists registration_invites_invited_by_user_id_idx
  on public.registration_invites (invited_by_user_id);

create index if not exists registration_invites_consumed_user_id_idx
  on public.registration_invites (consumed_user_id);

create index if not exists registration_invite_attempts_user_id_idx
  on public.registration_invite_attempts (user_id);
