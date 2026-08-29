-- supabase/migrations/0013_usuarios_panel_intento_fallido.sql
-- Revisión final, Importante 2: el contador de intentos fallidos era un
-- lee-modifica-escribe. `autenticarUsuario` leía `intentos`, sumaba uno en
-- JavaScript y escribía el valor absoluto. Cien peticiones concurrentes leen
-- todas `0` y escriben todas `1`: el atacante no obtenía cinco intentos, sino
-- cinco TANDAS de tamaño arbitrario. El límite de intentos es la justificación
-- entera de tener una tabla de credenciales en vez de una clave compartida, así
-- que el debilitamiento no era un detalle.
--
-- Acá el incremento y el bloqueo ocurren en una sola sentencia `update`, sobre
-- la fila que Postgres bloquea mientras la modifica: dos peticiones
-- simultáneas se serializan y la segunda ve el valor que dejó la primera.
-- Devuelve si la cuenta quedó bloqueada, para que `/entrar` pueda seguir
-- distinguiendo los dos motivos ('credenciales' vs. 'bloqueado') como hasta
-- ahora.
--
-- Los umbrales viajan como parámetros y no se codifican acá: `MAX_INTENTOS` y
-- `BLOQUEO_MINUTOS` viven en lib/cotizador/usuarios.ts, que es donde están
-- probados. Duplicarlos en el esquema haría que cambiar uno dejara al otro
-- mintiendo en silencio.
create or replace function public.usuarios_panel_intento_fallido(
  p_id uuid,
  p_max_intentos integer,
  p_bloqueo_minutos integer,
  p_ahora timestamptz
)
returns boolean as $$
declare
  v_bloqueado_hasta timestamptz;
begin
  -- Una sola sentencia. En el `set`, `intentos` es todavía el valor viejo de
  -- la fila, así que `intentos + 1` es el nuevo — calculado por la base, no
  -- por la aplicación, y sobre la versión de la fila que esta transacción
  -- acaba de bloquear.
  --
  -- El contador vuelve a cero junto con el bloqueo: si se dejara en el máximo,
  -- el primer fallo después de vencer el bloqueo volvería a bloquear de
  -- inmediato y la cuenta quedaría en un ciclo del que sólo se sale por
  -- consola.
  update public.usuarios_panel
     set intentos = case
                      when intentos + 1 >= p_max_intentos then 0
                      else intentos + 1
                    end,
         bloqueado_hasta = case
                             when intentos + 1 >= p_max_intentos
                               then p_ahora + make_interval(mins => p_bloqueo_minutos)
                             else bloqueado_hasta
                           end
   where id = p_id
  returning bloqueado_hasta into v_bloqueado_hasta;

  -- Fila inexistente (borrada entre la lectura y la escritura): no hay nada
  -- que bloquear y tampoco es un error — quien llama ya decidió rechazar.
  if not found then
    return false;
  end if;

  -- `returning` entrega el valor NUEVO. Si este fallo fue el que bloqueó, la
  -- fecha quedó en el futuro; si la fila ya traía un bloqueo vencido de antes,
  -- sigue en el pasado y esto devuelve `false`, que es lo correcto.
  return v_bloqueado_hasta is not null and v_bloqueado_hasta > p_ahora;
end;
$$ language plpgsql;

-- Misma postura que `usuarios_panel` (RLS, migración 0012): a esta tabla sólo
-- llega el cliente de servicio del servidor. Sin esto la función quedaría
-- ejecutable por `PUBLIC` —el default de Postgres— y por lo tanto invocable
-- por `anon` a través de PostgREST. Hoy eso no lograría nada (con RLS puesta y
-- sin políticas, el `update` no tocaría ninguna fila), pero depender de eso es
-- depender de que nadie agregue una política más adelante.
revoke all on function public.usuarios_panel_intento_fallido(uuid, integer, integer, timestamptz) from public;
grant execute on function public.usuarios_panel_intento_fallido(uuid, integer, integer, timestamptz) to service_role;
