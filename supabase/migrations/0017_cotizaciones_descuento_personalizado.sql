-- supabase/migrations/0017_cotizaciones_descuento_personalizado.sql
-- Descuento personalizado con aprobacion (fase 5, diseno en
-- docs/superpowers/specs/2026-09-02-descuento-aprobacion-design.md). Hoy el
-- descuento sale solo de las seis escalas automaticas por cantidad; esta
-- migracion es la base de datos para que un vendedor pida uno distinto y un
-- superadmin lo apruebe, lo cambie o lo rechace antes de que la cotizacion
-- salga.

-- 'esperando_aprobacion': la cotizacion tiene un descuento personalizado
-- pedido y esta congelada -- el vendedor no la edita mientras un superadmin
-- la mira, para que el superadmin nunca apruebe algo distinto de lo que
-- tiene en pantalla (ver el diseno, seccion "El vendedor no puede editar
-- mientras espera"). Sale de este estado por tres caminos: aprobada (pasa a
-- seguir el flujo de envio normal), cancelada (vuelve a 'borrador', editable
-- de nuevo) o rechazada.
--
-- 'rechazada': el superadmin dijo que no. Queda fuera de ESTADOS_REALES en
-- lib/cotizador/metricas.ts (no se toca ese archivo en esta migracion) por
-- el mismo criterio que 'reemplazada' (migracion 0016): nunca hubo un
-- precio vigente que el cliente haya recibido, asi que no debe contar como
-- cotizado ni como ganado/perdido.
alter table public.cotizaciones drop constraint if exists cotizaciones_estado_check;
alter table public.cotizaciones add constraint cotizaciones_estado_check
  check (estado in (
    'borrador','creada','enviada','error','convertida','ganada','perdida',
    'reemplazada','esperando_aprobacion','rechazada'
  ));

alter table public.cotizaciones
  -- Lo que el vendedor pidio: `{ general: n }` o `{ familias: { <grupo>: n } }`
  -- (los grupos son los de GrupoDescuento en lib/cotizador/tipos.ts, no el
  -- campo `familia` libre del catalogo -- ver lib/validation.ts para el
  -- porque). Nunca las dos formas a la vez: son dos maneras de pedir el
  -- mismo tipo de cosa, no dos descuentos que se combinan.
  add column if not exists descuento_personalizado jsonb,
  -- El vendedor que pidio el descuento. Igual que `vendedor` (migracion
  -- 0012), se guarda el nombre y no un id: dentro de un año esta fila tiene
  -- que seguir diciendo quien lo pidio aunque esa persona ya no este.
  add column if not exists solicitado_por text,
  -- El superadmin que resolvio -- aprobo, cambio y aprobo, o rechazo. Mismo
  -- criterio de nombre-no-id que `solicitado_por`. Si quien arma la
  -- cotizacion ya es superadmin, esta columna se llena igual con su propio
  -- nombre (el diseno: "un superadmin no se pide permiso a si mismo", pero
  -- la trazabilidad no tiene huecos).
  add column if not exists aprobado_por text,
  add column if not exists resuelto_at timestamptz,
  -- Solo tiene sentido cuando la resolucion fue un rechazo.
  add column if not exists motivo_rechazo text,
  -- Lo que de verdad se aplico, si el superadmin cambio el porcentaje antes
  -- de aprobar. Se guarda APARTE de `descuento_personalizado` a proposito:
  -- lo pedido y lo concedido son dos hechos distintos, y perder el primero
  -- borra la unica evidencia de que hubo una diferencia -- es tambien lo
  -- que el correo al vendedor necesita para decir "pidio 20%, se aprobo
  -- 12%" en vez de mostrar solo el numero final.
  add column if not exists descuento_aprobado jsonb;
