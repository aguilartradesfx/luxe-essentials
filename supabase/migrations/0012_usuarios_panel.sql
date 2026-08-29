-- supabase/migrations/0012_usuarios_panel.sql
-- Hasta acá el panel se entraba con una sola clave compartida: las cotizaciones
-- no tenían autor y no se le podía quitar el acceso a una persona sin sacar al
-- equipo entero. Esta tabla es lo que convierte "el equipo" en personas.

create table if not exists public.usuarios_panel (
  id              uuid primary key default gen_random_uuid(),
  -- Con lo que entra. La aplicación lo normaliza antes de escribir y antes de
  -- consultar: `.trim().toLowerCase()`, o sea minúsculas y sin espacios EN LOS
  -- EXTREMOS. Los espacios internos NO se prohíben: `alta` acepta
  -- "guiller mo", y ese usuario entra escribiendo el espacio, porque las dos
  -- puntas normalizan igual. Es feo, no está roto — se deja dicho acá en vez
  -- de prometer una regla que el código no cumple (revisión final, M6). El
  -- índice único de abajo es lo que sí se hace valer aunque alguien inserte a
  -- mano.
  usuario         text not null,
  -- Lo que firma las cotizaciones y ve el equipo en el listado.
  nombre          text not null,
  clave_hash      text not null,
  clave_sal       text not null,
  -- Se desactiva, no se borra: una cotización firmada por alguien que ya no
  -- está tiene que seguir diciendo quién la hizo.
  activo          boolean not null default true,
  -- Fallos consecutivos. Vuelve a cero con cada entrada correcta.
  intentos        integer not null default 0,
  bloqueado_hasta timestamptz,
  creado_at       timestamptz not null default now(),
  ultimo_acceso   timestamptz
);

-- Único e insensible a mayúsculas: "Guillermo" y "guillermo" no pueden ser dos
-- cuentas distintas. La aplicación ya normaliza, esto es el cinturón.
create unique index if not exists usuarios_panel_usuario_idx
  on public.usuarios_panel (lower(usuario));

-- Misma postura que el resto del esquema: nadie llega acá con la llave anónima.
-- Sólo el cliente de servicio del servidor, y el script de administración por
-- conexión directa.
alter table public.usuarios_panel enable row level security;

-- El nombre de quien armó la cotización. Se guarda el NOMBRE y no el id del
-- usuario: dentro de un año esta fila tiene que seguir diciendo quién la hizo
-- aunque esa persona se haya dado de baja — el mismo criterio por el que
-- `lineas` guarda los precios de ese día y no una referencia al catálogo.
alter table public.cotizaciones
  add column if not exists vendedor text;
