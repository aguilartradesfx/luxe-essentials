create table if not exists public.leads (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  nombre         text not null,
  empresa        text,
  email          text not null,
  telefono       text,
  linea          text not null check (linea in ('uniformes','hogar','ambas')),
  cantidad       text,
  mensaje        text,
  fuente         text not null default 'landing',
  utm            jsonb,
  ghl_contact_id text,
  ghl_synced_at  timestamptz,
  ghl_error      text
);

alter table public.leads enable row level security;

-- Sin políticas: sólo el service role escribe, desde el route handler.

create index if not exists leads_created_at_idx on public.leads (created_at desc);

-- Cola de reintento: leads que no llegaron a GHL.
create index if not exists leads_pendientes_ghl_idx
  on public.leads (created_at desc)
  where ghl_contact_id is null;
