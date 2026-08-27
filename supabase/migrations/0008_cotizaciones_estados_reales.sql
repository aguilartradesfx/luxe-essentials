-- Ronda de correcciones 2 de la revisión final (hallazgos C1 e I1).
--
-- C1: `lib/cotizador/ghl.ts` crea el Estimate en GoHighLevel, pero nunca lo
-- envía (esa llamada no existe todavía — ver el comentario en ese archivo).
-- Guardar la fila como 'enviada' es mentir: el hotel no recibió nada. El
-- estado real de una cotización que sí se creó bien en GHL, pero que un
-- vendedor todavía tiene que abrir y mandar desde ahí, se llama 'creada'.
-- 'enviada' se deja en el check para cuando exista de verdad la llamada de
-- envío — no se borra, se le suma un vecino más preciso.
--
-- I1: un borrador que deja el agente de IA nunca se cerraba. La pantalla
-- creaba una fila nueva al enviar y dejaba la del agente en 'borrador' para
-- siempre — lo que además bloqueaba `registrarIntencion` (índice único de la
-- migración 0007) para ese contacto de por vida. 'convertida' es el estado
-- que le queda a un borrador del agente una vez que un vendedor lo usó para
-- armar una cotización real.
alter table public.cotizaciones
  drop constraint cotizaciones_estado_check;

alter table public.cotizaciones
  add constraint cotizaciones_estado_check
  check (estado in ('borrador', 'enviada', 'error', 'creada', 'convertida'));
