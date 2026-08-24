-- Candado por CONTACTO, no sólo por mensaje.
--
-- `ultimo_mensaje_id` evita responder dos veces al MISMO mensaje, pero no
-- serializa a un contacto que manda dos mensajes seguidos — que es lo normal en
-- WhatsApp, donde la gente escribe "hola" y luego "quiero uniformes". Sin esta
-- columna esos dos webhooks corren en paralelo: el cliente recibe dos
-- respuestas, y las dos escrituras de estado pisan la misma lectura perdiendo
-- el id de uno de los mensajes enviados. Ese id perdido hace que al turno
-- siguiente el propio saliente del agente parezca de un humano, y el contacto
-- quede mudo para siempre sin que nadie se entere.
alter table public.agente_conversaciones
  add column if not exists procesando_hasta timestamptz;
