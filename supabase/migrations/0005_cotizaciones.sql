-- Registro de cotizaciones. NO es la fuente de verdad del estado comercial:
-- eso vive en GoHighLevel. Aquí queda la auditoría (qué precios se enviaron y
-- cuándo) y la cola de borradores que deja el agente.

create table if not exists public.cotizaciones (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  origen          text not null check (origen in ('humano', 'agente')),
  estado          text not null check (estado in ('borrador', 'enviada', 'error')),

  contact_id      text,
  cliente         jsonb not null,
  -- El resultado del cálculo, no una referencia al catálogo. Una cotización de
  -- hace tres meses tiene que reimprimirse con los precios de ese día.
  lineas          jsonb not null,
  totales         jsonb not null,

  ghl_estimate_id text,
  ghl_error       text
);

-- La pantalla lista los borradores pendientes primero, y es la única consulta
-- que corre en cada carga.
create index if not exists cotizaciones_estado_fecha_idx
  on public.cotizaciones (estado, created_at desc);

alter table public.cotizaciones enable row level security;

-- Sin políticas: solo el service role escribe y lee, desde el servidor. Mismo
-- criterio que public.leads.
