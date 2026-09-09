-- supabase/migrations/0021_campanas_plantilla_personalizada.sql
-- Quinta opción de plantilla: HTML pegado a mano (encargo del dueño), en vez
-- de elegir una de las cuatro plantillas fijas del repositorio. Sólo hace
-- falta sumar el valor al `check` -- el resto del contrato (asunto,
-- preview_text, html con los marcadores sin resolver) es EXACTAMENTE el
-- mismo shape que ya usan las otras cuatro; lib/campanas/plantilla-personalizada.ts
-- es lo que, del lado de la aplicación, arma ese html a partir de lo que se
-- pegó (saneado, con el marcador de baja obligatorio) antes de que llegue
-- hasta acá.
alter table public.campanas drop constraint if exists campanas_plantilla_check;
alter table public.campanas add constraint campanas_plantilla_check
  check (plantilla in ('inicial', 'seguimiento_1', 'seguimiento_2', 'seguimiento_3', 'personalizada'));
