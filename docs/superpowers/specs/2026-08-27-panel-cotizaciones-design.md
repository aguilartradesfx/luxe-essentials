# Panel de cotizaciones — diseño (fase 2)

Fecha: 2026-08-27
Fase anterior: `docs/superpowers/specs/2026-08-26-cotizaciones-design.md`

## Qué cambia respecto de la fase 1

La fase 1 decidió no construir un panel porque GoHighLevel ya era uno. Esa decisión se
revierte, y por una razón concreta: **el panel se embebe dentro de GoHighLevel como un
ítem del menú.** La objeción de fondo era que un panel propio sería una isla que nadie
abre; embebido, el equipo no cambia de herramienta.

Y arrastra una consecuencia que resuelve el mayor problema pendiente: **si el documento y
el correo son nuestros, desaparece el bloqueo del envío automático.** La fase 1 no envía
porque nadie verificó si la vista de GoHighLevel le muestra al cliente un botón de pagar,
que Luxe prohibió expresamente. Con documento propio esa pregunta deja de existir.

## El reparto

| Sistema | De qué es dueño |
|---|---|
| **El panel** | Las cotizaciones: documento, estado, montos, métricas. Fuente de verdad. |
| **GoHighLevel** | El cliente: contacto, oportunidad, seguimiento comercial. |
| **El enlace entre ambos** | Una nota en el contacto con el vínculo a la cotización, y en el panel un vínculo a la ficha del contacto. |

Esto elimina la ambigüedad que la fase 1 arrastraba, donde dos sistemas se disputaban el
estado de una cotización. Cada uno manda en lo suyo.

## Se retira el Estimate de GoHighLevel

Con PDF propio y envío propio, el Estimate queda como un tercer documento que nadie abre.
Se elimina.

**Pero se retira último, no primero.** Entre quitar el Estimate y tener funcionando el PDF
y el correo hay una ventana donde el cotizador calcula bien y no existe forma de hacerle
llegar nada al cliente. El orden es: construir el reemplazo, verificarlo, y después
retirar.

Lo que se conserva de la integración actual: la creación y el enriquecimiento del contacto
(`resolverContacto`, que respeta los tags de la base comercial) y la oportunidad en el
pipeline. Eso GoHighLevel lo hace bien.

Lo que se pierde y se reemplaza a mano: que el cliente acepte con un clic. Ver "Ganada o
perdida".

## Decisiones técnicas

### El PDF se genera con `@react-pdf/renderer`

Las librerías que renderizan abriendo un navegador (Puppeteer, Playwright) no entran bien
en funciones serverless: pesan cientos de megas, rozan el límite de bundle de Vercel y
fallan de formas difíciles de diagnosticar. `@react-pdf/renderer` es JavaScript puro, corre
en Node sin navegador, y da control tipográfico real.

El costo: usa su propio motor de layout, no HTML y CSS. El documento se diseña para esa
herramienta, no se convierte desde una página web.

### El PDF vive en Supabase Storage

Bucket **privado** `cotizaciones`, una carpeta por año. El correo lleva el PDF adjunto y
además un enlace firmado de larga duración, para quien prefiera abrirlo en el navegador.

Privado y no público: es el detalle de precios de un cliente concreto. Un bucket público
con nombres adivinables expone cotizaciones ajenas.

### El correo sale por Resend

Con el PDF adjunto. Requiere configurar SPF y DKIM en el dominio de Luxe — sin eso las
cotizaciones caen en spam, y ese trabajo pasa a ser responsabilidad nuestra, no de
GoHighLevel.

Resend reporta aperturas. No es lo mismo que "vio la cotización", pero es la señal más
cercana que vamos a tener.

### La sesión se guarda en una cookie

Hoy la clave viaja en el cuerpo de cada petición. Embebido en GoHighLevel eso es inviable:
el vendedor tendría que escribirla en cada carga.

Al validar la clave se emite una cookie `httpOnly`, `secure`, `sameSite=none` —obligatorio
para que funcione dentro de un iframe— con vigencia de 30 días. Los endpoints la aceptan
además de la clave en el cuerpo, para no romper lo que ya existe.

`sameSite=none` tiene una consecuencia que hay que declarar: la cookie viaja en peticiones
de otros sitios. Se mitiga con un token anti-CSRF en las peticiones que escriben.

### Se sirve dentro de un iframe

GoHighLevel abre el menu link en un marco. Eso exige `frame-ancestors` que permita los
dominios de GoHighLevel, y sólo esos. La configuración por defecto de Next.js lo bloquea.

## La pantalla

El panel **absorbe `/cotizador`**: no son dos pantallas, es una con tres vistas.

**Crear.** Lo que hoy existe, más teléfono y dirección del cliente. Al confirmar: se
calcula, se genera el PDF, se manda el correo, se guarda todo y se deja la nota en el
contacto de GoHighLevel.

**Listado.** Cliente, monto, fecha, vigencia y estado. Filtro por estado. Por cada fila:
ver el PDF, reenviar, duplicar como base de una nueva, ir a la ficha del contacto en
GoHighLevel, y marcar ganada o perdida.

**Métricas.** Las seis de abajo.

### Ganada o perdida

Nadie le dice hoy al sistema si el hotel aceptó. Sin eso, el panel informa cuánto se cotizó
y nunca cuánto se vendió — que es la única pregunta que de verdad importa.

Dos botones por cotización, que el vendedor marca cuando el cliente responde. Es lo más
barato que desbloquea la métrica entera. Si más adelante el cliente acepta desde el correo,
esos mismos estados se llenan solos y el trabajo manual desaparece sin rehacer nada.

## Las métricas

El criterio de selección: **cada número tiene que decirle a alguien qué hacer hoy.** Lo que
sólo informa, no entra.

1. **Cotizado sin respuesta, por antigüedad**, con el monto y cuáles vencen esta semana. Es
   lo más accionable: le dice al vendedor a quién llamar hoy.
2. **Ganado y perdido por mes**, y cuánto tarda en promedio entre enviar y cerrar.
3. **Descuento otorgado**: total y promedio. Los descuentos son 5% y 10% y el monto exacto
   ya está calculado y guardado en cada cotización. Si el promedio sube, el margen se
   erosiona sin que nadie lo note.
4. **Qué se cotiza**: productos más pedidos, y reparto entre uniformes y hogar, en unidades
   y en dinero. Sirve para producción, no sólo para ventas.
5. **Las que fallaron**, con su error y un botón de reintentar. Hoy son invisibles.
6. **Origen**: cuántas nacieron del agente de WhatsApp y cuántas de un vendedor. Responde si
   el agente aporta cotizaciones reales o sólo conversaciones.

Quedan fuera a propósito: ticket promedio (se deduce y no dispara ninguna acción), gráficos
de tendencia, y embudos por etapa — para eso está el pipeline de GoHighLevel.

## Base de datos

Sobre `public.cotizaciones`, que ya existe:

```sql
alter table public.cotizaciones
  add column if not exists pdf_ruta      text,        -- ruta en Supabase Storage
  add column if not exists enviado_at    timestamptz, -- cuándo salió el correo
  add column if not exists resend_id     text,        -- para rastrear entrega y apertura
  add column if not exists cerrada_at    timestamptz,
  add column if not exists motivo_cierre text;        -- por qué se perdió, si se perdió
```

Y el `check` de `estado` suma `ganada` y `perdida`.

`lineas` y `totales` siguen guardando el resultado del cálculo, no una referencia al
catálogo: una cotización de hace tres meses se reimprime con los precios de ese día.

## Errores

Se mantiene el orden de la fase 1: **primero la base, después todo lo demás.** La fila
existe antes de generar el PDF, mandar el correo o tocar GoHighLevel. Si algo de eso falla,
la cotización es recuperable y aparece en la vista de fallidas con su botón de reintentar
— que es justo lo que hoy no existe.

Ningún fallo de GoHighLevel invalida una cotización que ya se envió al cliente. El correo
es lo que le importa al hotel; la nota en el CRM es conveniencia interna.

## Riesgos declarados

**La entrega del correo pasa a ser nuestra.** Hoy la pone GoHighLevel. Un dominio mal
configurado manda las cotizaciones a spam y nadie se entera hasta que un cliente reclama.
Hay que verificar la entrega antes de retirar el Estimate.

**El diseño del PDF es una pieza de venta, no un formulario.** Es el argumento entero por
el que se abandona la plantilla de GoHighLevel. Si sale mediocre, no valió la pena el
cambio.

**El panel embebido depende de que GoHighLevel permita el iframe.** Si su política lo
bloquea, el menu link abre en pestaña nueva. Funciona igual, pero se pierde la sensación de
estar dentro del CRM, que era el argumento a favor del panel.

## Supuestos, para objetar

- El PDF se diseña con `@react-pdf/renderer`, no como página web convertida.
- El bucket es privado y el correo lleva adjunto más enlace firmado.
- La sesión dura 30 días.
- El panel reemplaza a `/cotizador`; no conviven dos pantallas.
- El Estimate de GoHighLevel se retira al final, verificado el reemplazo.
- Marcar ganada o perdida es manual en esta fase.
