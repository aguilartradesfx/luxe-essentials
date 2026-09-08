-- supabase/migrations/0019_campanas.sql
-- Bandeja de campañas (fase 1: datos y envío -- la pantalla, fase 2, es
-- otra tarea). Dos tablas:
--
--   - `campanas`: la campaña en sí -- qué plantilla, qué texto final (ya
--     con cualquier edición que se le haya hecho antes de enviar), quién
--     la armó.
--   - `campanas_envios`: el registro por destinatario. Es el corazón del
--     diseño (docs/superpowers/specs/2026-09-08-campanas-design.md): un
--     envío de miles de correos no cabe en una petición, así que se manda
--     por tandas, y una campaña interrumpida -- por un corte, por cerrar
--     la pestaña, por un fallo de Resend -- tiene que RETOMARSE donde
--     quedó, no volver a empezar. Eso exige saber, por cada destinatario,
--     si ya se le mandó o no -- no alcanza con saber cuántos van de una
--     campaña de 3.340.
--
-- La lista de destinatarios se fija al CREAR la campaña -- una fila por
-- destinatario en `campanas_envios`, en estado 'pendiente' -- y no se
-- recalcula contra GoHighLevel en cada tanda: si se recalculara, un
-- contacto al que le agregan un correo a mitad de un envío de horas
-- entraría a mitad de camino, y uno cuya zona cambia se caería sin que
-- nadie lo decidiera. Una campaña es una lista fija, decidida una vez.
create table if not exists public.campanas (
  id            uuid primary key default gen_random_uuid(),
  -- Las cuatro plantillas (Tarea 2 de la bandeja de campañas -- todavía sin
  -- el texto real, ver el reporte de esa tarea): la inicial y tres
  -- seguimientos.
  plantilla     text not null check (plantilla in ('inicial', 'seguimiento_1', 'seguimiento_2', 'seguimiento_3')),
  -- Asunto final, ya con cualquier edición de texto que se le haya hecho
  -- antes de enviar (el diseño permite editar el texto, nunca el armazón
  -- HTML). Es el MISMO asunto para toda la campaña: los marcadores
  -- {{nombre}}/{{empresa}} son del cuerpo, no del asunto -- el asunto no
  -- varía por destinatario.
  asunto        text not null,
  -- Vista previa (preheader): lo que un cliente de correo muestra junto al
  -- asunto en la bandeja, antes de abrir el mensaje. Nullable: alguna
  -- plantilla puede no traerlo.
  preview_text  text,
  -- El HTML final de la plantilla, con los tres marcadores TODAVÍA SIN
  -- resolver (`{{nombre}}`, `{{empresa}}`, `{{unsubscribe_url}}`) --
  -- resolverlos es cosa de cada destinatario, recién al mandar
  -- (lib/campanas/marcadores.ts), porque cada uno lleva su propio saludo y
  -- su propio enlace de baja.
  html          text not null,
  -- Usuario del panel que armó la campaña (usuarios_panel.usuario) --
  -- mismo criterio que la columna `vendedor` de `cotizaciones` (migración
  -- 0012): se guarda el NOMBRE y no una referencia, para que esta fila
  -- siga diciendo quién la mandó aunque esa persona se vaya del equipo.
  creado_por    text not null,
  creado_at     timestamptz not null default now()
);

-- Mismo criterio que el resto del esquema: sólo el cliente de servicio del
-- servidor llega hasta acá.
alter table public.campanas enable row level security;

create table if not exists public.campanas_envios (
  id              uuid primary key default gen_random_uuid(),
  campana_id      uuid not null references public.campanas(id),
  -- Normalizado (`.trim().toLowerCase()`, mismo criterio que `bajas_correo`,
  -- migración 0018) antes de escribir.
  correo          text not null,
  -- El contacto de GoHighLevel al que corresponde -- para volver a esa
  -- ficha desde el registro y para dejar la nota de envío que documenta
  -- `notaDeCotizacion` en lib/cotizador/ghl.ts como precedente del mismo
  -- patrón.
  contacto_id     text not null,
  -- El nombre tal cual venía del CRM AL MOMENTO DE ARMAR LA CAMPAÑA --
  -- fotografiado acá y nunca vuelto a leer de GoHighLevel en una tanda
  -- posterior, por el mismo motivo que la lista de destinatarios se fija
  -- al crear la campaña (ver el comentario del encabezado): si alguien
  -- corrige el nombre en GHL a mitad de un envío de horas, esta fila tiene
  -- que seguir mandando el saludo con el que se armó y se revisó la
  -- campaña, no uno distinto a mitad de camino.
  nombre_crm      text not null,
  -- 'pendiente': todavía no se intentó (o se intentó y la reserva quedó
  --   abandonada -- ver `campanas_reclamar_pendientes`, más abajo).
  -- 'enviado': Resend lo aceptó (trae `resend_id`).
  -- 'error': se intentó y falló PARA ESTE destinatario en particular (una
  --   dirección que Resend no confirmó, por ejemplo) -- un fallo así NO se
  --   reintenta solo. Es distinto de un fallo de Resend ENTERO para toda
  --   la tanda, que nunca llega a marcar nada acá -- ver el comentario
  --   grande de `campanas_reclamar_pendientes` y el de `enviarTanda` en
  --   lib/campanas/envio.ts.
  estado          text not null default 'pendiente' check (estado in ('pendiente', 'enviado', 'error')),
  resend_id       text,
  error           text,
  creado_at       timestamptz not null default now(),
  -- Cuándo se tocó por última vez esta fila: al reservarla para una tanda
  -- (`campanas_reclamar_pendientes` la pisa), y al cerrarla en
  -- 'enviado'/'error'. Es lo que permite distinguir una reserva ACTIVA (una
  -- tanda la está mandando ahora mismo) de una ABANDONADA (la tanda que la
  -- reservó se cortó a mitad de camino, o Resend le falló entero).
  actualizado_at  timestamptz
);

-- El candado contra "nadie recibe dos veces": un mismo correo no puede
-- tener dos filas en la misma campaña. Es lo que hace posible retomar sin
-- duplicar -- y, junto con `campanas_reclamar_pendientes` (que reserva bajo
-- lock de fila antes de mandar nada), lo que evita que DOS tandas que
-- salen a la vez le manden a la misma persona dos veces.
create unique index if not exists campanas_envios_campana_correo_idx
  on public.campanas_envios (campana_id, correo);

-- Acelera `campanas_reclamar_pendientes`, que filtra por
-- campana_id+estado='pendiente' y ordena por creado_at en cada tanda.
-- Parcial porque sólo 'pendiente' se consulta con esa frecuencia --
-- 'enviado' y 'error' son estados finales que se leen para un resumen, no
-- en cada tanda.
create index if not exists campanas_envios_pendientes_idx
  on public.campanas_envios (campana_id, creado_at)
  where estado = 'pendiente';

alter table public.campanas_envios enable row level security;

-- Reclama hasta `p_limite` destinatarios pendientes de `p_campana_id`, los
-- marca como reservados (pisa `actualizado_at`) y devuelve esas filas -- en
-- una sola sentencia, sobre las filas que la propia base bloquea mientras
-- las toca. Mismo criterio que ya usan `usuarios_panel_intento_fallido`
-- (migración 0013) y `usuarios_panel_cambiar_estado` (migración 0015) para
-- cerrar una carrera: nada de "leer en la aplicación, decidir y escribir"
-- -- eso deja una ventana entre la lectura y la escritura donde dos tandas
-- concurrentes leen la MISMA lista de pendientes y las dos le mandan correo
-- a la misma persona. Es, literalmente, el escenario que el diseño pide
-- pensar ("qué pasa si dos tandas salen a la vez").
--
-- La diferencia con esas dos funciones es `for update skip locked` en vez
-- de `for update` a secas: acá NO conviene que la segunda tanda espere a
-- la primera y reintente sobre lo que sobró -- eso funcionaría, pero en
-- serie, mandando una tanda a la vez aunque dos hubieran querido empezar
-- juntas. `skip locked` deja que cada tanda concurrente se lleve un lote
-- DISTINTO sin esperarse entre sí: la primera toma las filas 1-100, y la
-- segunda, que llega un instante después, ve esas 100 ya bloqueadas y las
-- salta -- se lleva la 101-200 sin bloquearse. Es el patrón estándar de
-- Postgres para una cola de trabajo.
--
-- `p_vencido_desde`: una reserva ('pendiente' con `actualizado_at`
-- reciente) NO se vuelve a entregar -- se asume que otra tanda la está
-- mandando ahora mismo. Pero una reserva más vieja que este corte sí se
-- reclama de nuevo: es lo que hace RETOMABLE una campaña que se cortó a
-- mitad de una tanda, o a la que Resend le falló entero
-- (lib/campanas/envio.ts nunca marca esas filas 'error' -- las deja
-- 'pendiente' con la reserva vieja, a propósito, para que este mecanismo
-- las recupere solo, sin que nadie tenga que hacer nada).
create or replace function public.campanas_reclamar_pendientes(
  p_campana_id     uuid,
  p_limite         integer,
  p_vencido_desde  timestamptz
)
returns setof public.campanas_envios as $$
begin
  return query
    update public.campanas_envios
       set actualizado_at = now()
     where id in (
       select ce.id
         from public.campanas_envios ce
        where ce.campana_id = p_campana_id
          and ce.estado = 'pendiente'
          and (ce.actualizado_at is null or ce.actualizado_at < p_vencido_desde)
        order by ce.creado_at
        limit p_limite
        for update skip locked
     )
    returning *;
end;
$$ language plpgsql;

-- Misma postura que `usuarios_panel_intento_fallido` (migración 0013): sin
-- esto la función queda ejecutable por `PUBLIC` -- el default de Postgres
-- -- y por lo tanto invocable por `anon` a través de PostgREST.
revoke all on function public.campanas_reclamar_pendientes(uuid, integer, timestamptz) from public;
grant execute on function public.campanas_reclamar_pendientes(uuid, integer, timestamptz) to service_role;
