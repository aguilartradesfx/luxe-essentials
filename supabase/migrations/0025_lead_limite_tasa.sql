-- supabase/migrations/0025_lead_limite_tasa.sql
-- Revision final, I9: /api/lead es publica (sin autenticacion -- es la
-- entrada de clientes nuevos del sitio) y no tenia ningun control de
-- abuso: ni honeypot, ni comprobacion de origen, ni limite de tasa. Un
-- script que la llame mil veces crea mil contactos basura mezclados con
-- los 3.340 reales en el GoHighLevel del cliente, y agota la misma cuota
-- de API de la que dependen /api/campanas/zonas, /api/campanas/contactos
-- y el agente que responde conversaciones de WhatsApp en vivo.
--
-- Esta migracion es la tercera de las tres capas del arreglo (las otras
-- dos -- honeypot y comprobacion de origen -- viven en codigo, sin
-- estado). El limite de tasa SI necesita vivir en la base: cada instancia
-- de Vercel tiene su propia memoria de proceso, asi que un contador en
-- memoria no limita nada -- la siguiente peticion del mismo atacante
-- puede caer en otra instancia con el contador en cero.
--
-- Mismo patron atomico que 0013 (usuarios_panel_intento_fallido): una
-- sola sentencia hace el lee-incrementa-decide sobre la fila que Postgres
-- bloquea mientras la toca, asi que dos peticiones concurrentes de la
-- misma IP se serializan en vez de leer las dos el mismo valor viejo (el
-- mismo problema que ese archivo documenta para el lee-modifica-escribe
-- en JavaScript).
create table if not exists public.lead_limite_tasa (
  ip text primary key,
  ventana_inicio timestamptz not null,
  conteo integer not null default 1
);
alter table public.lead_limite_tasa enable row level security;

-- Devuelve `true` si la peticion entra dentro del tope, `false` si ya lo
-- superó. Ventana deslizante por reinicio: si `ventana_inicio` de la fila
-- ya venció (mas vieja que `p_ahora - p_ventana_segundos`), el conteo
-- arranca de nuevo en 1 con una ventana nueva; si no, se suma uno a la
-- ventana en curso.
--
-- La ventana y el tope los decide el TypeScript que llama
-- (lib/lead-limite-tasa.ts) -- igual que MAX_INTENTOS/BLOQUEO_MINUTOS en
-- lib/cotizador/usuarios.ts -- para que el numero viva en un solo lugar,
-- el mismo que lo prueba.
create or replace function public.lead_limite_tasa_incrementar(
  p_ip text,
  p_ahora timestamptz,
  p_ventana_segundos integer,
  p_tope integer
)
returns boolean as $$
declare
  v_conteo integer;
begin
  insert into public.lead_limite_tasa as t (ip, ventana_inicio, conteo)
  values (p_ip, p_ahora, 1)
  on conflict (ip) do update
    set conteo = case
                   when t.ventana_inicio <= p_ahora - make_interval(secs => p_ventana_segundos)
                     then 1
                   else t.conteo + 1
                 end,
        ventana_inicio = case
                   when t.ventana_inicio <= p_ahora - make_interval(secs => p_ventana_segundos)
                     then p_ahora
                   else t.ventana_inicio
                 end
  returning conteo into v_conteo;

  return v_conteo <= p_tope;
end;
$$ language plpgsql;

-- Mismo motivo que el resto de funciones rpc del proyecto (ver 0013 y
-- 0024): sin esto la funcion nace ejecutable por PUBLIC/anon via
-- PostgREST -- hoy eso no lograria nada (RLS deniega por defecto sin
-- politicas), pero depender de eso es depender de que nadie agregue una
-- politica mas adelante.
revoke all on function public.lead_limite_tasa_incrementar(text, timestamptz, integer, integer) from public;
grant execute on function public.lead_limite_tasa_incrementar(text, timestamptz, integer, integer) to service_role;
