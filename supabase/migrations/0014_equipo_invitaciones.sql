-- supabase/migrations/0014_equipo_invitaciones.sql
-- Fase 4: se invita por correo y hay dos roles. La tabla tiene cero filas al
-- momento de escribir esto, así que el renombre no migra nada.

alter table public.usuarios_panel rename column usuario to correo;

alter table public.usuarios_panel
  add column if not exists rol text not null default 'vendedor'
    check (rol in ('vendedor', 'superadmin')),
  -- La HUELLA del enlace, nunca el enlace.
  add column if not exists invitacion_hash   text,
  add column if not exists invitacion_expira timestamptz;

-- Una persona invitada todavía no eligió su clave: sin esto no se puede
-- crear su fila.
alter table public.usuarios_panel
  alter column clave_hash drop not null,
  alter column clave_sal  drop not null;

-- El índice único de la 0012 era sobre lower(usuario); la columna cambió de
-- nombre y Postgres NO actualiza la expresión sola.
drop index if exists usuarios_panel_usuario_idx;
create unique index if not exists usuarios_panel_correo_idx
  on public.usuarios_panel (lower(correo));

-- Se busca por huella en cada clic del enlace del correo.
create index if not exists usuarios_panel_invitacion_idx
  on public.usuarios_panel (invitacion_hash) where invitacion_hash is not null;
