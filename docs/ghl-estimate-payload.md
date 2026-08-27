# Estimate de GoHighLevel: cuerpo verificado contra la API real

**Fecha de la prueba:** 2026-08-26/27 (hora de creación real en GHL: `2026-08-27T03:44:48Z`).
**Script:** `scripts/verificar-estimate-ghl.mjs` (`node --env-file=.env.local scripts/verificar-estimate-ghl.mjs`).
**Location de prueba:** el de producción de Luxe Essentials (`LUXE_GHL_LOCATION_ID`).

**Alcance de lo probado — importante:** todo lo de este documento se verificó
contra el endpoint de **creación** (`POST /invoices/estimate`) y su respuesta
JSON. Eso confirma que **crear y emitir el Estimate no requiere pasarela de
pago a nivel de API**. Pero **no** se probó qué ve el cliente cuando la
cotización se **envía y él la abre**: esa vista depende de la configuración de
payments del location y del template en GoHighLevel, y no viaja en el JSON de
creación. Esta tarea tenía prohibido enviar nada a un correo real, así que ese
punto queda **pendiente de verificación manual** — ver la sección "Lo que
falta verificar a mano" al final de este documento.

Se crearon **dos** Estimates de prueba durante la exploración (`estimateNumber` 4 y 5,
`_id` `6a8fb28373a566c909005b3c` y `6a8fb2b0816b79f4fb264806`) y **ambos quedaron
borrados** (`deleted: true` confirmado en la respuesta del DELETE, y `GET
/invoices/estimate/list` devuelve `{"estimates":[],"total":0}` después de la corrida
final). No quedó ningún Estimate huérfano. No se llamó a ningún endpoint de envío
(`send`); no se asoció el Estimate a ningún contacto real.

## Respuesta a las tres preguntas del brief

### 1. ¿Se puede emitir sin empujar al cliente a una pasarela de pago?

**Confirmado para la creación. Pendiente para la vista del cliente.**

Lo que sí se probó: la respuesta del `POST /invoices/estimate` no trae ningún
campo de `paymentMethods`, `payNow`, `payment`, `gateway`, ni similar. Las
claves de la raíz de la respuesta son exactamente:

```
altType, altId, companyId, name, businessDetails, estimateStatus, estimateNumber,
currency, contactDetails, issueDate, expiryDate, termsNotes, discount, items,
deleted, automaticTaxesCalculated, title, total, estimateActionHistory, liveMode,
frequencySettings, totalamountInUSD, attachments, configuration, _id, createdAt,
updatedAt, __v, traceId
```

Nada ahí referencia un método de cobro, y el Estimate queda en
`estimateStatus: "draft"` — no se envía nada al crear, coincide con la
restricción de "crear no es enviar".

Lo que **no** se probó: qué ve el cliente en la vista pública cuando la
cotización se envía y la abre. Esa vista depende de la configuración de
Payments del location y del template usado, ninguno de los cuales viaja en el
JSON de creación — así que un JSON "limpio" de campos de pago no garantiza por
sí solo que la vista del cliente esté igual de limpia. Verificar esto de forma
automatizada exigiría enviar una cotización de verdad a una dirección real (o
al menos disparar el flujo de envío), algo que esta tarea tenía explícitamente
prohibido hacer contra producción. Por eso este punto queda como una
verificación manual de una sola vez — ver "Lo que falta verificar a mano" al
final del documento — antes de dar por cerrado el enfoque completo.

### 2. ¿Cuál es el cuerpo exacto que la API acepta?

El cuerpo del brief **no fue aceptado tal cual**. Se iteró hasta encontrar uno
válido. Este es el que produjo `201`:

```json
{
  "altId": "<LUXE_GHL_LOCATION_ID>",
  "altType": "location",
  "name": "PRUEBA — borrar",
  "title": "Cotización de prueba",
  "currency": "CRC",
  "liveMode": false,
  "businessDetails": { "name": "Luxe Essentials" },
  "contactDetails": {
    "id": "000000000000000000000000",
    "name": "Prueba Automatizada",
    "email": "prueba@example.invalid"
  },
  "items": [
    {
      "name": "Filipina tradicional manga corta",
      "currency": "CRC",
      "amount": 15500,
      "qty": 24,
      "type": "one_time"
    }
  ],
  "discount": { "type": "percentage", "value": 5 },
  "issueDate": "2026-08-26",
  "expiryDate": "2026-09-25",
  "termsNotes": "Cotización de prueba automatizada. No representa un pedido real.",
  "frequencySettings": { "enabled": false }
}
```

Diferencias contra el cuerpo propuesto en el brief, descubiertas por iteración
contra los mensajes de error de la API (no adivinadas):

| Campo | Brief original | Lo que la API exige | Error que lo reveló |
|---|---|---|---|
| `contactDetails.id` | `null` | string no vacío (sin restricción de longitud comprobada — ver nota abajo) | 422: `contactDetails.id should not be empty`, `contactDetails.id must be a string` |
| `frequencySettings` | no existía | objeto obligatorio con `enabled: boolean` | 422: `frequencySettings should not be empty` → luego `frequencySettings.enabled should not be empty`, `... must be a boolean value` |
| `title` | no existía (solo `name`) | obligatorio a nivel de esquema de Mongo, aunque el DTO no lo pida | 500 (validación de mongoose, no del DTO): `title: Path 'title' is required.` |
| `items[].type` | no existía | enum obligatorio; `"service"` **no** es válido, `"one_time"` sí | 500 → `items.0.type: Path 'type' is required.` → luego 422: `items.0.type must be a valid enum value` |

Puntos importantes para la Tarea 7 (implementación):

- **`contactDetails.id` es obligatorio (string no vacío) pero la API no valida
  que exista un contacto real con ese id, ni le exige un formato o longitud
  determinada.** Se probó explícitamente con un ObjectId ficticio de 24 ceros,
  con un id de un solo caracter (`"x"`) y con un id corto alfanumérico
  (`"abc123"`) — los tres fueron aceptados con `201`. La única regla
  confirmada por los mensajes de error es "no vacío" + "debe ser string"; no
  hay evidencia de que la API exija formato ObjectId. En producción, la Tarea
  7 deberá decidir: o bien crear/reusar un contacto real de GHL antes del
  Estimate (probablemente lo correcto, para que quede asociado al cliente en
  el CRM), o usar un id no vinculante. Este punto queda abierto para esa
  tarea — esta sonda solo confirma qué acepta la API, no qué conviene hacer.
- **`businessDetails`, `discount`, `termsNotes`, moneda `CRC` y las fechas
  (`issueDate`/`expiryDate` como `YYYY-MM-DD`) del brief se aceptaron tal
  cual.** No hubo que tocarlos.
- El error 500 (`estimates validation failed: ...`) es un fallo de validación
  de Mongoose que se filtra sin pasar por el DTO de NestJS — es decir, se puede
  pasar la validación del "controller" (422) y aun así fallar más abajo con
  500. No asumir que un 500 es un problema de red/servidor: leer el mensaje,
  igual que con los 422.

### 3. ¿Qué devuelve?

Respuesta completa del `POST` exitoso (recortada solo en el `traceId`, que
cambia en cada llamada):

```json
{
  "altType": "location",
  "altId": "<LUXE_GHL_LOCATION_ID>",
  "companyId": "cnKny2ektFPRpPLw4AOb",
  "name": "PRUEBA — borrar",
  "businessDetails": { "name": "Luxe Essentials" },
  "estimateStatus": "draft",
  "estimateNumber": 5,
  "currency": "CRC",
  "contactDetails": {
    "id": "000000000000000000000000",
    "name": "Prueba Automatizada",
    "email": "prueba@example.invalid"
  },
  "issueDate": "2026-08-26T06:00:00.000Z",
  "expiryDate": "2026-09-26T05:59:59.999Z",
  "termsNotes": "Cotización de prueba automatizada. No representa un pedido real.",
  "discount": { "type": "percentage", "value": 5 },
  "items": [
    {
      "name": "Filipina tradicional manga corta",
      "currency": "CRC",
      "amount": 15500,
      "qty": 24,
      "taxes": [],
      "type": "one_time",
      "taxInclusive": false,
      "attachments": [],
      "_id": "6a8fb2b0816b79f4fb264807"
    }
  ],
  "deleted": false,
  "automaticTaxesCalculated": false,
  "title": "Cotización de prueba",
  "total": 353400,
  "estimateActionHistory": [],
  "liveMode": false,
  "frequencySettings": { "enabled": false },
  "totalamountInUSD": 777.41,
  "attachments": [],
  "configuration": { "precision": 4 },
  "_id": "6a8fb2b0816b79f4fb264806",
  "createdAt": "2026-08-27T03:44:48.047Z",
  "updatedAt": "2026-08-27T03:44:48.047Z",
  "__v": 0
}
```

Puntos concretos que pedía el brief:

- **El id viene en `_id`**, no en `id` (`"_id": "6a8fb2b0816b79f4fb264806"`).
  Cada línea de `items[]` también trae su propio `_id`.
- **`estimateNumber` sí viene asignado automáticamente** por GHL (`5` en esta
  corrida; se incrementa por location, no reinicia por prueba — la corrida
  anterior había dejado el contador en `4`). No hace falta llamar a
  `/invoices/estimate/number/generate` antes de crear: el número lo pone el
  propio `POST`.
- **No aparece ningún campo de pasarela, `paymentMethods` ni `payNow`.**
  Confirma la respuesta a la pregunta 1.
- `estimateStatus` queda en `"draft"` al crear (coherente con que crear no es
  enviar).
- `total` viene en la unidad mínima de la moneda tal como se mandó
  (`15500 × 24 = 372000`, menos 5% de descuento = `353400`) — GHL calculó el
  descuento porcentual correctamente sobre el total de líneas.
- `totalamountInUSD` es un campo de conversión informativa que agrega GHL por
  su cuenta (no se pidió); no afecta el cobro real, es solo referencia interna
  de GHL.
- `configuration: { precision: 4 }` es un campo interno de GHL, no se mandó en
  el request.

## Hallazgo operativo: el DELETE no funciona como en el brief

El brief proponía borrar con `altId`/`altType` como **query string**:

```
DELETE /invoices/estimate/:id?altId=...&altType=location
```

Esto devuelve **422** (`altId must be a string`, `altId should not be empty`,
`altType must be a valid enum value`, `altType should not be empty`) — la API
ignora la query string para el DELETE. El borrado exige `altId`/`altType` en el
**body** de la request:

```
DELETE /invoices/estimate/:id
Content-Type: application/json

{ "altId": "<LUXE_GHL_LOCATION_ID>", "altType": "location" }
```

Con esto, el DELETE devuelve `200` y el objeto de respuesta trae `deleted:
true`. Esto es importante para la Tarea 7 si en algún punto necesita revertir
o limpiar un Estimate mal generado.

Durante la exploración, el primer intento de borrado (con query string, según
el brief) falló con 422 y dejó momentáneamente huérfano el Estimate
`6a8fb28373a566c909005b3c` (`estimateNumber: 4`). Se detectó de inmediato y se
borró manualmente con el formato correcto (body) en la misma sesión — **no
quedó ningún Estimate huérfano al finalizar la tarea**, confirmado con `GET
/invoices/estimate/list` (`{"estimates":[],"total":0}`).

## Cómo declara impuestos GoHighLevel (Ronda de correcciones 1)

Sondeado con el mismo cuidado que el resto: cada intento creó como máximo un
Estimate de prueba, se inspeccionó, y se borró en el mismo bloque
`try/finally` antes de pasar al siguiente. No se envió nada a nadie. Todos los
Estimates de esta sección quedaron borrados (confirmado al final con `GET
/invoices/estimate/list` → `{"estimates":[],"total":0}`).

### ¿Existe `items[].taxes` y qué forma tiene?

Sí existe, pero **no acepta solo `name` + `rate`** — pide un `_id` (string) por
cada impuesto de la línea:

```json
{
  "items": [
    {
      "name": "Filipina tradicional manga corta",
      "currency": "CRC",
      "amount": 15500,
      "qty": 24,
      "type": "one_time",
      "taxes": [
        { "_id": "000000000000000000000000", "name": "IVA", "rate": 13 }
      ]
    }
  ]
}
```

El primer intento sin `_id` dio 422 (`items.0.taxes.0._id should not be
empty`). Al igual que con `contactDetails.id`, se probó con un `_id` ficticio
y la API lo aceptó sin validar que corresponda a un impuesto real
precreado — pero esto sugiere que en el uso normal de GoHighLevel, los
impuestos son entidades con su propio `_id` (se crean una vez en el location y
se referencian por id), no un `rate` libre por cada Estimate. Se intentó leer
la lista de impuestos del location (`GET /locations/:id/taxes`,
`GET /invoices/taxes`, `GET /invoices/tax`) para confirmarlo: la primera dio
404 (no existe esa ruta), y las otras dos dieron **500 "Internal server
error"** de forma consistente — no se pudo determinar por lectura si existe un
catálogo de impuestos del location ni cómo administrarlo vía API. Es un cabo
suelto que no se pudo cerrar sin escribir más contra producción o sin acceso a
la UI de GoHighLevel.

### ¿Hay forma de declarar una tasa por línea o solo global?

Por línea, vía `items[].taxes[]` (arriba). No se encontró un campo de tasa de
impuesto a nivel global del Estimate — el único campo global relacionado con
dinero es `discount`.

### Lo más importante: ¿GoHighLevel recalcula el total, o respeta el nuestro?

**Recalcula, y con decimales.** Evidencia concreta, con `_id` de prueba
`6a8fb4737bc5676d41dec94e` (creado y borrado en la corrida):

- Item: `amount: 15500`, `qty: 24`, `taxes: [{ rate: 13 }]`, `discount:
  { type: "percentage", value: 5 }`.
- Cálculo manual: `15500 × 24 = 372000` → menos 5% = `353400` → más 13% =
  `399342`.
- `total` devuelto por la API: **`399342`** — coincide, porque en este caso
  los números daban exactos.

Para confirmar si esto es coincidencia de redondeo o recálculo real, se probó
con números que **no** dan un resultado entero (`_id` de prueba
`6a8fb48c7bc5676d41decc23`, creado y borrado): `amount: 333`, `qty: 1`, sin
descuento, `taxes: [{ rate: 13 }]`. Cálculo manual: `333 × 1.13 = 376.29`. La
API devolvió **`total: 376.29`** — un decimal, no un entero de colones.

**Esto es la confirmación que pedía la ronda de corrección: GoHighLevel
calcula el `total` por su cuenta a partir de `amount`, `qty`, `discount` y
`taxes[].rate`, y ese cálculo puede producir centavos.** Si el motor de
precios de Luxe calculó un total entero con su propia regla de redondeo (medio
hacia arriba sobre el precio unitario ya descontado) y se lo dejamos recalcular
a GoHighLevel vía `rate`, **el total que ve el cliente en el Estimate puede no
coincidir con el que calculó nuestro motor.**

Hay un segundo problema, independiente del anterior: el `discount` global del
Estimate se aplica a **todos** los items, no solo a los productos. Se probó
agregando el IVA como una línea más (`amount: 45942`, ya calculado por
nosotros) junto al producto, con `discount: { type: "percentage", value: 5 }`
a nivel de Estimate (`_id` de prueba `6a8fb49c7bc5676d41decdf0`, creado y
borrado). Resultado: `total: 397044.9` — la API aplicó el 5% de descuento
también sobre la línea de IVA (`(372000 + 45942) × 0.95 = 397044.9`), un
número que no tiene sentido ni como dinero (decimal) ni como cotización
(el IVA no debería descontarse).

**La combinación que sí produjo el total exacto esperado, sin decimales ni
descuentos indebidos** (`_id` de prueba `6a8fb4c153d1e88aea90d54d`, creado y
borrado): enviar los **montos unitarios ya con el descuento aplicado** por
nuestro motor, agregar el IVA como una **línea más con el monto entero ya
calculado**, y fijar `discount: { type: "percentage", value: 0 }` a nivel de
Estimate (el campo es obligatorio — no se puede omitir — pero se puede poner
en cero para neutralizarlo):

```json
{
  "items": [
    { "name": "Filipina tradicional manga corta (precio ya con 5% desc.)", "currency": "CRC", "amount": 14725, "qty": 24, "type": "one_time" },
    { "name": "IVA (13%)", "currency": "CRC", "amount": 45942, "qty": 1, "type": "one_time" }
  ],
  "discount": { "type": "percentage", "value": 0 }
}
```

`total` devuelto: **`399342`** — exacto, entero, igual al calculado a mano.

### Lectura y recomendación

**No usar `items[].taxes` con `rate`, ni el `discount` global de GoHighLevel,
para ninguna cifra que tenga que coincidir centavo a centavo con nuestro
motor.** La API de impuestos por `rate` es poco fiable para este propósito:
recalcula con decimales (incompatible con "dinero en enteros"), su catálogo de
impuestos por `_id` no se pudo inspeccionar (los endpoints de lectura dan 500),
y el `discount` global se filtra a líneas que no deberían descontarse.

**Recomendación: la Tarea 7 debe calcular subtotal, descuento e IVA
enteramente en `lib/cotizador/` (enteros, con la regla de redondeo ya
definida), y mandarle a GoHighLevel el resultado ya resuelto:** precios
unitarios ya descontados en `items[]`, el IVA como una línea de texto más
(`"IVA (13%)"` o similar, con el monto entero que ya calculamos, tal como
sugería la ronda de corrección como alternativa) y `discount: { type:
"percentage", value: 0 }` fijo para neutralizar el descuento nativo de GHL.
Así el `total` que muestra el Estimate es exactamente el que calculó nuestro
motor, sin depender de cómo GoHighLevel interprete `rate` o `discount`. Esto
también deja resuelta de una vez la tasa de IVA variable que pide Luxe: como
el cálculo vive en nuestro motor y no en la API, cambiar la tasa (13%,
reducida, o la que Luxe termine de confirmar) es un cambio de dato en
`lib/cotizador/`, no una migración de cómo se declara en GoHighLevel.

## Lo que falta verificar a mano

Esto no se pudo cerrar por sonda porque exigiría enviarle una cotización a
alguien, y esta tarea tenía prohibido hacer eso contra producción. Antes de
salir a producción con el cotizador, alguien de Luxe (no hace falta que sepa
programar) debe hacer esto **una sola vez**, dentro de GoHighLevel:

1. Entrar a GoHighLevel → **Payments → Estimates** (o **Facturación →
   Cotizaciones**, según el idioma de la cuenta).
2. Crear una cotización de prueba nueva a mano, con un cliente de prueba
   (no un cliente real) y un producto cualquiera.
3. Guardarla como borrador (sin enviarla todavía).
4. Buscar el botón que dice **"Vista previa"** o **"Preview"** (normalmente
   arriba a la derecha del editor de la cotización) y hacer clic ahí — eso
   abre exactamente lo que vería el cliente si se la enviaran.
5. Revisar esa vista previa de arriba a abajo y confirmar:
   - Que **no aparece ningún botón** que diga "Pagar ahora", "Pay Now", "Pagar
     esta cotización" ni nada parecido.
   - Que no hay ninguna sección para ingresar tarjeta o método de pago.
6. Si aparece un botón de pago: entrar a **Configuración → Pagos** (o
   **Settings → Payments**) de esa cuenta de GoHighLevel y buscar una opción
   para desactivar el cobro en línea sobre cotizaciones/estimates
   específicamente (suele llamarse algo como "Permitir pago en cotizaciones" o
   "Enable online payment on estimates") y apagarla. Volver a repetir los
   pasos 2 a 5 para confirmar que ya no aparece.
7. Borrar la cotización de prueba que se creó a mano en el paso 2 (para no
   dejar basura en el CRM real).
8. Avisar el resultado (con o sin botón de pago, y si hubo que apagar algo)
   a quien esté implementando la Tarea 7, antes de que esa tarea se dé por
   cerrada.

## Conclusión para el spec del cotizador

El enfoque de usar el módulo nativo de Estimates de GoHighLevel **se sostiene
para la parte que se pudo probar por API**: se puede crear y emitir sin
exponer una pasarela de pago en la respuesta de creación, con moneda `CRC`,
descuentos, notas de términos y datos del negocio tal como necesita Luxe. La
vista que ve el cliente al abrir la cotización enviada queda pendiente de la
verificación manual de la sección anterior — con eso confirmado, el enfoque
queda totalmente validado.

Ajustes de diseño concretos para la Tarea 7:

- Decidir cómo resolver `contactDetails.id` (contacto real vs. algún id no
  vinculante) — ver la tabla de la pregunta 2.
- Usar `altId`/`altType` en el **body** (no en la query string) al implementar
  cualquier DELETE.
- **No delegar el cálculo de descuento ni de IVA a GoHighLevel.** Calcular todo
  en `lib/cotizador/` como enteros y mandar el resultado ya resuelto: precios
  unitarios ya descontados, IVA como línea aparte, y `discount: { type:
  "percentage", value: 0 }` fijo. Ver la sección de impuestos arriba para el
  detalle completo y el porqué.
