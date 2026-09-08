-- supabase/migrations/0018_bajas_correo.sql
-- Bandeja de campañas (fase de diseño, antes de que la bandeja exista): las
-- cuatro plantillas ya llevan `{{unsubscribe_url}}` en el pie, apuntando a un
-- enlace que hoy no existe. Sin una baja que de verdad funcione, un envío a
-- los ~3.340 contactos de la base termina en spam -- y el dominio de envío
-- (`send.luxeessentialscr.com`) tiene una semana de vida: suficientes marcas
-- de spam lo hunden, y con él dejan de llegar hasta las cotizaciones.
--
-- Esta tabla es la lista de excluidos: a quién no volver a escribirle. El
-- enlace de baja (lib/campanas/baja.ts) es autoverificable -- lleva el correo
-- y una firma HMAC, así que el servidor lo valida sin tocar esta tabla -- y
-- por eso esta tabla no guarda tokens ni nada que verificar: sólo el hecho
-- consumado de la baja, para que `lib/campanas/exclusiones.ts` pueda filtrar
-- miles de destinatarios de una sola lectura antes de cualquier envío.
create table if not exists public.bajas_correo (
  id         uuid primary key default gen_random_uuid(),
  -- Siempre normalizado (`.trim().toLowerCase()`, mismo criterio que
  -- `usuario` en `usuarios_panel`, migración 0012) por la aplicación ANTES de
  -- llegar acá -- `lib/campanas/baja.ts` normaliza tanto al firmar el enlace
  -- como al verificarlo, y `lib/campanas/exclusiones.ts` normaliza de nuevo
  -- antes de escribir o de comparar. A diferencia de `usuarios_panel`, este
  -- correo no lo escribe nunca una persona a mano ni por un formulario
  -- suelto -- el único camino de escritura es `registrarBaja` -- así que un
  -- constraint único simple sobre la columna ya normalizada alcanza; no hace
  -- falta el índice sobre `lower(correo)` de aquella tabla.
  correo     text not null unique,
  -- Cuándo se dio de baja. Es el dato que importa para poder mostrar, si
  -- algún día hace falta, "te diste de baja el 26 de agosto de 2026" -- y el
  -- que prueba que la baja se procesó, no sólo que se pidió.
  creado_at  timestamptz not null default now(),
  -- Por qué vía llegó la baja. 'pagina': la persona abrió el enlace del pie
  -- del correo y tocó el botón de confirmar en /baja (acción explícita,
  -- nunca al sólo abrir la página -- ver el comentario grande en
  -- app/baja/PantallaBaja.tsx sobre por qué). 'un_clic': la baja de un clic
  -- que exigen Gmail y Yahoo desde 2024 (RFC 8058) -- el propio cliente de
  -- correo hizo el POST a la cabecera `List-Unsubscribe`, sin que la persona
  -- viera ninguna pantalla. Registrar la vía no es un capricho de auditoría:
  -- si algún día alguien reporta "yo no me di de baja", esta columna dice si
  -- hubo alguna acción humana de por medio o si fue el propio Gmail.
  via        text not null check (via in ('pagina', 'un_clic'))
);

-- Mismo criterio que el resto del esquema (ver `usuarios_panel`, migración
-- 0012): nadie llega acá con la llave anónima, sólo el cliente de servicio
-- del servidor.
alter table public.bajas_correo enable row level security;
