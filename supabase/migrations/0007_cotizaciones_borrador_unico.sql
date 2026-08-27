-- La deduplicación de `registrarIntencion` (select + insert) no tiene respaldo
-- en la base: hoy funciona porque `tomarMensaje` serializa por contacto, pero
-- el arriendo dura 90 s y un turno con audio transcrito, Anthropic y GHL puede
-- acercarse a ese límite. Pasado ese punto, dos webhooks corren en paralelo y
-- los dos pasan el `select` antes de que cualquiera inserte. Este índice único
-- parcial cierra esa ventana en la base, no en la aplicación.
--
-- `registrarIntencion` ya devuelve el error sin lanzar (nunca tumba el turno),
-- así que un choque de índice sólo deja un mensaje en el log; no rompe nada.
-- De paso, hoy no había ningún índice por `contact_id` en esta tabla.
create unique index if not exists cotizaciones_borrador_por_contacto
  on public.cotizaciones (contact_id) where estado = 'borrador';
