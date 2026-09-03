-- supabase/migrations/0016_cotizaciones_modificar.sql
-- "Modificar" (encargo del dueño): el vendedor envía una cotización, el
-- cliente llama y acuerdan otra cosa -- hoy la única salida era "Duplicar"
-- (arma una cotización nueva, sin ningún vínculo con la anterior) y dejar
-- las dos vivas sueltas, sin relación aparente, con precios distintos para
-- el mismo hotel. "Modificar" arma esa cotización nueva reutilizando el
-- mismo contacto de GoHighLevel y deja rastro entre las dos filas.
--
-- Dos parejas de columnas, id + numero denormalizado -- mismo criterio que
-- la columna `vendedor` (migración 0012): el numero no cambia nunca después
-- de asignado (trigger de la 0010), así que copiarlo es seguro, y
-- /api/cotizacion/listado (que no hace joins, ver ese archivo) puede
-- mostrar la relación en las dos filas sin una consulta aparte -- el id
-- queda para integridad/uso futuro, el numero es lo que de verdad se
-- muestra: es lo que el cliente cita por teléfono.
--
--   - reemplaza_a / reemplaza_a_numero: en la fila NUEVA, a cuál reemplaza.
--     Se llenan en el mismo insert que crea la fila.
--   - reemplazada_por / reemplazada_por_numero: en la fila VIEJA, cuál la
--     reemplazó. Se llenan recién cuando la nueva sale de verdad (el correo
--     con el PDF salió) -- NUNCA al abrir el formulario de "Modificar" ni
--     si el envío de la nueva falla (app/api/cotizacion/route.ts). Una
--     cotización vigente no se marca reemplazada hasta que exista de verdad
--     una vigente que la reemplace -- si no, un envío fallido dejaría al
--     hotel sin ninguna cotización en pie.
alter table public.cotizaciones
  add column if not exists reemplaza_a         uuid references public.cotizaciones(id),
  add column if not exists reemplaza_a_numero   text,
  add column if not exists reemplazada_por      uuid references public.cotizaciones(id),
  add column if not exists reemplazada_por_numero text;

-- 'reemplazada': la cotización vieja que "Modificar" dejó atrás. Vive fuera
-- de 'ganada'/'perdida' a propósito -- esas dos cierran un negocio de
-- verdad, y convertirlas en 'reemplazada' les borraría el dato a las
-- métricas de ganado/perdido (lib/cotizador/metricas.ts) sin que el
-- resultado del negocio haya cambiado; si el vendedor quiere retomar un
-- trato ya cerrado con un precio distinto, es un trato nuevo, así que la
-- herramienta para eso sigue siendo "Duplicar", no "Modificar". Tampoco
-- entra 'error': ahí nunca le llegó nada válido al cliente, no hay ningún
-- precio vigente que reemplazar. Ver el comentario largo en
-- app/api/cotizacion/route.ts (ESTADOS_MODIFICABLES) para el resto del
-- criterio.
--
-- 'reemplazada' queda deliberadamente FUERA de ESTADOS_REALES en
-- lib/cotizador/metricas.ts (no se toca ese archivo en esta migración): es
-- el mismo criterio que ya protege a 'borrador'/'convertida' -- el negocio
-- que representaba esta fila lo sigue contando la fila nueva, contarla acá
-- también lo duplicaría.
alter table public.cotizaciones drop constraint if exists cotizaciones_estado_check;
alter table public.cotizaciones add constraint cotizaciones_estado_check
  check (estado in ('borrador','creada','enviada','error','convertida','ganada','perdida','reemplazada'));
