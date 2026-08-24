# Luxe Essentials — Agente de respuesta multicanal sobre GoHighLevel (Fase 2)

**Fecha:** 2026-08-24
**Estado:** Diseño aprobado en conversación, pendiente de revisión escrita
**Fase:** 2 de 2 (Fase 1 = landing de captación, en producción)

---

## 1. Contexto y problema

Todos los mensajes entrantes de Luxe Essentials —WhatsApp, Instagram, Facebook y correo—
aterrizan en GoHighLevel. Entre que el cliente escribe y un asesor lo atiende pueden pasar
horas. En un negocio donde el visitante compara proveedores de uniformes por lote, ese
silencio es una fuga.

Ya existe una integración con GHL en el repo: `lib/ghl.ts` crea contactos desde el formulario
de la landing usando un Private Integration Token. Este agente reutiliza esa credencial.

### El problema concreto a resolver

El webhook de GHL llega con frecuencia sin el texto del mensaje del cliente. Un sondeo de
sólo lectura contra la location `NvzW6XEGkUCoKxulcRGG` confirmó por qué: el endpoint de
mensajes devuelve entremezclados los mensajes de canal y las *actividades del CRM*.

```
type 28 · TYPE_ACTIVITY_OPPORTUNITY · direction outbound · body "Opportunity created"
type 25 · TYPE_ACTIVITY_CONTACT     · direction inbound  · body "DnD enabled by customer"
```

Nótese que la actividad de tipo 25 viene marcada como `inbound`. Un agente que tome
"el último mensaje entrante" sin filtrar leerá *"DnD enabled by customer"* y creerá que eso
es lo que dijo el cliente. Filtrar por tipo de canal no es un detalle de implementación: es
la pieza central del diseño.

### Verificación de credenciales realizada

| Comprobación | Resultado |
|---|---|
| `GHL_PRIVATE_INTEGRATION` vs `LUXE_GHL_API_KEY` | Idénticos byte por byte (40 chars). No es credencial nueva. |
| `GET /conversations/search` | 200 — el token tiene `conversations.readonly` |
| `GET /conversations/{id}/messages` | 200 — el token tiene `conversations/message.readonly` |
| `conversations/message.write` | **No verificado a propósito** — probarlo envía un mensaje real |
| `~/.zshrc` | Exporta `GHL_PRIVATE_INTEGRATION_TOKEN` y `GHL_LOCATION_ID` globales |

---

## 2. Objetivo y alcance

**Objetivo:** que ningún cliente quede esperando en silencio, y que cuando el asesor entre
a la conversación ya tenga los datos de contacto delante.

**Métrica norte:** proporción de conversaciones entrantes que reciben una primera respuesta
en menos de un minuto y llegan al asesor con nombre y al menos un medio de contacto.

### Dentro del alcance

- Acuse inmediato al cliente por el mismo canal por el que escribió.
- Recolección conversacional de: nombre completo, correo, teléfono, producto de interés
  y ubicación.
- Reconocimiento de imágenes y de notas de voz.
- Escritura de los datos en el contacto de GHL y disparo del workflow interno de aviso.

### Fuera del alcance (decisiones explícitas, no omisiones)

- **Precios, plazos y especificaciones.** El agente no los menciona. Si el cliente pregunta,
  responde que un asesor le dará el detalle. No hay base de conocimiento de producto.
- **Cotizar, negociar, manejar objeciones.**
- **Conversación por correo.** El correo recibe una sola respuesta automática y nada más.
- **Hilar la respuesta de correo dentro del hilo original** (`replyMessageId`). Fase 1 envía
  un correo nuevo con asunto propio.
- **Campos personalizados de GHL.** Se usan campos estándar, tags y una nota.
- **Multi-tenant.** El agente sirve a una sola location.

---

## 3. Decisiones de arquitectura y su porqué

### 3.1 Vive dentro de este repo, aislado en `lib/agente/`

Se descartó un servicio multi-cliente independiente. El criterio del cliente fue explícito:
que no dañe a los otros agentes de GHL que ya operan (Hype, Cosmozi, Reva, Amanda, Hirebase).

Un despliegue único atendiendo a varias cuentas es justamente lo que introduce ese riesgo:
un fallo de parseo en un mensaje de Luxe tumbaría el agente de Hype. Hoy cada cliente vive en
su propio repo y su propio proyecto de Vercel, y eso ya otorga aislamiento físico — no
comparten proceso, ni memoria, ni despliegue.

La portabilidad se resuelve por estructura, no por infraestructura: toda la lógica va en
`lib/agente/` sin nada de Luxe adentro. El conocimiento del negocio, el prompt, los tags y
el workflow ID viven en `lib/agente/config.ts`. Llevarlo a otro cliente es copiar la carpeta
y reescribir ese archivo.

### 3.2 El webhook responde 200 de inmediato y procesa en segundo plano

GHL reintenta los webhooks que tardan. Un reintento sin protección son dos respuestas al
mismo cliente. El pipeline completo (hidratar, transcribir, generar, enviar) puede tomar
entre 5 y 20 segundos, muy por encima de lo que conviene hacer esperar a GHL.

Se usa `after()` de `next/server`, estable en Next.js 16.3.1 —ya presente en el proyecto—
que en Vercel se traduce a `waitUntil`. **No requiere dependencias nuevas**; se descartó
`@vercel/functions` por redundante.

### 3.3 Las imágenes van a Claude, no a OpenAI

Claude procesa imágenes de forma nativa. Enrutarlas por OpenAI agregaría una llamada de red,
latencia y un punto de fallo, sin ganancia. OpenAI se usa **sólo** para transcribir audio
(Whisper), que es lo único que Claude no puede hacer.

### 3.4 Modelo y configuración

`claude-opus-5` con salida estructurada.

| Parámetro | Valor | Razón |
|---|---|---|
| `output_config.effort` | `"low"` | Respuestas de dos frases; no hay nada que deliberar. |
| `thinking` | Se omite (adaptativo por defecto) | Ver abajo. |
| `max_tokens` | `1024` | Techo duro contra una respuesta kilométrica. |
| `cache_control` | En el bloque de sistema | El prompt es idéntico entre contactos. |

**Por qué no se apaga el thinking.** En Opus 5 está encendido por defecto, y apagarlo tiene
un modo de fallo documentado: el modelo a veces escribe la llamada estructurada como texto
plano en lugar de emitirla. El turno termina con éxito aparente, la salida estructurada
nunca llega, y no se levanta ningún error. Con `effort: "low"` el costo de dejarlo encendido
es marginal; el costo de apagarlo es un fallo silencioso.

El mínimo de caché en Opus 5 es de 512 tokens, y el bloque de sistema lo supera, así que a
partir del segundo mensaje el grueso del input se cobra a una décima parte.

**Costo estimado:** 1 a 2 centavos de dólar por respuesta; unos 6 centavos por conversación
completa de cuatro turnos, más el costo de Whisper cuando hay audio.

---

## 4. Flujo

```
Cliente escribe (WhatsApp · IG · FB · Email)
        │
        ▼
GHL Workflow  (trigger: Customer Replied)  →  acción Webhook
        │
        ▼
POST /api/ghl/webhook
        │
        ├──► valida cabecera secreta; si falla → 401 y nada más
        ├──► extrae contactId; si no hay → 200 y nada más
        ├──► responde 200  (~50 ms)
        │
        └──► after():
              1. Hidratar    GET /conversations/search?locationId&contactId
                             GET /conversations/{id}/messages?limit=20
              2. Filtrar     allowlist de tipos de canal (§5.1)
              3. Guardas     §5.2 — cualquiera de ellas aborta sin responder
              4. Medios      audio → Whisper;  imagen → base64 a Claude
              5. Generar     Claude Opus 5 → { respuesta, datos }
              6. Escribir    POST /conversations/messages
                             PUT  /contacts/{contactId}
                             POST /contacts/{contactId}/workflow/{workflowId}
              7. Persistir   estado en Supabase
```

---

## 5. El núcleo

### 5.1 Filtrado por allowlist, no por blocklist

Sólo estos `messageType` cuentan como mensajes reales:

```
TYPE_WHATSAPP · TYPE_INSTAGRAM · TYPE_FACEBOOK · TYPE_EMAIL · TYPE_CUSTOM_EMAIL
```

Todo lo demás se descarta, incluidos todos los `TYPE_ACTIVITY_*`, las campañas y las
llamadas. Es allowlist y no blocklist a propósito: GHL puede añadir tipos de actividad
nuevos en cualquier momento, y una blocklist quedaría desactualizada en silencio —
volviendo a introducir exactamente el bug que este proyecto existe para resolver.

### 5.2 Las tres guardas

Todo lo demás es plomería. Estas tres evitan los tres desastres reales.

**Guarda 1 — Sólo se actúa si el último mensaje real es entrante.**
La respuesta del propio agente vuelve a disparar el workflow de GHL, que vuelve a llamar al
webhook. Sin esta guarda el agente se contesta a sí mismo indefinidamente, cobrando cada
vuelta. Con ella el bucle muere en el primer paso, porque lo último en la conversación es
saliente. Si no hay **ningún** mensaje entrante real, no se responde: éste es el caso del
"webhook vacío" que motivó el proyecto, resuelto por omisión en vez de por adivinanza.

**Guarda 2 — Si respondió un humano, el agente queda mudo para siempre en ese contacto.**
Detección por doble vía, porque equivocarse aquí significa el bot hablando encima del asesor
delante del cliente:

1. Se guarda el `id` de cada mensaje que el agente envía, en `enviados[]`.
2. Cualquier mensaje saliente de canal real cuyo `id` no esté en `enviados[]` se considera
   humano, y se cruza con el campo `source` del mensaje.

El estado pasa a `humano` y es terminal. No hay vuelta atrás automática.

**Guarda 3 — Un mensaje entrante se procesa exactamente una vez.**
El candado es un `UPDATE` condicional en Postgres:

```sql
update public.agente_conversaciones
   set ultimo_mensaje_id = $nuevo, updated_at = now()
 where contact_id = $contacto
   and ultimo_mensaje_id is distinct from $nuevo
returning contact_id;
```

Si no devuelve fila, otro proceso ya tomó ese mensaje y este turno se abandona en silencio.
Cubre el reintento de GHL y el cliente que manda tres mensajes seguidos.

### 5.3 Tope de turnos

Cuatro respuestas automáticas por contacto. Al llegar al tope el estado pasa a `agotado`, se
dispara el workflow interno si aún no se disparó, y el agente calla. Evita que un cliente
insistente sostenga una conversación infinita con un bot que sólo sabe pedir datos.

### 5.4 Correo: una sola respuesta

El correo no conversa. Al primer entrante de tipo correo el agente envía un acuse único, pasa
el estado a `email_respondido`, y no vuelve a escribir en ese contacto. No cuenta turnos y no
se le pide al modelo que recolecte datos de forma iterativa: pide todo de una vez.

### 5.5 Mapeo de canal de respuesta

El `messageType` que se lee **no** es el `type` que se envía. Son dos vocabularios distintos
de la misma API:

| `messageType` leído | `type` a enviar |
|---|---|
| `TYPE_WHATSAPP` | `WhatsApp` |
| `TYPE_INSTAGRAM` | `IG` |
| `TYPE_FACEBOOK` | `FB` |
| `TYPE_EMAIL`, `TYPE_CUSTOM_EMAIL` | `Email` |

Si el tipo entrante no está en esta tabla, no se responde. Sin adivinanzas de canal.

---

## 6. Contratos con GHL

Cabeceras: `Authorization: Bearer <token>`, `Accept: application/json`.
La versión difiere por familia de endpoint — conversaciones usa `2021-04-15`, contactos usa
`2021-07-28`. Mezclarlas produce errores desconcertantes.

| Operación | Método y ruta | Version |
|---|---|---|
| Buscar conversación | `GET /conversations/search?locationId=&contactId=` | `2021-04-15` |
| Leer mensajes | `GET /conversations/{conversationId}/messages?limit=20` | `2021-04-15` |
| Enviar mensaje | `POST /conversations/messages` | `2021-04-15` |
| Actualizar contacto | `PUT /contacts/{contactId}` | `2021-07-28` |
| Añadir a workflow | `POST /contacts/{contactId}/workflow/{workflowId}` | `2021-07-28` |

Cuerpo de envío para canales de mensajería:

```json
{ "type": "WhatsApp", "contactId": "…", "message": "…" }
```

Para correo se añade `subject`. La respuesta de envío trae el `id` del mensaje creado, que
es lo que se acumula en `enviados[]` para la Guarda 2. Si la respuesta no trae `id`, el
mensaje se considera enviado pero el `id` no se registra, y se anota en el log: es el único
caso donde la Guarda 2 podría confundir un mensaje propio con uno humano, y el resultado
sería que el agente calla de más — un fallo seguro.

**Workflow interno:** `1235c311-b3e6-4b7d-be40-0ec2a1f01a60`.

---

## 7. Escritura de los datos recolectados

**Campos estándar del contacto** (`PUT /contacts/{id}`): `firstName`, `lastName`, `email`,
`phone`. Sólo se escriben los campos que el agente logró recolectar y que vienen vacíos en
el contacto; nunca se pisa un dato existente. Para saberlo hay que leer el contacto antes
de escribirlo, porque el `PUT` de GHL sobrescribe.

**`city` queda excluido a propósito.** La importación de la base comercial 2026 mapea
`Subzona / ruta` a `City`, así que ese campo no es la ciudad del cliente sino su ruta de
visita. Escribir ahí la ubicación que alguien mencione por chat rompería la segmentación
comercial. La ubicación declarada va únicamente a la nota.

**`persona_contacto` (campo personalizado).** En la base importada `First Name` lleva el
nombre comercial del negocio, no el de una persona. El nombre de quien escribe se guarda en
el campo personalizado `persona_contacto`, y `firstName` sólo se escribe cuando está vacío
—es decir, en contactos nuevos que no vienen del ERP.

**Tags:** `agente-ia`, más `interes-uniformes` / `interes-hogar` según el producto declarado.

**Nota:** un resumen con lo recolectado y el canal de origen, para que el asesor lo lea sin
recorrer el hilo.

**Workflow:** se dispara una sola vez por contacto, marcado con `notificado_at`. Se dispara
cuando ocurra lo primero de:

- el agente tiene nombre **y** al menos un medio de contacto (correo o teléfono); o
- el agente agotó sus cuatro turnos.

La segunda condición existe para que el equipo se entere aunque el cliente nunca suelte
sus datos.

---

## 8. Estado

```sql
-- supabase/migrations/0002_agente.sql
create table if not exists public.agente_conversaciones (
  contact_id        text primary key,
  conversation_id   text,
  canal             text,
  estado            text not null default 'activo'
                    check (estado in ('activo','humano','agotado','email_respondido')),
  turnos            int  not null default 0,
  datos             jsonb not null default '{}'::jsonb,
  ultimo_mensaje_id text,
  enviados          text[] not null default '{}',
  notificado_at     timestamptz,
  updated_at        timestamptz not null default now()
);

create index if not exists agente_conversaciones_estado_idx
  on public.agente_conversaciones (estado);
```

`datos` guarda `{ nombre, email, telefono, producto, ubicacion }`, cada uno `string | null`.

Se aplica con `npm run db:migrate`, el script que ya existe en el proyecto.

---

## 9. Contrato del modelo

Bloque de sistema (cacheado): rol, tono, brevedad de una a tres frases, prohibición explícita
de inventar precios, plazos y especificaciones, instrucción de pedir como máximo dos datos
faltantes por mensaje, y de responder en el idioma del cliente con español por defecto.

Entrada: los últimos mensajes reales de la conversación, ya filtrados, con el audio
transcrito y las imágenes adjuntas como bloques de imagen.

Salida estructurada, esquema fijo:

```json
{
  "respuesta": "string",
  "datos": {
    "nombre":    "string | null",
    "email":     "string | null",
    "telefono":  "string | null",
    "producto":  "uniformes | hogar | ambas | null",
    "ubicacion": "string | null"
  }
}
```

`datos` se fusiona con lo ya guardado: un valor nulo nunca borra un dato previo.

**El esquema no incluye ningún campo de decisión** del tipo `listo_para_asesor`. Cuándo
avisar al equipo lo decide el código con la condición determinista de §7, no el juicio del
modelo. Duplicar esa decisión en ambos lados sólo crea la posibilidad de que se contradigan,
y el modelo no tiene información que el código no tenga.

---

## 10. Fallos

| Fallo | Comportamiento |
|---|---|
| Cabecera secreta ausente o incorrecta | `401`. No se procesa nada. |
| Cuerpo sin `contactId` | `200` y se abandona. GHL no debe reintentar algo irreparable. |
| GHL no responde al hidratar | Un reintento con espera; si vuelve a fallar, se abandona el turno sin responder. Nunca se responde a ciegas. |
| Sin mensajes entrantes reales | No se responde. Es el caso que motivó el proyecto. |
| Canal entrante fuera de la tabla §5.5 | No se responde. |
| Whisper falla con un audio | Se responde reconociendo la nota de voz y pidiendo el dato por escrito. |
| Claude falla, o devuelve un JSON que no valida | No se responde. Silencio antes que incoherencia. |
| Falla el envío a GHL | El turno no se marca consumido; el siguiente mensaje del cliente lo reintenta. |
| Contacto ya notificado | El workflow no se vuelve a disparar. |

Todo fallo se registra con el prefijo `[agente]` y el `contactId`. **Nunca se registra el
contenido del mensaje del cliente** — puede llevar datos que no esperaría ver en un log de
servidor, criterio ya establecido en `app/api/lead/route.ts`.

---

## 11. Configuración

Variables nuevas en `.env.local` y en `.env.example`:

```
LUXE_AGENTE_WEBHOOK_SECRET=
LUXE_ANTHROPIC_API_KEY=
LUXE_OPENAI_API_KEY=
```

Se reutilizan `LUXE_GHL_API_KEY` y `LUXE_GHL_LOCATION_ID`, ya presentes.

**Todas llevan el prefijo `LUXE_` a propósito.** El `~/.zshrc` de la máquina de desarrollo
exporta `GHL_PRIVATE_INTEGRATION_TOKEN` y `GHL_LOCATION_ID` globales, y una variable de
proyecto sin prefijo corre el riesgo de ser pisada por el entorno del shell — un fallo ya
sufrido en otro proyecto, difícil de diagnosticar porque el código es correcto y el valor no.
`ANTHROPIC_API_KEY` y `OPENAI_API_KEY`, hoy sin prefijo en `.env.local`, se renombran.
`GHL_PRIVATE_INTEGRATION` **se elimina**: se comprobó que su valor es idéntico byte por byte
a `LUXE_GHL_API_KEY` (§1), así que no es una credencial nueva sino la misma duplicada bajo
otro nombre. Dos nombres para el mismo secreto es una rotación futura a medias esperando a
ocurrir.

---

## 12. Pruebas

Vitest con `fetch` inyectado, el mismo patrón que ya usa `upsertContact` en `lib/ghl.ts`.
Ninguna prueba toca la red ni la base de datos reales.

Casos obligatorios:

1. Webhook sin cabecera secreta → `401`.
2. Webhook sin `contactId` → `200`, sin efectos.
3. Conversación que sólo contiene `TYPE_ACTIVITY_*` → no se responde.
4. La actividad `TYPE_ACTIVITY_CONTACT` marcada `inbound` no se confunde con un mensaje.
5. Último mensaje real saliente y propio → no se responde (Guarda 1, anti-bucle).
6. Saliente ajeno a `enviados[]` → estado `humano`, no se responde (Guarda 2).
7. Dos invocaciones con el mismo `ultimo_mensaje_id` → una sola respuesta (Guarda 3).
8. Cuarto turno → responde, dispara workflow, estado `agotado`.
9. Quinto mensaje del cliente en estado `agotado` → no se responde.
10. Correo entrante → una respuesta; segundo correo → ninguna.
11. Cada `messageType` de §5.5 produce su `type` de envío correcto.
12. Canal fuera de la tabla → no se responde.
13. JSON inválido de Claude → no se responde, se registra el fallo.
14. `datos` con nulos → no borra datos ya guardados.
15. Contacto con `email` ya poblado en GHL → no se pisa.

---

## 13. Archivos

| Archivo | Responsabilidad |
|---|---|
| `app/api/ghl/webhook/route.ts` | Valida, responde 200, agenda con `after()` |
| `lib/agente/conversacion.ts` | Hidrata desde GHL y filtra por allowlist |
| `lib/agente/canal.ts` | Mapeo `messageType` → `type` de envío |
| `lib/agente/medios.ts` | Audio a Whisper, imágenes a bloques de Claude |
| `lib/agente/cerebro.ts` | Llamada a Claude y validación del esquema con Zod |
| `lib/agente/acciones.ts` | Enviar mensaje, actualizar contacto, disparar workflow |
| `lib/agente/estado.ts` | Lectura y escritura del estado, y el candado condicional |
| `lib/agente/config.ts` | **Único archivo con contenido específico de Luxe** |
| `supabase/migrations/0002_agente.sql` | Tabla de estado |

Zod ya es dependencia del proyecto y se usa para validar la salida del modelo.

---

## 14. Riesgo abierto

**El scope `conversations/message.write` no está verificado.** Comprobarlo requiere enviar un
mensaje real, y no se hizo sin autorización. Antes de implementar el envío hay que confirmar
en la UI de GoHighLevel que el Private Integration tiene ese permiso habilitado. Si no lo
tiene, todo lo demás funciona y el agente simplemente no puede responder: el fallo se
manifestaría como un `401` o `403` en el paso 6 del flujo.
