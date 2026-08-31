-- supabase/migrations/0015_equipo_cambiar_estado.sql
-- Ronda de correcciones 1 (Tarea 5, invitaciones y roles), Importante 3:
-- `cambiarEstado` (lib/cotizador/equipo.ts) contaba los superadmins activos
-- y escribía en dos pasos separados, sin atomicidad — el mismo patrón que
-- ya se había rechazado una vez en la 0013 para el contador de intentos
-- fallidos, y por el mismo motivo: con exactamente dos superadmins activos,
-- dos peticiones concurrentes que degradan (o desactivan) a uno cada una
-- pueden contar las dos "2 superadmins" ANTES de que ninguna escriba, las
-- dos deciden que es seguro proceder, y el equipo queda con CERO
-- superadmins activos — un estado del que ninguna de las cuatro rutas de
-- /api/equipo/* puede sacarlo, porque las cuatro exigen justamente un
-- superadmin activo para entrar.
--
-- Igual que en la 0013: el conteo y la escritura pasan a ser una sola
-- función de Postgres, invocada por `rpc`, sobre las filas que la propia
-- base bloquea mientras las lee.

create or replace function public.usuarios_panel_cambiar_estado(
  p_id     uuid,
  -- `null` significa "no tocar esta columna" — es la forma en que
  -- `cambiarEstado` traduce un campo ausente del cuerpo de la petición
  -- (`activo`/`rol` son ambos opcionales: la ruta exige al menos uno, pero
  -- nunca los dos a la fuerza).
  p_activo boolean,
  p_rol    text
)
returns text as $$
declare
  v_rol    text;
  v_activo boolean;
  v_nuevo_rol    text;
  v_nuevo_activo boolean;
  v_activos_restantes integer;
begin
  -- Bloquea TODAS las filas superadmin+activas antes de leer nada. Esto es
  -- lo que de verdad cierra la carrera: `for update` sobre una fila
  -- individual (más abajo, sobre `p_id`) no protege contra DOS peticiones
  -- que tocan DOS filas superadmin distintas al mismo tiempo — cada una
  -- tomaría su propio lock sin chocar con la otra, y las dos podrían leer
  -- "2 activos" antes de que cualquiera escriba. Bloqueando el conjunto
  -- entero primero, la segunda transacción que llega tiene que esperar a
  -- que la primera termine (commit o rollback) antes de poder tomar sus
  -- propios locks sobre esas mismas filas — y para entonces ya cuenta sobre
  -- el estado que dejó la primera.
  perform 1
    from public.usuarios_panel
   where rol = 'superadmin' and activo = true
   for update;

  select rol, activo into v_rol, v_activo
    from public.usuarios_panel
   where id = p_id
   for update;

  -- Fila inexistente (borrada entre que la ruta la mostró y esta llamada, o
  -- un id que nunca existió): no hay nada que cambiar, y no es un error de
  -- la base — quien llama decide qué responder.
  if not found then
    return 'no_encontrado';
  end if;

  v_nuevo_rol    := coalesce(p_rol, v_rol);
  v_nuevo_activo := coalesce(p_activo, v_activo);

  -- Sólo hace falta contar cuando ESTA fila deja de ser un superadmin
  -- activo: degradar a un vendedor, o reactivar a alguien, nunca puede
  -- achicar ese conjunto, y el `for update` de arriba no hacía falta
  -- tomarlo para nada más que esto.
  if v_rol = 'superadmin' and v_activo
     and not (v_nuevo_rol = 'superadmin' and v_nuevo_activo) then
    select count(*) into v_activos_restantes
      from public.usuarios_panel
     where rol = 'superadmin' and activo = true;

    if v_activos_restantes <= 1 then
      return 'ultimo_superadmin';
    end if;
  end if;

  update public.usuarios_panel
     set rol    = v_nuevo_rol,
         activo = v_nuevo_activo
   where id = p_id;

  return 'ok';
end;
$$ language plpgsql;

-- Misma postura que el resto del esquema (RLS, migraciones 0012/0013): sólo
-- el cliente de servicio del servidor llega a esta tabla, y esta función no
-- debe quedar ejecutable por `PUBLIC` —el default de Postgres— ni por lo
-- tanto invocable por `anon` a través de PostgREST.
revoke all on function public.usuarios_panel_cambiar_estado(uuid, boolean, text) from public;
grant execute on function public.usuarios_panel_cambiar_estado(uuid, boolean, text) to service_role;
