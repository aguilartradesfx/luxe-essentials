-- supabase/migrations/0023_campanas_cerrar_tanda.sql
-- Hallazgo importante (revisión final, punto 1): `enviarTanda`
-- (lib/campanas/envio.ts) cerraba una tanda con hasta CIEN peticiones HTTP
-- sueltas -- un `.update().eq('id', ...)` por destinatario, todas en
-- paralelo con `Promise.all`. Si la función se corta a mitad de esas cien
-- (el límite de tiempo de la ruta, un despliegue, lo que sea), las filas que
-- alcanzaron a marcarse quedan 'enviado' -- correcto -- pero las que no
-- llegaron a marcarse siguen 'pendiente' con una reserva que, pasados
-- `MINUTOS_RESERVA_VENCIDA`, `campanas_reclamar_pendientes` vuelve a
-- entregar sola en una tanda futura. Resend YA les mandó el correo (el lote
-- entero se aceptó en una sola llamada) -- así que ese destinatario recibe
-- el mismo correo DOS VECES. El índice único de la migración 0019 y el
-- `skip locked` de `campanas_reclamar_pendientes` no cubren esto: los dos
-- evitan que DOS TANDAS le manden a la MISMA fila -- ninguno evita que una
-- fila que YA se mandó se vuelva a ofrecer porque nadie alcanzó a
-- cerrarla.
--
-- La garantía elegida: cerrar una tanda entera es UNA sola sentencia SQL, no
-- cien peticiones HTTP independientes. Una sentencia corre dentro de una
-- única transacción de Postgres -- o termina de aplicarse ENTERA, o (si la
-- conexión se corta a mitad) no se aplica NADA de ella; no hay un estado a
-- medias entre "50 de 100 marcadas" que antes sí era posible. Esto no
-- inventa un mecanismo nuevo: es el MISMO principio que ya usa
-- `campanas_reclamar_pendientes` para reclamar la tanda (una sola sentencia
-- atómica, no "leer en la aplicación, decidir, escribir") -- acá se aplica
-- al otro extremo de la misma tanda, cerrarla, no sólo a abrirla.
--
-- Lo que esto NO resuelve -- aceptado, documentado, y ya era así antes: si
-- la conexión se corta ENTRE que Resend aceptó el lote y que este rpc
-- corre, ninguna fila se cierra y las cien se vuelven a ofrecer pasados los
-- `MINUTOS_RESERVA_VENCIDA` -- exactamente el mismo caso, ahora reducido a
-- UN solo punto de falla (esta llamada) en vez de CIEN (cada `update`
-- suelto de antes). De cien oportunidades de cortarse a mitad de camino
-- (con duplicados parciales garantizados si eso pasaba) se pasa a una sola
-- llamada que, si falla, falla ENTERA -- sin dejar un resultado a medias.
-- Eliminar el resto de ese riesgo exigiría una clave de idempotencia del
-- lado de Resend (que la API de lote no ofrece hoy) -- fuera del alcance de
-- este arreglo.
create or replace function public.campanas_cerrar_tanda(p_resultados jsonb)
returns integer as $$
declare
  v_actualizadas integer;
begin
  update public.campanas_envios as ce
     set estado         = r.estado,
         resend_id      = r.resend_id,
         error          = r.error,
         actualizado_at = r.actualizado_at
    from jsonb_to_recordset(p_resultados) as r(
           id             uuid,
           estado         text,
           resend_id      text,
           error          text,
           actualizado_at timestamptz
         )
   where ce.id = r.id;

  get diagnostics v_actualizadas = row_count;
  return v_actualizadas;
end;
$$ language plpgsql;

-- Misma postura que `campanas_reclamar_pendientes` (migración 0019): sin
-- esto la función queda ejecutable por `PUBLIC`, y por lo tanto invocable
-- por `anon` a través de PostgREST.
revoke all on function public.campanas_cerrar_tanda(jsonb) from public;
grant execute on function public.campanas_cerrar_tanda(jsonb) to service_role;
