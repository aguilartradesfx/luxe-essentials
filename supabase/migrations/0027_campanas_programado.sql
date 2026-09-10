-- supabase/migrations/0027_campanas_programado.sql
-- Envío programado de la bandeja de campañas: un cron de Vercel (ver
-- vercel.json y app/api/campanas/cron/route.ts) dispara de lunes a viernes,
-- una vez al día, sin que nadie tenga que dejar la pestaña abierta. Este
-- archivo pone en la base las dos piezas de estado que lib/campanas/programado.ts
-- necesita y que NO pueden vivir sólo en memoria del proceso -- un cron de
-- Vercel es una función nueva cada vez que corre, sin memoria entre
-- invocaciones, y un reintento del mismo día (Vercel reintentando, un
-- despliegue en el medio) tiene que ver el estado que dejó la corrida
-- anterior, no arrancar de cero:
--
--   1. `campanas_programado_config`: el interruptor de apagado de
--      emergencia (encargo, punto 6) -- una fila única que dice si el cron
--      está pausado. Nada que desplegar para pararlo: se escribe desde la
--      pantalla (Historial de campañas) con un clic.
--   2. `campanas_envio_diario`: el cupo de la rampa (encargo, punto 2) -- una
--      fila por día calendario en que el cron corrió, con el tope de ESE
--      día y cuántos correos ya se reservaron contra ese tope.
--
-- El tope de cada día (25/50/75/100 según la rampa) lo calcula la
-- APLICACIÓN (`topeParaDia`, lib/campanas/programado.ts) y no esta
-- migración: la tabla de rampa vive en un solo lugar, TypeScript, donde se
-- puede probar por mutación con Vitest -- duplicarla acá en PL/pgSQL la
-- pondría en dos lugares que se desincronizan en cuanto alguien cambie un
-- número en uno y se olvide del otro. El rpc de abajo sólo CONTABILIZA: le
-- llega el tope ya decidido, y su único trabajo es que dos llamadas
-- concurrentes el mismo día nunca reserven, juntas, más de lo que ese tope
-- permite.

-- 1) El interruptor -- fila única (id siempre 1, forzado por el `check`).
create table if not exists public.campanas_programado_config (
  id             integer primary key default 1,
  pausado        boolean not null default false,
  -- Quién tocó el interruptor por última vez y cuándo -- para que la
  -- pantalla pueda decir "pausado por Ana el 9 de setiembre", no sólo
  -- "pausado". `null` hasta el primer cambio manual.
  pausado_por    text,
  pausado_at     timestamptz,
  actualizado_at timestamptz not null default now(),
  constraint campanas_programado_config_fila_unica check (id = 1)
);

alter table public.campanas_programado_config enable row level security;

-- Se siembra la fila única acá, en la migración -- no en el primer arranque
-- de la aplicación -- para que `lib/campanas/programado.ts::estaPausado`
-- pueda esperar SIEMPRE encontrar esta fila (y fallar cerrado, tratándolo
-- como pausado, si por lo que sea no la encuentra -- ver el comentario
-- grande de esa función). Arranca sin pausar: activar el envío programado
-- es una decisión de despliegue (vercel.json), no de esta migración.
insert into public.campanas_programado_config (id, pausado)
values (1, false)
on conflict (id) do nothing;

-- 2) El cupo diario de la rampa.
create table if not exists public.campanas_envio_diario (
  fecha          date primary key,
  -- El tope de ESTE día, fijado la primera vez que alguna llamada tocó esta
  -- fila (ver el rpc de abajo) -- inmutable después de esa primera
  -- escritura, aunque una llamada posterior mande un `p_tope` distinto.
  tope           integer not null,
  enviados       integer not null default 0,
  actualizado_at timestamptz not null default now()
);

alter table public.campanas_envio_diario enable row level security;

-- Reserva, de forma atómica, hasta `p_solicitado` cupos del día `p_fecha`,
-- sin pasarse nunca del tope de ese día -- y devuelve cuánto se pudo
-- reservar de verdad (puede ser menos que lo pedido, o cero).
--
-- POR QUÉ ESTO Y NO "LEER EN LA APLICACIÓN, RESTAR, ESCRIBIR": el mismo
-- argumento, exacto, que ya sostiene `campanas_reclamar_pendientes`
-- (migración 0019) para la tanda -- un reintento del cron el MISMO día
-- (Vercel reintentando la invocación, un despliegue que interrumpe la
-- anterior a mitad) tiene que ver el cupo YA gastado por la corrida
-- anterior, no una lectura de `enviados` que quedó vieja apenas esa
-- primera corrida empezó a escribir. Con "leer y luego escribir" repartido
-- en la aplicación, dos invocaciones que leen `enviados` casi a la vez
-- verían el MISMO valor viejo y las dos reservarían cupo lleno -- el cupo
-- del día terminaría duplicado. Acá, en cambio, las dos invocaciones
-- entran a la MISMA sentencia SQL, que serializa el acceso a la fila con
-- `for update`: la segunda invocación queda esperando a que la primera
-- termine (commitee) antes de poder leer `enviados`, así que siempre ve el
-- valor ya actualizado por la primera -- nunca parte del mismo cero que
-- ella.
--
-- El `insert ... on conflict (fecha) do nothing` de arriba tiene la misma
-- garantía para el caso más angosto todavía: DOS invocaciones que llegan
-- casi a la vez el PRIMER día que se toca una fecha nueva (ninguna fila
-- todavía). Postgres bloquea el `insert` de la segunda contra la fila que
-- la primera insertó hasta que la primera confirma -- así que la segunda
-- nunca inserta una fila propia con SU tope calculado aparte: siempre
-- termina viendo (y usando) la fila que ganó la primera. El tope que
-- persiste es el de quien llegó primero, siempre -- nunca un empate.
create or replace function public.campanas_reservar_cupo_diario(
  p_fecha      date,
  p_tope       integer,
  p_solicitado integer
)
returns integer as $$
declare
  v_tope     integer;
  v_enviados integer;
  v_reserva  integer;
begin
  if p_solicitado <= 0 then
    return 0;
  end if;

  insert into public.campanas_envio_diario (fecha, tope, enviados)
  values (p_fecha, greatest(0, p_tope), 0)
  on conflict (fecha) do nothing;

  select tope, enviados into v_tope, v_enviados
    from public.campanas_envio_diario
   where fecha = p_fecha
     for update;

  v_reserva := greatest(0, least(p_solicitado, v_tope - v_enviados));

  update public.campanas_envio_diario
     set enviados = enviados + v_reserva,
         actualizado_at = now()
   where fecha = p_fecha;

  return v_reserva;
end;
$$ language plpgsql;

-- Permisos. OJO con la trampa que documenta la migración 0024: el
-- `revoke all ... from public` que traían 0019/0020/0023 **no hacía nada**
-- contra `anon`. Supabase corre de fábrica un `alter default privileges in
-- schema public grant all on functions to anon, authenticated,
-- service_role`, así que toda función nueva nace con un permiso NOMINAL
-- para `anon`; quitarle el permiso al pseudo-rol PUBLIC es otra cosa y deja
-- ese grant intacto. Por eso acá se nombra a los dos roles de forma
-- explícita, como quedó en 0024 -- si sólo se revocara de `public`, esta
-- función quedaría invocable por la llave pública que va en el navegador.
revoke all on function public.campanas_reservar_cupo_diario(date, integer, integer) from public;
revoke execute on function public.campanas_reservar_cupo_diario(date, integer, integer) from anon, authenticated;
grant execute on function public.campanas_reservar_cupo_diario(date, integer, integer) to service_role;

-- 3) La marca que distingue una campaña que armó SOLO el cron de una que
-- armó una persona desde la pantalla. `lib/campanas/programado.ts` la usa
-- para encontrar "la campaña de la zona actual" por columna -- nunca por
-- `creado_por` (que ya es un texto libre con el nombre de un vendedor
-- humano en el resto de las campañas, y usarlo también acá para identificar
-- al cron sería sobrecargar ese campo con dos significados distintos).
-- `not null default false` es seguro sobre las filas YA existentes (a
-- diferencia de `zona`, migración 0022, que no tenía ningún valor correcto
-- que inventarles): toda campaña de antes de hoy la armó una persona, así
-- que `false` es el valor correcto para todas, no un relleno arbitrario.
alter table public.campanas
  add column if not exists programada boolean not null default false;
