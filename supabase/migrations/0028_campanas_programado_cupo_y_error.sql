-- supabase/migrations/0028_campanas_programado_cupo_y_error.sql
-- Dos arreglos sobre el mismo hallazgo de producción (2026-09-18, ver
-- .superpowers/sdd/direccion-invalida.md): del 10 al 18 de setiembre la
-- zona Heredia / Norte GAM no mandó un solo correo en tres días hábiles --
-- una sola dirección mal digitada en el CRM (jurodríduez@cafebritt.com)
-- trababa el lote entero contra Resend, y `ejecutarEnvioProgramado`
-- (lib/campanas/programado.ts) YA había reservado el cupo del día ANTES de
-- intentar mandar nada. El resultado medido contra la base real: 323
-- cupos reservados, 122 correos de verdad enviados -- 201 cupos quemados en
-- tres días sin mandar nada.

-- 1) Devolver el cupo cuando una tanda no manda nada de verdad -- lo que
-- `lib/campanas/programado.ts::ejecutarEnvioProgramado` llama justo
-- después de `enviarTanda`, cuando esa llamada terminó con `enviados: 0`
-- (falló la tanda entera, o todo lo reclamado resultó ser direcciones
-- inválidas). Mismo criterio de "una sola sentencia atómica" que
-- `campanas_reservar_cupo_diario` (migración 0027): acá no hace falta el
-- `select ... for update` que usa esa función (que necesita comparar
-- contra el TOPE del día antes de decidir cuánto reservar) -- devolver es
-- una resta simple, y un `update ... set enviados = enviados - N` es, de
-- por sí, una única sentencia SQL: Postgres serializa cualquier UPDATE
-- concurrente sobre la MISMA fila sin que haga falta bloquearla a mano
-- primero.
--
-- `greatest(0, ...)` es la misma guarda defensiva que ya usa
-- `campanas_reservar_cupo_diario` contra `enviados - tope`: nunca debería
-- hacer falta (nunca se devuelve más de lo que esta MISMA llamada
-- reservó), pero un negativo en `campanas_envio_diario.enviados` sería un
-- número sin sentido que además rompería la resta de
-- `campanas_reservar_cupo_diario` (`tope - enviados`) al revés -- daría MÁS
-- cupo del que debería. Fallar hacia "el cupo de hoy queda en 0", nunca
-- hacia un número negativo, es la guarda más barata.
create or replace function public.campanas_devolver_cupo_diario(
  p_fecha    date,
  p_cantidad integer
)
returns void as $$
begin
  if p_cantidad <= 0 then
    return;
  end if;

  update public.campanas_envio_diario
     set enviados = greatest(0, enviados - p_cantidad),
         actualizado_at = now()
   where fecha = p_fecha;
end;
$$ language plpgsql;

-- Mismos permisos, exactos, que `campanas_reservar_cupo_diario` (migración
-- 0027) -- ver el comentario grande junto a esos `revoke`/`grant` sobre la
-- trampa del `alter default privileges` de Supabase.
revoke all on function public.campanas_devolver_cupo_diario(date, integer) from public;
revoke execute on function public.campanas_devolver_cupo_diario(date, integer) from anon, authenticated;
grant execute on function public.campanas_devolver_cupo_diario(date, integer) to service_role;

-- 2) Que se vea. Antes de este arreglo, un envío programado que fallaba
-- tres días seguidos no dejaba ninguna huella en la pantalla -- "En curso"
-- se veía sano, y el dueño lo descubrió sacando cuentas a mano (reservados
-- vs. enviados de verdad) en vez de que el sistema se lo dijera. Estas dos
-- columnas viven en la MISMA fila única que el interruptor de pausa
-- (`campanas_programado_config`, migración 0027) -- es lo primero que se
-- lee al abrir "Historial de campañas", así que es el lugar natural para
-- que un fallo del cron se note sin ir a buscar los logs de Vercel.
--
-- `ultimo_error_at` (no sólo `ultimo_error`) porque un mensaje de error
-- sin fecha no dice si es de hoy o de hace tres semanas -- la pantalla
-- necesita las dos cosas, mismo criterio que `pausado_por`/`pausado_at` en
-- la misma tabla.
--
-- Ambas quedan `null` en la corrida SIGUIENTE que sí termina bien (ver
-- `registrarResultadoProgramado` en lib/campanas/programado.ts) -- el
-- aviso describe la ÚLTIMA corrida, no un error histórico que ya se
-- resolvió solo.
alter table public.campanas_programado_config
  add column if not exists ultimo_error    text,
  add column if not exists ultimo_error_at timestamptz;
