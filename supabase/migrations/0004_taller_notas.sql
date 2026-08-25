-- Sesiones del banco de pruebas del agente: la conversación tal como ocurrió,
-- los datos que el modelo extrajo, y las notas de quien la probó.
--
-- Existe para que las observaciones sobrevivan al navegador y se puedan leer
-- después con una consulta, en vez de depender de que alguien copie y pegue.
create table if not exists public.taller_notas (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  etiqueta   text,
  canal      text,
  turnos     jsonb not null default '[]'::jsonb,
  datos      jsonb not null default '{}'::jsonb,
  notas      text
);

alter table public.taller_notas enable row level security;

-- Sin políticas, igual que public.leads y public.agente_conversaciones: sólo el
-- service role escribe, desde el route handler. Aquí se guardan conversaciones
-- de prueba que pueden contener datos inventados o reales, y la anon key viaja
-- al navegador en el bundle de la landing.

create index if not exists taller_notas_created_at_idx
  on public.taller_notas (created_at desc);
