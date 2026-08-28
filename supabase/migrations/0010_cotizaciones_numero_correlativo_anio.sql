-- supabase/migrations/0010_cotizaciones_numero_correlativo_anio.sql
-- Corrige el número de cotización para que sea correlativo por año, no global.
-- Usa tabla de contadores con insert...on conflict para seguridad ante concurrencia.

-- Tabla de contadores por año: almacena el último número usado en cada año
create table if not exists public.cotizaciones_contadores_anio (
  anio integer primary key,
  ultimo_numero integer not null default 0,
  updated_at timestamptz not null default now()
);

-- Función para obtener el siguiente número de cotización de forma atómica
create or replace function public.obtener_numero_cotizacion()
returns text as $$
declare
  v_anio integer;
  v_numero integer;
  v_numero_formateado text;
begin
  v_anio := extract(year from now())::integer;

  -- Insert on conflict: incrementa el contador de forma atómica
  insert into public.cotizaciones_contadores_anio (anio, ultimo_numero, updated_at)
  values (v_anio, 1, now())
  on conflict (anio) do update
  set ultimo_numero = public.cotizaciones_contadores_anio.ultimo_numero + 1,
      updated_at = now()
  returning ultimo_numero into v_numero;

  -- Formato: COT-YYYY-0001
  v_numero_formateado := 'COT-' || v_anio || '-' || lpad(v_numero::text, 4, '0');

  return v_numero_formateado;
end;
$$ language plpgsql strict;

-- Trigger que asigna el número automáticamente en cada inserción
create or replace function public.cotizaciones_asignar_numero()
returns trigger as $$
begin
  if new.numero is null then
    new.numero := public.obtener_numero_cotizacion();
  end if;
  return new;
end;
$$ language plpgsql;

-- Aplicar el trigger antes de cada inserción
drop trigger if exists cotizaciones_asignar_numero_trigger on public.cotizaciones;
create trigger cotizaciones_asignar_numero_trigger
  before insert on public.cotizaciones
  for each row
  execute function public.cotizaciones_asignar_numero();

-- Remover el default anterior que no funcionaba correctamente
alter table public.cotizaciones
  alter column numero drop default;

-- Remover la secuencia anterior
drop sequence if exists cotizaciones_numero_seq;

-- Agregar NOT NULL constraint: el número siempre debe existir
alter table public.cotizaciones
  alter column numero set not null;
