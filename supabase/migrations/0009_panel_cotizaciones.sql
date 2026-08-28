-- supabase/migrations/0009_panel_cotizaciones.sql
-- El panel pasa a ser la fuente de verdad de las cotizaciones: necesita saber
-- dónde vive el PDF, cuándo salió el correo y cómo terminó la negociación.

alter table public.cotizaciones
  add column if not exists pdf_ruta      text,
  add column if not exists enviado_at    timestamptz,
  -- Id de Resend: es lo único que permite rastrear si el correo se entregó y
  -- si el cliente lo abrió. Sin esto, "se envió" es un acto de fe.
  add column if not exists resend_id     text,
  add column if not exists cerrada_at    timestamptz,
  add column if not exists motivo_cierre text;

-- `ganada` y `perdida` las marca un vendedor a mano cuando el cliente responde.
-- Sin ellas el panel informa cuánto se cotizó y nunca cuánto se vendió.
alter table public.cotizaciones drop constraint if exists cotizaciones_estado_check;
alter table public.cotizaciones add constraint cotizaciones_estado_check
  check (estado in ('borrador','creada','enviada','error','convertida','ganada','perdida'));

-- El listado ordena por fecha descendente sin filtrar por origen, así que el
-- índice tampoco filtra: uno parcial que no cubre la consulta es peso muerto.
create index if not exists cotizaciones_creadas_idx
  on public.cotizaciones (created_at desc);

-- El número que el cliente cita cuando llama a preguntar. Correlativo de
-- verdad, no un fragmento del id: `COT-2026-a3f9b2c1` en el documento que
-- recibe un hotel no es un número de cotización, es ruido.
create sequence if not exists cotizaciones_numero_seq;

alter table public.cotizaciones
  add column if not exists numero text unique
    default 'COT-' || to_char(now(), 'YYYY') || '-' ||
            lpad(nextval('cotizaciones_numero_seq')::text, 4, '0');
