-- supabase/migrations/0020_campanas_cancelar.sql
-- Poder cancelar una campaña ya creada (encargo del dueño): hoy, si alguien
-- se equivoca de zona o de plantilla en una campaña de 500 destinatarios, no
-- hay forma de pararla. Dos columnas nuevas en `campanas` -- nada de un
-- estado nuevo en `campanas_envios`: cancelar es una propiedad de la
-- CAMPAÑA, no de cada destinatario, y las filas 'pendiente' que quedan sin
-- mandar se QUEDAN 'pendiente' para siempre (nunca se tocan, nunca se
-- reescriben a 'cancelado' ni nada por el estilo) -- lo que ya se envió
-- ('enviado'/'error') sigue diciendo exactamente eso. "Cancelar detiene lo
-- que falta, no reescribe la historia" (pedido explícito).
alter table public.campanas
  add column if not exists cancelada_at  timestamptz,
  add column if not exists cancelada_por text;

-- El corazón de la carrera que este encargo pide resolver: "puede haber una
-- tanda en vuelo justo cuando se cancela". Una tanda en vuelo (que YA
-- reclamó sus filas antes de la cancelación) tiene que poder TERMINAR de
-- mandarlas -- no se aborta a mitad de una llamada a Resend, eso dejaría el
-- estado de esas filas en un limbo peor que mandarlas. Lo que sí tiene que
-- ser imposible es que una tanda EMPIECE (reclame filas nuevas) después de
-- que la cancelación quedó escrita.
--
-- La defensa de aplicación (enviarTanda, lib/campanas/envio.ts, lee
-- `cancelada_at` al principio y no llega a llamar a este rpc si ya la ve
-- cancelada) cubre el caso común, pero deja una ventana angosta: si la
-- cancelación se escribe DESPUÉS de que enviarTanda ya leyó `cancelada_at`
-- como nula pero ANTES de que este rpc corra, esa lectura de aplicación no
-- alcanza. Por eso el filtro se repite ACÁ, dentro del mismo `update` que
-- reclama las filas -- en READ COMMITTED (el nivel por defecto de
-- Postgres), cada sentencia ve el estado confirmado más reciente al
-- EMPEZAR esa sentencia, así que si el `update` de cancelar (una sentencia
-- propia, en su propia transacción) ya confirmó cuando esta sentencia
-- arranca, el `where` de abajo no reclama nada -- sin necesidad de que la
-- aplicación se entere de la cancelación por su cuenta. Es el mismo
-- argumento que ya sostiene `for update skip locked` acá mismo (migración
-- 0019): la garantía vive en que reclamar es UNA sola sentencia atómica,
-- no una lectura-decide-escribe repartida en el código de la aplicación.
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
          and not exists (
            select 1 from public.campanas c
             where c.id = ce.campana_id
               and c.cancelada_at is not null
          )
        order by ce.creado_at
        limit p_limite
        for update skip locked
     )
    returning *;
end;
$$ language plpgsql;

revoke all on function public.campanas_reclamar_pendientes(uuid, integer, timestamptz) from public;
grant execute on function public.campanas_reclamar_pendientes(uuid, integer, timestamptz) to service_role;
