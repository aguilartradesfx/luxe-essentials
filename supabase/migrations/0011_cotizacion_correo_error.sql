-- supabase/migrations/0011_cotizacion_correo_error.sql
-- Ronda de correcciones final del panel: el diseño promete que la vista de
-- fallidas muestra "las que fallaron, con su error" — pero el error del
-- envío por Resend nunca se guardaba en ningún lado. `ghl_error` ya existía
-- para el CRM; a esta columna le falta la gemela del correo, que es el
-- envío real al cliente.
alter table public.cotizaciones
  add column if not exists correo_error text;
