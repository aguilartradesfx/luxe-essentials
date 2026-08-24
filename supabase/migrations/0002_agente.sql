-- Estado por contacto del agente de respuesta multicanal.
-- Una fila por contacto de GHL, creada de forma perezosa al primer mensaje.
create table if not exists public.agente_conversaciones (
  contact_id        text primary key,
  conversation_id   text,
  canal             text,
  estado            text not null default 'activo'
                    check (estado in ('activo','humano','agotado','email_respondido')),
  turnos            int  not null default 0,
  datos             jsonb not null default '{}'::jsonb,

  -- El candado de la guarda 3. Guarda el id del último mensaje entrante que
  -- ya se procesó; el UPDATE condicional contra esta columna es lo que evita
  -- que un reintento de GHL produzca una segunda respuesta al cliente.
  ultimo_mensaje_id text,

  -- Ids de los mensajes que envió el agente. Cualquier saliente de canal real
  -- que no esté aquí lo escribió un humano (guarda 2).
  enviados          text[] not null default '{}',

  notificado_at     timestamptz,
  updated_at        timestamptz not null default now()
);

create index if not exists agente_conversaciones_estado_idx
  on public.agente_conversaciones (estado);
