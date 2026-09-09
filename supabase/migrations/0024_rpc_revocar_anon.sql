-- supabase/migrations/0024_rpc_revocar_anon.sql
-- Verificación posterior a la segunda tanda de correcciones.
--
-- Las cinco funciones del proyecto traen, cada una, este par de líneas:
--
--     revoke all on function ... from public;
--     grant execute on function ... to service_role;
--
-- con un comentario que dice que así la función deja de ser invocable por
-- `anon` a través de PostgREST. Ese comentario es FALSO, y se comprobó
-- consultando `proacl` en la base de producción: las cinco tenían
--
--     {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--
-- es decir, un permiso EXPLÍCITO para `anon`. Supabase corre de fábrica un
-- `alter default privileges in schema public grant all on functions to anon,
-- authenticated, service_role`, así que toda función nueva en `public` nace
-- con ese grant escrito a nombre de cada rol. `revoke ... from public` quita
-- el permiso del pseudo-rol PUBLIC —que es otra cosa— y no toca los grants
-- nominales. La línea corría sin error y no hacía nada.
--
-- POR QUÉ ESTO NO ERA UN AGUJERO ABIERTO, y por qué igual se arregla: lo que
-- de verdad está deteniendo a `anon` es que las once tablas tienen RLS
-- activo con CERO políticas —deny by default— y que ninguna de estas
-- funciones es `security definer`, así que corren con los permisos de quien
-- llama. Se verificó ejecutándolas de verdad como `anon` dentro de una
-- transacción revertida: `campanas_reclamar_pendientes` devolvió lista
-- vacía, `campanas_cerrar_tanda` devolvió 0 filas, y los `select` sobre
-- `cotizaciones`, `usuarios_panel`, `leads` y `campanas_envios` devolvieron
-- 0 filas. No se filtró nada y no se escribió nada.
--
-- Pero esa defensa es de una sola capa y depende de una condición que puede
-- cambiar sin que nadie lo note: el día que alguien agregue UNA política
-- para `anon` sobre `campanas_envios` —por ejemplo, para que la página
-- pública de baja escriba sin pasar por el servidor— estas funciones pasan a
-- ser invocables de verdad, y `campanas_cerrar_tanda` marca correos como
-- enviados sin mandarlos. La segunda capa es la que este archivo pone: que
-- el permiso no exista, en vez de existir y no servir de nada.
revoke execute on function public.usuarios_panel_intento_fallido(uuid, integer, integer, timestamptz) from anon, authenticated;
revoke execute on function public.usuarios_panel_cambiar_estado(uuid, boolean, text) from anon, authenticated;
revoke execute on function public.campanas_reclamar_pendientes(uuid, integer, timestamptz) from anon, authenticated;
revoke execute on function public.campanas_cerrar_tanda(jsonb) from anon, authenticated;

-- `obtener_numero_cotizacion` y `cotizaciones_asignar_numero` (migraciones
-- tempranas) nunca tuvieron ni siquiera el `revoke ... from public`: su acl
-- traía además el permiso de PUBLIC (`=X/postgres`). Se les quitan los dos.
revoke execute on function public.obtener_numero_cotizacion() from public, anon, authenticated;
revoke execute on function public.cotizaciones_asignar_numero() from public, anon, authenticated;

-- `cotizaciones_asignar_numero` es la función de un trigger: los triggers
-- corren con los permisos del DUEÑO de la tabla, no de quien dispara el
-- INSERT, así que quitarle el execute a `anon` no rompe el alta de
-- cotizaciones desde el servidor.
