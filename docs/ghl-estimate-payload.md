# Estimate de GoHighLevel: cuerpo verificado contra la API real

**Fecha de la prueba:** 2026-08-26/27 (hora de creación real en GHL: `2026-08-27T03:44:48Z`).
**Script:** `scripts/verificar-estimate-ghl.mjs` (`node --env-file=.env.local scripts/verificar-estimate-ghl.mjs`).
**Location de prueba:** el de producción de Luxe Essentials (`LUXE_GHL_LOCATION_ID`).

Se crearon **dos** Estimates de prueba durante la exploración (`estimateNumber` 4 y 5,
`_id` `6a8fb28373a566c909005b3c` y `6a8fb2b0816b79f4fb264806`) y **ambos quedaron
borrados** (`deleted: true` confirmado en la respuesta del DELETE, y `GET
/invoices/estimate/list` devuelve `{"estimates":[],"total":0}` después de la corrida
final). No quedó ningún Estimate huérfano. No se llamó a ningún endpoint de envío
(`send`); no se asoció el Estimate a ningún contacto real.

## Respuesta a las tres preguntas del brief

### 1. ¿Se puede emitir sin empujar al cliente a una pasarela de pago?

**Sí.** La respuesta del `POST /invoices/estimate` no trae ningún campo de
`paymentMethods`, `payNow`, `payment`, `gateway`, ni similar. Las claves de la raíz
de la respuesta son exactamente:

```
altType, altId, companyId, name, businessDetails, estimateStatus, estimateNumber,
currency, contactDetails, issueDate, expiryDate, termsNotes, discount, items,
deleted, automaticTaxesCalculated, title, total, estimateActionHistory, liveMode,
frequencySettings, totalamountInUSD, attachments, configuration, _id, createdAt,
updatedAt, __v, traceId
```

Nada ahí referencia un método de cobro. El Estimate queda en `estimateStatus:
"draft"` — no se envía nada al crear, coincide con la restricción de "crear no es
enviar". Confirmar en una tarea futura (al implementar el envío real, fuera de
alcance de esta tarea) que el flujo de envío tampoco fuerza una pasarela: eso
requeriría inspeccionar el endpoint de envío por separado, algo que esta tarea
tenía prohibido tocar.

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
| `contactDetails.id` | `null` | string no vacío, **24 caracteres** (formato ObjectId de Mongo) | 422: `contactDetails.id should not be empty`, `contactDetails.id must be a string` |
| `frequencySettings` | no existía | objeto obligatorio con `enabled: boolean` | 422: `frequencySettings should not be empty` → luego `frequencySettings.enabled should not be empty`, `... must be a boolean value` |
| `title` | no existía (solo `name`) | obligatorio a nivel de esquema de Mongo, aunque el DTO no lo pida | 500 (validación de mongoose, no del DTO): `title: Path 'title' is required.` |
| `items[].type` | no existía | enum obligatorio; `"service"` **no** es válido, `"one_time"` sí | 500 → `items.0.type: Path 'type' is required.` → luego 422: `items.0.type must be a valid enum value` |

Puntos importantes para la Tarea 7 (implementación):

- **`contactDetails.id` es obligatorio pero la API no valida que exista un
  contacto real con ese id.** Para la prueba se usó un ObjectId ficticio (24
  ceros) precisamente para no tocar contactos reales, tal como pedía el brief.
  En producción, la Tarea 7 deberá decidir: o bien crear/reusar un contacto real
  de GHL antes del Estimate (probablemente lo correcto, para que quede asociado
  al cliente en el CRM), o investigar si existe algún id "genérico" aceptado.
  Este punto queda abierto para esa tarea — esta sonda solo confirma que el
  campo es obligatorio y de tipo string.
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

## Conclusión para el spec del cotizador

El enfoque de usar el módulo nativo de Estimates de GoHighLevel **se sostiene**:
se puede crear y emitir sin exponer una pasarela de pago, con moneda `CRC`,
descuentos, notas de términos y datos del negocio tal como necesita Luxe. El
único ajuste real de diseño para la Tarea 7 es decidir cómo resolver
`contactDetails.id` (contacto real vs. algún id no vinculante) — ver la tabla
de la pregunta 2 — y usar `altId`/`altType` en el body al implementar cualquier
DELETE.
