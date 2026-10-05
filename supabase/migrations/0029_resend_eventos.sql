-- Que paso con cada correo DESPUES de salir (webhook de Resend).
--
-- Hasta ahora `campanas_envios.estado = 'enviado'` sólo decía "Resend lo
-- aceptó". Resend informa el resto por webhook (entregado, rebotó, queja,
-- abierto, clic...). Esta migración guarda eso en TRES niveles, cada uno
-- para una pregunta distinta:
--
--   1. `resend_eventos`            -- el RASTRO: una fila por evento recibido
--                                     (un correo puede tener varios:
--                                     entregado y después queja).
--   2. columnas `entrega_*` en
--      `campanas_envios`           -- el ESTADO ACTUAL de cada correo, para
--                                     filtrar ("mostrame los rebotados") sin
--                                     recorrer el rastro.
--   3. `campanas_entrega_totales`  -- los TOTALES por campaña, mantenidos
--                                     por contador, para leerlos sin contar
--                                     fila por fila.
--
-- QUÉ NO SE SABE, y la interfaz no puede fingir lo contrario: Resend NO
-- sabe si un correo cayó en la carpeta de spam; nadie lo sabe desde
-- afuera. `queja` (email.complained) es otra cosa: el destinatario le dio
-- «marcar como spam» DESPUÉS de recibirlo. Nunca se rotula «cayó en spam».
--
-- LAS TRES TRAMPAS DE UN WEBHOOK, resueltas en `resend_registrar_evento`:
--   * Repetido: `svix_id` (la cabecera `svix-id`, igual en cada reintento)
--     es UNIQUE; el segundo intento no inserta nada y retorna 'duplicado'
--     SIN tocar contadores.
--   * Desordenado: el estado actual sólo lo cambia un evento más NUEVO (por
--     la hora del EVENTO, `ocurrido_at`, no la de llegada) que el que ya lo
--     fijó; en empate exacto gana el más grave. Aparte, las marcas
--     `entregado_at`, `rebotado_at`, `queja_at`... se llenan SIEMPRE, sin
--     importar el orden de llegada: una queja nunca se pierde aunque llegue
--     antes que el «entregado» que la precedió.
--   * Desconocido (cotizaciones e invitaciones salen por la misma cuenta de
--     Resend): se guarda en el rastro con `envio_id` nulo y no revienta.
--     Y como el webhook puede llegar ANTES de que `campanas_cerrar_tanda`
--     alcance a escribir `resend_id` en la fila del envío, esos huérfanos se
--     reconcilian después (`resend_reconciliar_huerfanos`, la llama el cron).

alter table public.campanas_envios
  add column if not exists entrega_estado    text
    check (entrega_estado in ('enviado', 'retrasado', 'entregado', 'rebotado', 'fallido', 'queja')),
  add column if not exists entrega_evento_at timestamptz,
  add column if not exists entrega_detalle   text,
  add column if not exists entregado_at      timestamptz,
  add column if not exists rebotado_at       timestamptz,
  add column if not exists queja_at          timestamptz,
  add column if not exists fallido_at        timestamptz,
  add column if not exists abierto_at        timestamptz,
  add column if not exists clic_at           timestamptz;

create index if not exists campanas_envios_resend_id_idx
  on public.campanas_envios (resend_id)
  where resend_id is not null;

-- Para "mostrame los rebotados de esta campaña".
create index if not exists campanas_envios_entrega_idx
  on public.campanas_envios (campana_id, entrega_estado)
  where entrega_estado is not null;

create table if not exists public.resend_eventos (
  id           uuid primary key default gen_random_uuid(),
  svix_id      text not null,
  tipo         text not null,
  resend_id    text not null,
  envio_id     uuid references public.campanas_envios(id),
  ocurrido_at  timestamptz not null,
  recibido_at  timestamptz not null default now(),
  detalle      jsonb
);

-- La clave de idempotencia: el mismo evento reintentado por Svix trae el
-- mismo `svix-id`.
create unique index if not exists resend_eventos_svix_id_idx
  on public.resend_eventos (svix_id);

create index if not exists resend_eventos_envio_idx
  on public.resend_eventos (envio_id, ocurrido_at)
  where envio_id is not null;

create index if not exists resend_eventos_huerfanos_idx
  on public.resend_eventos (resend_id)
  where envio_id is null;

alter table public.resend_eventos enable row level security;

create table if not exists public.campanas_entrega_totales (
  campana_id     uuid primary key references public.campanas(id),
  entregados     integer not null default 0,
  rebotados      integer not null default 0,
  quejas         integer not null default 0,
  fallidos       integer not null default 0,
  abiertos       integer not null default 0,
  clics          integer not null default 0,
  actualizado_at timestamptz not null default now()
);

alter table public.campanas_entrega_totales enable row level security;

-- Aplica UN evento ya registrado a su envío. Interna: la llaman
-- `resend_registrar_evento` y `resend_reconciliar_huerfanos`.
create or replace function public.resend_aplicar_evento(
  p_envio_id    uuid,
  p_tipo        text,
  p_ocurrido_at timestamptz,
  p_detalle     jsonb
)
returns void as $$
declare
  v_e          public.campanas_envios%rowtype;
  v_estado     text;
  v_rank_nuevo integer;
  v_rank_viejo integer;
  v_texto      text;
  d_entregados integer := 0;
  d_rebotados  integer := 0;
  d_quejas     integer := 0;
  d_fallidos   integer := 0;
  d_abiertos   integer := 0;
  d_clics      integer := 0;
begin
  -- Bloquea la fila: dos eventos del mismo correo al mismo tiempo se
  -- aplican uno tras otro, nunca mezclados.
  select * into v_e from public.campanas_envios where id = p_envio_id for update;
  if not found then
    return;
  end if;

  v_estado := case p_tipo
    when 'email.sent'             then 'enviado'
    when 'email.delivery_delayed' then 'retrasado'
    when 'email.delivered'        then 'entregado'
    when 'email.failed'           then 'fallido'
    when 'email.bounced'          then 'rebotado'
    when 'email.complained'       then 'queja'
    else null
  end;

  -- 1) Marcas por tipo: SIEMPRE, sin importar el orden de llegada. Cada una
  --    guarda la hora más temprana; el contador sube sólo la primera vez.
  if p_tipo = 'email.delivered' and v_e.entregado_at is null then d_entregados := 1; end if;
  if p_tipo = 'email.bounced'   and v_e.rebotado_at  is null then d_rebotados  := 1; end if;
  if p_tipo = 'email.complained' and v_e.queja_at    is null then d_quejas     := 1; end if;
  if p_tipo = 'email.failed'    and v_e.fallido_at   is null then d_fallidos   := 1; end if;
  if p_tipo = 'email.opened'    and v_e.abierto_at   is null then d_abiertos   := 1; end if;
  if p_tipo = 'email.clicked'   and v_e.clic_at      is null then d_clics      := 1; end if;

  update public.campanas_envios
     set entregado_at = case when p_tipo = 'email.delivered'  then least(coalesce(entregado_at, p_ocurrido_at), p_ocurrido_at) else entregado_at end,
         rebotado_at  = case when p_tipo = 'email.bounced'    then least(coalesce(rebotado_at,  p_ocurrido_at), p_ocurrido_at) else rebotado_at  end,
         queja_at     = case when p_tipo = 'email.complained' then least(coalesce(queja_at,     p_ocurrido_at), p_ocurrido_at) else queja_at     end,
         fallido_at   = case when p_tipo = 'email.failed'     then least(coalesce(fallido_at,   p_ocurrido_at), p_ocurrido_at) else fallido_at   end,
         abierto_at   = case when p_tipo = 'email.opened'     then least(coalesce(abierto_at,   p_ocurrido_at), p_ocurrido_at) else abierto_at   end,
         clic_at      = case when p_tipo = 'email.clicked'    then least(coalesce(clic_at,      p_ocurrido_at), p_ocurrido_at) else clic_at      end
   where id = p_envio_id;

  -- 2) Estado actual: sólo lo cambia un evento MÁS NUEVO que el que lo fijó
  --    (por hora del evento); en empate exacto, el más grave. Abrir y hacer
  --    clic no son estados de entrega: no lo tocan.
  if v_estado is not null then
    v_rank_nuevo := case v_estado
      when 'enviado' then 1 when 'retrasado' then 2 when 'entregado' then 3
      when 'fallido' then 4 when 'rebotado' then 5 when 'queja' then 6 end;
    v_rank_viejo := case v_e.entrega_estado
      when 'enviado' then 1 when 'retrasado' then 2 when 'entregado' then 3
      when 'fallido' then 4 when 'rebotado' then 5 when 'queja' then 6 else 0 end;

    if v_e.entrega_evento_at is null
       or p_ocurrido_at > v_e.entrega_evento_at
       or (p_ocurrido_at = v_e.entrega_evento_at and v_rank_nuevo > v_rank_viejo) then
      v_texto := left(
        coalesce(p_detalle->>'bounce_tipo', '') ||
        case when p_detalle->>'bounce_subtipo' is not null then '/' || (p_detalle->>'bounce_subtipo') else '' end ||
        case when p_detalle->>'mensaje' is not null then ': ' || (p_detalle->>'mensaje') else '' end,
        300);
      update public.campanas_envios
         set entrega_estado    = v_estado,
             entrega_evento_at = p_ocurrido_at,
             entrega_detalle   = nullif(v_texto, '')
       where id = p_envio_id;
    end if;
  end if;

  -- 3) Totales de la campaña, sólo si algo cruzó de "no" a "sí".
  if d_entregados + d_rebotados + d_quejas + d_fallidos + d_abiertos + d_clics > 0 then
    insert into public.campanas_entrega_totales
      (campana_id, entregados, rebotados, quejas, fallidos, abiertos, clics, actualizado_at)
    values
      (v_e.campana_id, d_entregados, d_rebotados, d_quejas, d_fallidos, d_abiertos, d_clics, now())
    on conflict (campana_id) do update
      set entregados     = public.campanas_entrega_totales.entregados + excluded.entregados,
          rebotados      = public.campanas_entrega_totales.rebotados  + excluded.rebotados,
          quejas         = public.campanas_entrega_totales.quejas     + excluded.quejas,
          fallidos       = public.campanas_entrega_totales.fallidos   + excluded.fallidos,
          abiertos       = public.campanas_entrega_totales.abiertos   + excluded.abiertos,
          clics          = public.campanas_entrega_totales.clics      + excluded.clics,
          actualizado_at = now();
  end if;
end;
$$ language plpgsql;

-- Lo que llama el webhook: UNA sola ida a la base, rápida. Retorna
-- 'aplicado' | 'duplicado' | 'huerfano'.
create or replace function public.resend_registrar_evento(
  p_svix_id     text,
  p_tipo        text,
  p_resend_id   text,
  p_ocurrido_at timestamptz,
  p_detalle     jsonb
)
returns text as $$
declare
  v_envio_id uuid;
  v_nuevo    uuid;
begin
  select id into v_envio_id
    from public.campanas_envios
   where resend_id = p_resend_id
   limit 1;

  insert into public.resend_eventos (svix_id, tipo, resend_id, envio_id, ocurrido_at, detalle)
  values (p_svix_id, p_tipo, p_resend_id, v_envio_id, p_ocurrido_at, p_detalle)
  on conflict (svix_id) do nothing
  returning id into v_nuevo;

  if v_nuevo is null then
    return 'duplicado';
  end if;
  if v_envio_id is null then
    return 'huerfano';
  end if;

  perform public.resend_aplicar_evento(v_envio_id, p_tipo, p_ocurrido_at, p_detalle);
  return 'aplicado';
end;
$$ language plpgsql;

-- Eventos que llegaron antes de que el envío tuviera `resend_id`: se
-- enlazan y se aplican EN ORDEN de hora de evento. Acotado a los últimos 3
-- días y a 500 por llamada; retorna cuántos aplicó.
create or replace function public.resend_reconciliar_huerfanos()
returns integer as $$
declare
  v_fila  record;
  v_total integer := 0;
begin
  for v_fila in
    select ev.id, ev.tipo, ev.ocurrido_at, ev.detalle, ce.id as envio_id
      from public.resend_eventos ev
      join public.campanas_envios ce on ce.resend_id = ev.resend_id
     where ev.envio_id is null
       and ev.recibido_at > now() - interval '3 days'
     order by ev.ocurrido_at
     limit 500
  loop
    update public.resend_eventos set envio_id = v_fila.envio_id where id = v_fila.id;
    perform public.resend_aplicar_evento(v_fila.envio_id, v_fila.tipo, v_fila.ocurrido_at, v_fila.detalle);
    v_total := v_total + 1;
  end loop;
  return v_total;
end;
$$ language plpgsql;

-- Permisos. Mismo cuidado que 0024/0027: `revoke ... from public` a secas
-- NO quita el permiso nominal de `anon`/`authenticated` que Supabase otorga
-- por defecto a toda función nueva; se nombran los dos roles de forma
-- explícita. Estas funciones escriben contadores y estados de entrega:
-- invocables con la llave pública sería falsificar métricas.
revoke all on function public.resend_aplicar_evento(uuid, text, timestamptz, jsonb) from public;
revoke execute on function public.resend_aplicar_evento(uuid, text, timestamptz, jsonb) from anon, authenticated;
grant execute on function public.resend_aplicar_evento(uuid, text, timestamptz, jsonb) to service_role;

revoke all on function public.resend_registrar_evento(text, text, text, timestamptz, jsonb) from public;
revoke execute on function public.resend_registrar_evento(text, text, text, timestamptz, jsonb) from anon, authenticated;
grant execute on function public.resend_registrar_evento(text, text, text, timestamptz, jsonb) to service_role;

revoke all on function public.resend_reconciliar_huerfanos() from public;
revoke execute on function public.resend_reconciliar_huerfanos() from anon, authenticated;
grant execute on function public.resend_reconciliar_huerfanos() to service_role;
