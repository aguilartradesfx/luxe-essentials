# Descuento personalizado con aprobación — diseño (fase 5)

Fecha: 2026-09-02

## El problema

Los descuentos del cotizador salen de seis escalas por cantidad, automáticas y fijas. No hay
forma de conceder un descuento distinto: ni para cerrar un hotel grande, ni para igualar una
oferta de la competencia, ni para un cliente de años.

Hoy eso se resuelve fuera del sistema —por WhatsApp, de palabra— y la cotización que recibe el
hotel dice otra cosa que la que se acordó.

## Lo que se construye

Un vendedor puede pedir un descuento fuera de escala, general o por familia de productos. La
cotización **no sale hasta que un superadmin la aprueba**, y ese superadmin puede aprobarla tal
cual, cambiar el porcentaje antes de aprobarla, o rechazarla.

## Decisiones

### El descuento personalizado reemplaza al de escala, no se suma

Sumarlos haría el precio final impredecible: un pedido de 48 unidades ya trae su descuento
automático, y un 15% "extra" encima significaría cosas distintas según la cantidad. El
descuento personalizado es **el descuento final** de las líneas que alcanza.

Puede ser menor que el de escala. No se prohíbe: hay razones comerciales para dar menos, y una
regla que lo impida terminaría estorbando en el caso raro sin proteger de nada.

### El vendedor no puede editar mientras espera

Una cotización en espera queda congelada. Puede **cancelar** la solicitud —vuelve a ser un
borrador suyo, editable— pero no cambiarla en el lugar.

El motivo: si edita mientras el superadmin la mira, el superadmin aprueba algo distinto de lo
que tiene en pantalla. Cancelar y rehacer es más largo de escribir y mucho más difícil de
equivocar.

### El superadmin se entera por correo, no por costumbre

Cuando se pide una aprobación, sale un correo a **todos los superadmin activos**, con el
cliente, el monto, el descuento pedido y un enlace al panel.

Depender de que alguien mire el panel por hábito no es un mecanismo: se erosiona en dos semanas
y nadie se da cuenta hasta que un vendedor lleva tres días esperando. Resend ya está
funcionando y es el único canal que llega a quien no está mirando la pantalla.

No se usa un workflow de GoHighLevel: esos son para eventos del cliente en el CRM, y esto es
interno del panel.

### El vendedor se entera del desenlace, y del número final

Cuando se resuelve, le sale un correo al vendedor que la pidió. Si el superadmin **cambió el
porcentaje**, el correo lo dice de forma destacada: pidió 20%, se aprobó 12%.

Sin eso, el vendedor llama al hotel a hablar de un precio que el hotel no recibió. Es el fallo
más caro de todo este flujo y el más fácil de pasar por alto.

### Un superadmin no se pide permiso a sí mismo

Si quien arma la cotización es superadmin, su descuento personalizado sale directo. Igual queda
registrado quién lo aprobó —él mismo— para que la trazabilidad no tenga huecos.

### Toda cotización con descuento personalizado pasa por aprobación

Sin umbral mínimo. Un umbral obliga a elegir un número arbitrario, y el primer caso que quede
justo debajo va a ser el que había que revisar.

## Base de datos

Sobre `cotizaciones`:

```sql
estado                 -- suma 'esperando_aprobacion' y 'rechazada'
descuento_personalizado jsonb    -- { general: n } o { familias: { <familia>: n } }
solicitado_por          text     -- el vendedor que lo pidió
aprobado_por            text     -- el superadmin que resolvió
resuelto_at             timestamptz
motivo_rechazo          text
descuento_aprobado      jsonb    -- lo que de verdad se aplicó, si cambió
```

`descuento_aprobado` se guarda aparte de `descuento_personalizado` **a propósito**: lo pedido y
lo concedido son dos hechos distintos, y perder el primero borra la única evidencia de que hubo
una diferencia.

## Riesgos declarados

**Una cotización puede quedarse esperando para siempre** si ningún superadmin la mira. El correo
lo mitiga; no lo elimina. El listado muestra cuánto lleva esperando.

**El correo puede no llegar** — el dominio de envío es nuevo. Por eso el estado también se ve en
el panel: el correo avisa, la pantalla es la fuente de verdad.

## Supuestos, para objetar

- El descuento personalizado reemplaza al de escala en las líneas que alcanza.
- El vendedor puede cancelar, no editar, mientras espera.
- Avisa por correo a todos los superadmin activos, y al vendedor cuando se resuelve.
- Un superadmin no necesita aprobación para su propia cotización.
- No hay umbral: todo descuento personalizado se aprueba.
