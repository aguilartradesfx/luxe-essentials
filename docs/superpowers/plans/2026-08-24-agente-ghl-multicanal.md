# Agente de respuesta multicanal sobre GoHighLevel — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que todo mensaje entrante en GoHighLevel reciba una respuesta breve en menos de un minuto, y que el asesor humano encuentre los datos del cliente ya capturados cuando entre a la conversación.

**Architecture:** Un webhook de Next.js recibe el aviso de GHL, responde `200` de inmediato y procesa en segundo plano con `after()`. El procesamiento re-consulta a GHL la conversación del contacto (porque el webhook llega sin el texto), filtra las actividades del CRM con una allowlist de tipos de canal, aplica tres guardas (anti-bucle, humano-presente, anti-duplicado), genera la respuesta con Claude Opus 5 en salida estructurada, y escribe de vuelta en GHL. El estado vive en Supabase.

**Tech Stack:** Next.js 16.3.1 (App Router, `after()` de `next/server`), TypeScript, Supabase (`@supabase/supabase-js`), Zod 4, Vitest, `fetch` nativo contra las APIs de GoHighLevel, Anthropic y OpenAI.

**Spec:** `docs/superpowers/specs/2026-08-24-agente-ghl-multicanal-design.md`

## Global Constraints

- **Sin dependencias nuevas.** `after()` viene en `next/server` (Next 16.3.1, ya instalado); Zod y `@supabase/supabase-js` ya son dependencias. No instalar `@vercel/functions` ni el SDK de Anthropic ni el de OpenAI — se usa `fetch`.
- **Todo el código en español**: nombres de funciones, variables, tipos, mensajes de error y comentarios. Es la convención del repo (`upsertContact` es la única excepción heredada).
- **Comentarios que expliquen el *porqué*, no el *qué*.** El repo lo hace así; ver `lib/ghl.ts:36-38` y `app/api/lead/route.ts:52-60`.
- **Toda función que llame a la red recibe `fetchImpl?: typeof fetch` en sus deps** y usa `const { fetchImpl = fetch } = deps`. Es el patrón de `upsertContact` en `lib/ghl.ts:76` y lo que hace las pruebas posibles sin red.
- **Variables de entorno con prefijo `LUXE_`.** El `~/.zshrc` de la máquina exporta `GHL_PRIVATE_INTEGRATION_TOKEN` y `GHL_LOCATION_ID` globales; una variable sin prefijo puede ser pisada por el shell.
- **Nunca registrar en logs el contenido del mensaje del cliente.** Sólo `contactId` y códigos de error, con el prefijo `[agente]`.
- **Versiones de la API de GHL:** conversaciones usa `Version: 2021-04-15`; contactos usa `Version: 2021-07-28`. Mezclarlas produce errores desconcertantes.
- **Base de GHL:** `https://services.leadconnectorhq.com`.
- **Modelo:** `claude-opus-5`, `max_tokens: 1024`, `output_config.effort: "low"`. **No** enviar el parámetro `thinking` (queda adaptativo por defecto; apagarlo hace que la salida estructurada a veces salga como texto plano, fallando en silencio).
- **Workflow interno de aviso:** `1235c311-b3e6-4b7d-be40-0ec2a1f01a60`.
- **Tope de turnos:** 4 respuestas automáticas por contacto.

---

## Estructura de archivos

| Archivo | Responsabilidad única |
|---|---|
| `lib/agente/config.ts` | **El único archivo con contenido de Luxe.** Prompt, tags, workflow ID, tope de turnos. |
| `lib/agente/canal.ts` | Allowlist de tipos reales y mapeo `messageType` → `type` de envío. Funciones puras. |
| `lib/agente/conversacion.ts` | Hidratar la conversación desde GHL y filtrarla. |
| `lib/agente/estado.ts` | Estado en Supabase, incluido el candado anti-duplicado. |
| `lib/agente/medios.ts` | Adjuntos: audio a Whisper, imágenes a bloques de Claude. |
| `lib/agente/cerebro.ts` | Llamada a Claude y validación de la salida con Zod. |
| `lib/agente/acciones.ts` | Escrituras en GHL: enviar, actualizar contacto, disparar workflow. |
| `app/api/ghl/webhook/route.ts` | Orquestación: valida, responde 200, agenda, aplica las guardas. |
| `supabase/migrations/0002_agente.sql` | Tabla `agente_conversaciones`. |

Cada archivo de `lib/agente/` tiene su propio archivo de pruebas en `tests/agente-*.test.ts`.

---

### Task 1: Cimientos — configuración, entorno y tabla

**Files:**
- Create: `lib/agente/config.ts`
- Create: `supabase/migrations/0002_agente.sql`
- Modify: `.env.example`
- Modify: `.env.local` (renombrar tres claves, eliminar una)
- Test: `tests/agente-config.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `PRODUCTOS` (tupla), `type Producto`, y `config` (objeto con `WORKFLOW_AVISO: string`, `CAMPO_PERSONA: string`, `TOPE_TURNOS: number`, `TAGS_BASE: string[]`, `tagDeProducto(p): string | null`, `PROMPT_SISTEMA: string`, `BASE_GHL: string`, `VERSION_CONVERSACIONES: string`, `VERSION_CONTACTOS: string`).

- [ ] **Step 1: Arreglar el entorno**

En `.env.local`, renombrar y eliminar. `GHL_PRIVATE_INTEGRATION` **se elimina, no se renombra**: se verificó que su valor es idéntico byte por byte a `LUXE_GHL_API_KEY`, así que es el mismo secreto duplicado bajo otro nombre.

```bash
# Verificar primero que siguen siendo idénticos antes de borrar nada.
python3 -c "
import re
env = open('.env.local').read()
g = lambda k: (re.search(rf'^{k}=(.*)\$', env, re.M) or [None,None])[1]
print('idénticos:', g('LUXE_GHL_API_KEY') == g('GHL_PRIVATE_INTEGRATION'))
"
```

Si imprime `True`, editar `.env.local` a mano:
- `ANTHROPIC_API_KEY=` → `LUXE_ANTHROPIC_API_KEY=`
- `OPENAI_API_KEY=` → `LUXE_OPENAI_API_KEY=`
- Borrar la línea `GHL_PRIVATE_INTEGRATION=` entera.
- Añadir `LUXE_AGENTE_WEBHOOK_SECRET=` con un valor generado: `openssl rand -hex 32`

Si imprime `False`, **detenerse y preguntar**: el supuesto del spec no se sostiene y hay dos credenciales distintas en juego.

- [ ] **Step 2: Declarar las variables en `.env.example`**

Añadir al final de `.env.example`:

```
LUXE_AGENTE_WEBHOOK_SECRET=
LUXE_ANTHROPIC_API_KEY=
LUXE_OPENAI_API_KEY=
```

- [ ] **Step 3: Escribir la prueba de configuración**

Crear `tests/agente-config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { config } from '@/lib/agente/config';

describe('config del agente', () => {
  it('expone el workflow de aviso interno', () => {
    expect(config.WORKFLOW_AVISO).toBe('1235c311-b3e6-4b7d-be40-0ec2a1f01a60');
  });

  it('topa las respuestas automáticas en 4', () => {
    expect(config.TOPE_TURNOS).toBe(4);
  });

  it('expone la clave del campo personalizado de la persona de contacto', () => {
    expect(config.CAMPO_PERSONA).toBe('persona_contacto');
  });

  it('mapea cada producto a su tag, y null cuando no hay producto', () => {
    expect(config.tagDeProducto('uniformes')).toBe('interes-uniformes');
    expect(config.tagDeProducto('hogar')).toBe('interes-hogar');
    expect(config.tagDeProducto('ambas')).toBe('interes-ambas');
    expect(config.tagDeProducto(null)).toBeNull();
  });

  // El prompt se cachea en la API de Anthropic, y el mínimo de caché en Opus 5
  // son 512 TOKENS. Por debajo de eso el bloque no cachea y cada respuesta se
  // cobra completa, en silencio.
  //
  // El umbral en caracteres es un proxy calibrado con una medición real contra
  // /v1/messages/count_tokens: 2153 caracteres de este prompt = 948 tokens, o
  // sea ~2.3 chars/token (el español tokeniza peor que el inglés; la regla de
  // ~4 chars/token es de inglés y aquí sobreestima por casi el doble).
  // 512 tokens ≈ 1160 caracteres, así que 1500 deja margen cómodo.
  it('el prompt es lo bastante largo para que la caché lo acepte', () => {
    expect(config.PROMPT_SISTEMA.length).toBeGreaterThan(1500);
  });

  it('el prompt le prohíbe inventar precios y plazos', () => {
    const p = config.PROMPT_SISTEMA.toLowerCase();
    expect(p).toContain('precio');
    expect(p).toContain('plazo');
    expect(p).toContain('nunca');
  });
});
```

- [ ] **Step 4: Ejecutar la prueba y verificar que falla**

Run: `npx vitest run tests/agente-config.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/agente/config"`

- [ ] **Step 5: Escribir `lib/agente/config.ts`**

```ts
// El único archivo de lib/agente/ con contenido específico de Luxe Essentials.
// Para llevar este agente a otro cliente se copia lib/agente/ entera y se
// reescribe sólo este archivo.

// Fuente única de la unión de productos. `estado.ts` y `cerebro.ts` la
// importan de aquí: tenerla escrita en tres sitios significaría que añadir una
// línea de producto obliga a tocar tres archivos y olvidarse de uno.
export const PRODUCTOS = ['uniformes', 'hogar', 'ambas'] as const;
export type Producto = (typeof PRODUCTOS)[number];

const PROMPT_SISTEMA = `Eres el primer contacto de Luxe Essentials, una empresa que fabrica uniformes y textiles de hogar por pedido para operaciones en Centroamérica.

Tu único trabajo es que la persona no se quede esperando en silencio mientras un asesor de ventas la atiende, y recoger los datos que ese asesor va a necesitar.

CÓMO ESCRIBES
- De una a tres frases. Nunca más.
- Tono cercano y profesional, de persona, no de robot corporativo.
- En el idioma en que te escriba el cliente. Si no queda claro, español.
- Sin emojis, sin signos de exclamación de más, sin saludos largos.
- Nunca digas que eres una inteligencia artificial ni un asistente automático, pero tampoco afirmes ser una persona concreta con nombre.

QUÉ RECOGES
Necesitas cinco cosas: nombre completo, correo, teléfono, qué producto le interesa (uniformes, hogar o ambas) y dónde está ubicado.
- Pide como máximo dos datos por mensaje. Preguntar los cinco de golpe es un interrogatorio y la gente se va.
- Si el cliente ya dio un dato, no lo vuelvas a pedir.
- Si el cliente pregunta algo antes de dar sus datos, reconoce su pregunta primero y luego pide un dato. No lo ignores.

QUÉ NUNCA HACES
- Nunca das precios, ni rangos de precio, ni descuentos.
- Nunca prometes plazos de entrega, fechas ni tiempos de producción.
- Nunca detallas especificaciones técnicas, telas, gramajes ni medidas.
- Nunca confirmas disponibilidad de nada.
- Nunca inventas un dato que no tengas.
Si te preguntan cualquiera de esas cosas, dilo con naturalidad: que un asesor le va a dar ese detalle en breve, y aprovecha para pedir un dato que te falte.

SOBRE LO QUE TE MANDEN
- Si te mandan una foto, di qué ves en ella en pocas palabras antes de seguir. Si es una prenda o un logo, reconócelo.
- Si te mandan una nota de voz, responde a lo que dice, sin mencionar que fue transcrita.
- Si algo llega ilegible o vacío, pide amablemente que lo repita por escrito.

FORMATO DE SALIDA
Devuelves un objeto con dos campos: "respuesta" (el texto que se le envía al cliente) y "datos" (lo que hayas logrado saber hasta ahora, con null en lo que aún no sepas). En "datos" acumula también lo que ya sabías de mensajes anteriores.`;

export const config = {
  BASE_GHL: 'https://services.leadconnectorhq.com',
  VERSION_CONVERSACIONES: '2021-04-15',
  VERSION_CONTACTOS: '2021-07-28',

  WORKFLOW_AVISO: '1235c311-b3e6-4b7d-be40-0ec2a1f01a60',
  // Campo personalizado de la carpeta "Luxe · Base Comercial 2026". En la base
  // importada First Name lleva el nombre comercial del negocio, así que el
  // nombre de la persona que escribe necesita su propio campo.
  CAMPO_PERSONA: 'persona_contacto',
  TOPE_TURNOS: 4,
  TAGS_BASE: ['agente-ia'],

  PROMPT_SISTEMA,

  tagDeProducto(producto: Producto | null): string | null {
    return producto ? `interes-${producto}` : null;
  },
};
```

- [ ] **Step 6: Ejecutar la prueba y verificar que pasa**

Run: `npx vitest run tests/agente-config.test.ts`
Expected: PASS, 6 pruebas.

- [ ] **Step 7: Escribir la migración**

Crear `supabase/migrations/0002_agente.sql`:

```sql
-- Estado por contacto del agente de respuesta multicanal.
-- Una fila por contacto de GHL, creada de forma perezosa al primer mensaje.
create table if not exists public.agente_conversaciones (
  contact_id        text primary key,
  conversation_id   text,
  canal             text,
  estado            text not null default 'activo'
                    check (estado in ('activo','humano','agotado','email_respondido')),
  turnos            int  not null default 0,
  datos             jsonb not null default '{}'::jsonb,

  -- El candado de la guarda 3. Guarda el id del último mensaje entrante que
  -- ya se procesó; el UPDATE condicional contra esta columna es lo que evita
  -- que un reintento de GHL produzca una segunda respuesta al cliente.
  ultimo_mensaje_id text,

  -- Ids de los mensajes que envió el agente. Cualquier saliente de canal real
  -- que no esté aquí lo escribió un humano (guarda 2).
  enviados          text[] not null default '{}',

  notificado_at     timestamptz,
  updated_at        timestamptz not null default now()
);


alter table public.agente_conversaciones enable row level security;

-- Sin políticas, igual que public.leads: sólo el service role escribe, desde el
-- route handler. Esto no es opcional — la tabla guarda nombre, correo y teléfono
-- de cada persona que escribe al negocio, y NEXT_PUBLIC_SUPABASE_ANON_KEY viaja
-- al navegador en el bundle de la landing. Sin RLS, cualquiera que extraiga esa
-- clave lee la tabla entera por PostgREST.

create index if not exists agente_conversaciones_estado_idx
  on public.agente_conversaciones (estado);
```

- [ ] **Step 8: Aplicar la migración — DIFERIDO**

**No ejecutar `npm run db:migrate` todavía.** El 2026-08-24 se comprobó que el proyecto de
Supabase `ayjcduotuvvjdwgyuvih` no resuelve en DNS y el pooler responde `Tenant or user not
found`. Es un problema de infraestructura ajeno a este plan, y afecta también a la Fase 1 en
producción.

El archivo `.sql` se commitea igual: es código versionado, y aplicarlo es un paso de
despliegue, no de implementación. Queda registrado en "Antes de desplegar".

Verificación posible ahora, sin base de datos: que el SQL sea sintácticamente válido y que
el archivo esté donde `scripts/db.mjs` lo busca (`supabase/migrations/`).

- [ ] **Step 9: Commit**

```bash
git add lib/agente/config.ts supabase/migrations/0002_agente.sql tests/agente-config.test.ts .env.example
git commit -m "feat(agente): configuración, entorno y tabla de estado"
```

**Nota:** `.env.local` está en `.gitignore` y no se commitea. Verificarlo con `git status` antes del commit: si aparece, **detenerse** — hay un secreto a punto de entrar al repo.

---

### Task 2: `lib/agente/canal.ts` — allowlist y mapeo de canal

Este archivo es donde vive la corrección del bug que motiva todo el proyecto. Un sondeo real contra la location devolvió esto:

```
type 25 · TYPE_ACTIVITY_CONTACT · direction inbound · body "DnD enabled by customer"
```

Una actividad del CRM marcada como `inbound`. Un agente que tome "el último mensaje entrante" sin filtrar leerá eso y creerá que es lo que dijo el cliente.

**Files:**
- Create: `lib/agente/canal.ts`
- Test: `tests/agente-canal.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `type TipoReal = 'TYPE_WHATSAPP' | 'TYPE_INSTAGRAM' | 'TYPE_FACEBOOK' | 'TYPE_EMAIL' | 'TYPE_CUSTOM_EMAIL'`
  - `type CanalEnvio = 'WhatsApp' | 'IG' | 'FB' | 'Email'`
  - `esMensajeReal(tipo: string | undefined | null): tipo is TipoReal`
  - `canalDeEnvio(tipo: string | undefined | null): CanalEnvio | null`
  - `esCorreo(tipo: string | undefined | null): boolean`

- [ ] **Step 1: Escribir las pruebas que fallan**

Crear `tests/agente-canal.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { esMensajeReal, canalDeEnvio, esCorreo } from '@/lib/agente/canal';

describe('esMensajeReal', () => {
  it('acepta los cuatro canales que el negocio atiende', () => {
    expect(esMensajeReal('TYPE_WHATSAPP')).toBe(true);
    expect(esMensajeReal('TYPE_INSTAGRAM')).toBe(true);
    expect(esMensajeReal('TYPE_FACEBOOK')).toBe(true);
    expect(esMensajeReal('TYPE_EMAIL')).toBe(true);
    expect(esMensajeReal('TYPE_CUSTOM_EMAIL')).toBe(true);
  });

  // Éste es EL caso. Sale de un sondeo real contra la location: una actividad
  // del CRM que GHL marca como inbound. Sin este filtro el agente cree que el
  // cliente escribió "DnD enabled by customer".
  it('rechaza las actividades del CRM aunque vengan marcadas inbound', () => {
    expect(esMensajeReal('TYPE_ACTIVITY_CONTACT')).toBe(false);
    expect(esMensajeReal('TYPE_ACTIVITY_OPPORTUNITY')).toBe(false);
    expect(esMensajeReal('TYPE_ACTIVITY_INVOICE')).toBe(false);
    expect(esMensajeReal('TYPE_ACTIVITY_PAYMENT')).toBe(false);
    expect(esMensajeReal('TYPE_ACTIVITY_APPOINTMENT')).toBe(false);
  });

  // Es allowlist y no blocklist a propósito: GHL puede añadir tipos nuevos
  // cuando quiera, y una blocklist quedaría desactualizada en silencio,
  // reintroduciendo exactamente el bug que este archivo existe para matar.
  it('rechaza cualquier tipo que no conozca, incluido uno inventado', () => {
    expect(esMensajeReal('TYPE_ACTIVITY_ALGO_QUE_NO_EXISTE_AUN')).toBe(false);
    expect(esMensajeReal('TYPE_CAMPAIGN_SMS')).toBe(false);
    expect(esMensajeReal('TYPE_CALL')).toBe(false);
    expect(esMensajeReal('TYPE_SMS')).toBe(false);
  });

  it('rechaza vacío, undefined y null sin reventar', () => {
    expect(esMensajeReal('')).toBe(false);
    expect(esMensajeReal(undefined)).toBe(false);
    expect(esMensajeReal(null)).toBe(false);
  });
});

describe('canalDeEnvio', () => {
  // El vocabulario de lectura y el de escritura son distintos en la misma API.
  // Mandar "TYPE_WHATSAPP" como type de envío es un 400.
  it('traduce el tipo leído al type que espera el endpoint de envío', () => {
    expect(canalDeEnvio('TYPE_WHATSAPP')).toBe('WhatsApp');
    expect(canalDeEnvio('TYPE_INSTAGRAM')).toBe('IG');
    expect(canalDeEnvio('TYPE_FACEBOOK')).toBe('FB');
    expect(canalDeEnvio('TYPE_EMAIL')).toBe('Email');
    expect(canalDeEnvio('TYPE_CUSTOM_EMAIL')).toBe('Email');
  });

  it('devuelve null para lo que no sabe enviar, en vez de adivinar', () => {
    expect(canalDeEnvio('TYPE_SMS')).toBeNull();
    expect(canalDeEnvio('TYPE_ACTIVITY_CONTACT')).toBeNull();
    expect(canalDeEnvio(undefined)).toBeNull();
  });
});

describe('esCorreo', () => {
  it('reconoce las dos variantes de correo', () => {
    expect(esCorreo('TYPE_EMAIL')).toBe(true);
    expect(esCorreo('TYPE_CUSTOM_EMAIL')).toBe(true);
  });

  it('no confunde mensajería con correo', () => {
    expect(esCorreo('TYPE_WHATSAPP')).toBe(false);
    expect(esCorreo(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Ejecutar y verificar que falla**

Run: `npx vitest run tests/agente-canal.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/agente/canal"`

- [ ] **Step 3: Escribir `lib/agente/canal.ts`**

```ts
// GHL devuelve, mezclados en el mismo array, los mensajes de canal y las
// actividades del CRM. Algunas actividades vienen marcadas `inbound`, así que
// filtrar por dirección no basta: hay que filtrar por tipo.
//
// Esto es una allowlist, no una blocklist, a propósito. GHL añade tipos de
// actividad nuevos sin avisar; una blocklist envejecería en silencio y el
// agente volvería a responderle a un evento del CRM creyendo que es un cliente.

export const TIPOS_REALES = [
  'TYPE_WHATSAPP',
  'TYPE_INSTAGRAM',
  'TYPE_FACEBOOK',
  'TYPE_EMAIL',
  'TYPE_CUSTOM_EMAIL',
] as const;

export type TipoReal = (typeof TIPOS_REALES)[number];
export type CanalEnvio = 'WhatsApp' | 'IG' | 'FB' | 'Email';

export function esMensajeReal(tipo: string | undefined | null): tipo is TipoReal {
  return !!tipo && (TIPOS_REALES as readonly string[]).includes(tipo);
}

// El tipo que se LEE no es el type que se ENVÍA: son dos vocabularios distintos
// de la misma API. Mandar "TYPE_WHATSAPP" al endpoint de envío es un 400.
const ENVIO: Record<TipoReal, CanalEnvio> = {
  TYPE_WHATSAPP: 'WhatsApp',
  TYPE_INSTAGRAM: 'IG',
  TYPE_FACEBOOK: 'FB',
  TYPE_EMAIL: 'Email',
  TYPE_CUSTOM_EMAIL: 'Email',
};

export function canalDeEnvio(tipo: string | undefined | null): CanalEnvio | null {
  return esMensajeReal(tipo) ? ENVIO[tipo] : null;
}

export function esCorreo(tipo: string | undefined | null): boolean {
  return tipo === 'TYPE_EMAIL' || tipo === 'TYPE_CUSTOM_EMAIL';
}
```

- [ ] **Step 4: Ejecutar y verificar que pasa**

Run: `npx vitest run tests/agente-canal.test.ts`
Expected: PASS, 16 pruebas.

- [ ] **Step 5: Commit**

```bash
git add lib/agente/canal.ts tests/agente-canal.test.ts
git commit -m "feat(agente): allowlist de tipos de canal y mapeo de envío

Las actividades del CRM vienen mezcladas con los mensajes y algunas llegan
marcadas inbound, así que filtrar por dirección no basta. Allowlist y no
blocklist porque GHL añade tipos nuevos sin avisar."
```

---

### Task 3: `lib/agente/conversacion.ts` — hidratar y filtrar

**Files:**
- Create: `lib/agente/conversacion.ts`
- Test: `tests/agente-conversacion.test.ts`

**Interfaces:**
- Consumes: `esMensajeReal`, `TipoReal` de `@/lib/agente/canal`; `config.BASE_GHL`, `config.VERSION_CONVERSACIONES` de `@/lib/agente/config`.
- Produces:
  - `type MensajeReal = { id: string; tipo: TipoReal; direccion: 'inbound' | 'outbound'; texto: string; adjuntos: string[] }`
  - `type Conversacion = { conversationId: string; mensajes: MensajeReal[] }` — mensajes en orden cronológico ascendente (el más reciente al final)
  - `type DepsGhl = { apiKey: string; locationId: string; fetchImpl?: typeof fetch }`
  - `hidratar(contactId: string, deps: DepsGhl): Promise<{ ok: true; conversacion: Conversacion } | { ok: false; error: string }>`
  - `ultimoReal(c: Conversacion): MensajeReal | undefined`
  - `huboRespuestaHumana(c: Conversacion, enviados: string[]): boolean`

- [ ] **Step 1: Escribir las pruebas que fallan**

Crear `tests/agente-conversacion.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { hidratar, ultimoReal, huboRespuestaHumana } from '@/lib/agente/conversacion';
import type { Conversacion } from '@/lib/agente/conversacion';

const deps = { apiKey: 'llave', locationId: 'ubicacion' };

// Simula las dos llamadas en cadena: primero /conversations/search, luego
// /conversations/{id}/messages.
function ghl(busqueda: unknown, mensajes: unknown) {
  return vi
    .fn()
    .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify(busqueda) })
    .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify(mensajes) });
}

const UNA_CONVERSACION = { conversations: [{ id: 'conv-1' }] };

function msg(over: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    messageType: 'TYPE_WHATSAPP',
    direction: 'inbound',
    body: 'Hola',
    dateAdded: '2026-08-24T10:00:00.000Z',
    attachments: [],
    ...over,
  };
}

describe('hidratar', () => {
  it('devuelve los mensajes reales de la conversación', async () => {
    const fetchImpl = ghl(UNA_CONVERSACION, { messages: { messages: [msg()] } });
    const r = await hidratar('c1', { ...deps, fetchImpl });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.conversacion.conversationId).toBe('conv-1');
    expect(r.conversacion.mensajes).toHaveLength(1);
    expect(r.conversacion.mensajes[0].texto).toBe('Hola');
  });

  it('acepta también la forma plana del array de mensajes', async () => {
    const fetchImpl = ghl(UNA_CONVERSACION, { messages: [msg()] });
    const r = await hidratar('c1', { ...deps, fetchImpl });
    expect(r.ok && r.conversacion.mensajes).toHaveLength(1);
  });

  // El caso que motiva el proyecto entero.
  it('descarta las actividades del CRM y deja la conversación vacía', async () => {
    const fetchImpl = ghl(UNA_CONVERSACION, {
      messages: {
        messages: [
          msg({ id: 'a1', messageType: 'TYPE_ACTIVITY_OPPORTUNITY', direction: 'outbound', body: 'Opportunity created' }),
          msg({ id: 'a2', messageType: 'TYPE_ACTIVITY_CONTACT', direction: 'inbound', body: 'DnD enabled by customer' }),
        ],
      },
    });
    const r = await hidratar('c1', { ...deps, fetchImpl });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.conversacion.mensajes).toEqual([]);
  });

  // No confiamos en el orden que devuelva GHL. Ordenamos nosotros por fecha,
  // porque toda la guarda anti-bucle depende de saber cuál es el ÚLTIMO.
  it('ordena por fecha ascendente sin importar cómo lleguen', async () => {
    const fetchImpl = ghl(UNA_CONVERSACION, {
      messages: {
        messages: [
          msg({ id: 'nuevo', dateAdded: '2026-08-24T12:00:00.000Z', body: 'segundo' }),
          msg({ id: 'viejo', dateAdded: '2026-08-24T09:00:00.000Z', body: 'primero' }),
        ],
      },
    });
    const r = await hidratar('c1', { ...deps, fetchImpl });
    if (!r.ok) throw new Error('debía hidratar');
    expect(r.conversacion.mensajes.map((m) => m.id)).toEqual(['viejo', 'nuevo']);
  });

  it('conserva los adjuntos', async () => {
    const fetchImpl = ghl(UNA_CONVERSACION, {
      messages: { messages: [msg({ attachments: ['https://cdn/x.ogg'] })] },
    });
    const r = await hidratar('c1', { ...deps, fetchImpl });
    expect(r.ok && r.conversacion.mensajes[0].adjuntos).toEqual(['https://cdn/x.ogg']);
  });

  it('falla limpio cuando el contacto no tiene conversación', async () => {
    const fetchImpl = ghl({ conversations: [] }, {});
    const r = await hidratar('c1', { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
  });

  it('falla limpio cuando GHL devuelve un error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'no autorizado' });
    const r = await hidratar('c1', { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('401');
  });

  // El spec §10 pide un reintento con espera antes de rendirse: un 5xx puntual
  // de GHL no debería costarle la respuesta al cliente.
  it('reintenta una vez ante un 5xx y sale adelante', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'boom' })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify(UNA_CONVERSACION) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ messages: { messages: [msg()] } }) });
    const r = await hidratar('c1', { ...deps, fetchImpl });
    expect(r.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('no reintenta un 401: reintentar un problema de permisos sólo gasta tiempo', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'no autorizado' });
    await hidratar('c1', { ...deps, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falla limpio cuando la red se cae, sin lanzar', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const r = await hidratar('c1', { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
  });

  // Sesgo seguro: lo ambiguo se lee como saliente. Ver el comentario en
  // aMensajeReal — el default contrario abriría un bucle de autorrespuesta.
  it('trata como saliente un mensaje con direction ausente o ilegible', async () => {
    const fetchImpl = ghl(UNA_CONVERSACION, {
      messages: { messages: [msg({ direction: undefined }), msg({ id: 'raro', direction: 'de-lado' })] },
    });
    const r = await hidratar('c1', { ...deps, fetchImpl });
    if (!r.ok) throw new Error('debía hidratar');
    expect(r.conversacion.mensajes.map((m) => m.direccion)).toEqual(['outbound', 'outbound']);
  });

  it('un mensaje sin fecha legible no puede colarse como el último', async () => {
    const fetchImpl = ghl(UNA_CONVERSACION, {
      messages: {
        messages: [
          msg({ id: 'con-fecha', dateAdded: '2026-08-24T10:00:00.000Z' }),
          msg({ id: 'sin-fecha', dateAdded: undefined }),
        ],
      },
    });
    const r = await hidratar('c1', { ...deps, fetchImpl });
    if (!r.ok) throw new Error('debía hidratar');
    const ultimo = r.conversacion.mensajes[r.conversacion.mensajes.length - 1];
    expect(ultimo.id).toBe('con-fecha');
  });

  it('falla limpio cuando el cuerpo no es JSON', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: async () => '<html>502 Bad Gateway</html>' });
    const r = await hidratar('c1', { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
  });

  it('no revienta cuando attachments no es un array', async () => {
    const fetchImpl = ghl(UNA_CONVERSACION, {
      messages: { messages: [msg({ attachments: 'no-soy-un-array' })] },
    });
    const r = await hidratar('c1', { ...deps, fetchImpl });
    expect(r.ok && r.conversacion.mensajes[0].adjuntos).toEqual([]);
  });

  it('manda el bearer y la versión de conversaciones', async () => {
    const fetchImpl = ghl(UNA_CONVERSACION, { messages: { messages: [] } });
    await hidratar('c1', { ...deps, fetchImpl });
    const headers = fetchImpl.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe('Bearer llave');
    expect(headers.Version).toBe('2021-04-15');
  });
});

function conv(mensajes: Conversacion['mensajes']): Conversacion {
  return { conversationId: 'conv-1', mensajes };
}

const real = (over: Partial<Conversacion['mensajes'][number]> = {}) => ({
  id: 'm', tipo: 'TYPE_WHATSAPP' as const, direccion: 'inbound' as const,
  texto: 't', adjuntos: [], ...over,
});

describe('ultimoReal', () => {
  it('devuelve el último de la lista', () => {
    const c = conv([real({ id: 'a' }), real({ id: 'b' })]);
    expect(ultimoReal(c)?.id).toBe('b');
  });

  it('devuelve undefined si no hay ninguno', () => {
    expect(ultimoReal(conv([]))).toBeUndefined();
  });
});

describe('huboRespuestaHumana', () => {
  it('es falso cuando todos los salientes los mandó el agente', () => {
    const c = conv([real({ id: 'in' }), real({ id: 'mio', direccion: 'outbound' })]);
    expect(huboRespuestaHumana(c, ['mio'])).toBe(false);
  });

  // Si esto falla, el bot le habla encima al asesor delante del cliente.
  it('es verdadero cuando aparece un saliente que el agente no mandó', () => {
    const c = conv([real({ id: 'in' }), real({ id: 'del-asesor', direccion: 'outbound' })]);
    expect(huboRespuestaHumana(c, ['mio'])).toBe(true);
  });

  it('ignora los entrantes: el cliente nunca es "el humano" de esta guarda', () => {
    const c = conv([real({ id: 'x' }), real({ id: 'y' })]);
    expect(huboRespuestaHumana(c, [])).toBe(false);
  });

  // Con la base comercial entrando en prospección manual, éste es el caso que
  // decide si el agente sirve de algo con los contactos que ya existen.
  it('un saliente ajeno anterior al último entrante es historia, no una toma de control', () => {
    const c = conv([
      real({ id: 'correo-viejo-del-asesor', direccion: 'outbound' }),
      real({ id: 'escribe-ahora' }),
    ]);
    expect(huboRespuestaHumana(c, [])).toBe(false);
  });

  it('es falso cuando no hay ningún entrante del que tomar el control', () => {
    const c = conv([real({ id: 'solo-saliente', direccion: 'outbound' })]);
    expect(huboRespuestaHumana(c, [])).toBe(false);
  });
});
```

- [ ] **Step 2: Ejecutar y verificar que falla**

Run: `npx vitest run tests/agente-conversacion.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/agente/conversacion"`

- [ ] **Step 3: Escribir `lib/agente/conversacion.ts`**

```ts
import { config } from '@/lib/agente/config';
import { esMensajeReal, type TipoReal } from '@/lib/agente/canal';

export type MensajeReal = {
  id: string;
  tipo: TipoReal;
  direccion: 'inbound' | 'outbound';
  texto: string;
  adjuntos: string[];
};

export type Conversacion = {
  conversationId: string;
  // Orden cronológico ascendente: el más reciente al final.
  mensajes: MensajeReal[];
};

export type DepsGhl = {
  apiKey: string;
  locationId: string;
  fetchImpl?: typeof fetch;
};

type Resultado =
  | { ok: true; conversacion: Conversacion }
  | { ok: false; error: string };

function cabeceras(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Version: config.VERSION_CONVERSACIONES,
    Accept: 'application/json',
  };
}

// GHL devuelve los mensajes bajo `messages.messages` en unas respuestas y bajo
// `messages` en otras. Igual que `upsertContact` acepta las dos formas del
// contacto, aceptamos las dos formas aquí.
function extraerCrudos(datos: unknown): unknown[] {
  const d = datos as { messages?: { messages?: unknown[] } | unknown[] };
  if (Array.isArray(d?.messages)) return d.messages;
  const anidado = (d?.messages as { messages?: unknown[] })?.messages;
  return Array.isArray(anidado) ? anidado : [];
}

function aMensajeReal(crudo: unknown): MensajeReal | null {
  const m = crudo as {
    id?: string; messageType?: string; direction?: string;
    body?: string; attachments?: unknown;
  };
  if (!m?.id || !esMensajeReal(m.messageType)) return null;

  return {
    id: m.id,
    tipo: m.messageType,
    // Si `direction` llega ausente o ilegible, se asume SALIENTE. Es el sesgo
    // seguro en las DOS guardas: un mensaje ambiguo al final hace que el agente
    // no responda, y `huboRespuestaHumana` lo cuenta como humano y lo calla.
    // Al revés sería peor de lo que parece — un saliente PROPIO con la dirección
    // corrupta se leería como entrante, el agente se contestaría a sí mismo, y
    // esa respuesta volvería a entrar por el webhook: bucle infinito pagando
    // cada vuelta.
    direccion: m.direction === 'inbound' ? 'inbound' : 'outbound',
    texto: typeof m.body === 'string' ? m.body : '',
    adjuntos: Array.isArray(m.attachments)
      ? m.attachments.filter((a): a is string => typeof a === 'string')
      : [],
  };
}

function fechaDe(crudo: unknown): number {
  const t = Date.parse((crudo as { dateAdded?: string })?.dateAdded ?? '');
  return Number.isNaN(t) ? 0 : t;
}

// Un reintento y sólo uno, ante un fallo de red o un 5xx. Un 4xx no se
// reintenta: un problema de permisos o de parámetros no mejora insistiendo,
// y el cliente estaría esperando mientras tanto.
async function pedir(url: string, apiKey: string, fetchImpl: typeof fetch): Promise<Response> {
  try {
    const res = await fetchImpl(url, { headers: cabeceras(apiKey) });
    if (res.status < 500) return res;
  } catch {
    // Cae al reintento de abajo. Si ese también falla, lo recoge el try/catch
    // de hidratar.
  }
  await new Promise((r) => setTimeout(r, 400));
  return fetchImpl(url, { headers: cabeceras(apiKey) });
}

export async function hidratar(contactId: string, deps: DepsGhl): Promise<Resultado> {
  const { apiKey, locationId, fetchImpl = fetch } = deps;

  try {
    const busqueda = await pedir(
      `${config.BASE_GHL}/conversations/search?locationId=${encodeURIComponent(locationId)}&contactId=${encodeURIComponent(contactId)}`,
      apiKey, fetchImpl,
    );
    const textoBusqueda = await busqueda.text();
    if (!busqueda.ok) {
      return { ok: false, error: `GHL search ${busqueda.status}: ${textoBusqueda.slice(0, 200)}` };
    }

    const conversationId = (
      JSON.parse(textoBusqueda) as { conversations?: { id?: string }[] }
    ).conversations?.[0]?.id;
    if (!conversationId) {
      return { ok: false, error: 'El contacto no tiene ninguna conversación en GHL.' };
    }

    const res = await pedir(
      `${config.BASE_GHL}/conversations/${conversationId}/messages?limit=20`,
      apiKey, fetchImpl,
    );
    const texto = await res.text();
    if (!res.ok) {
      return { ok: false, error: `GHL messages ${res.status}: ${texto.slice(0, 200)}` };
    }

    // Ordenamos nosotros en vez de confiar en el orden de GHL: toda la guarda
    // anti-bucle depende de saber con certeza cuál es el último mensaje, y un
    // cambio de orden en la API la rompería en silencio.
    const mensajes = extraerCrudos(JSON.parse(texto))
      .slice()
      .sort((a, b) => fechaDe(a) - fechaDe(b))
      .map(aMensajeReal)
      .filter((m): m is MensajeReal => m !== null);

    return { ok: true, conversacion: { conversationId, mensajes } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function ultimoReal(c: Conversacion): MensajeReal | undefined {
  return c.mensajes[c.mensajes.length - 1];
}

// Guarda 2. Cualquier saliente de canal real cuyo id no esté en `enviados`
// lo escribió una persona del equipo. Equivocarse aquí significa el bot
// hablándole encima al asesor delante del cliente, así que ante la duda
// (un id que no pudimos registrar) esta función dice que sí hubo humano
// y el agente calla de más — que es el fallo seguro.
//
// Sólo cuentan los salientes POSTERIORES al último entrante. Un correo que un
// asesor mandó hace meses, antes de que esta persona escribiera, es historia y
// no una toma de control: con la base comercial entrando en prospección manual,
// mirar la conversación entera dejaría mudo al agente en todo contacto que un
// asesor hubiera tocado alguna vez.
//
// La permanencia no la da este escaneo sino el latch de estado: en cuanto se
// detecta, el contacto pasa a 'humano' y procesar() ni vuelve a hidratarlo.
export function huboRespuestaHumana(c: Conversacion, enviados: string[]): boolean {
  const ultimoEntrante = c.mensajes.map((m) => m.direccion).lastIndexOf('inbound');
  // Sin ningún entrante no hay conversación que nadie pueda haber tomado.
  if (ultimoEntrante === -1) return false;

  const mios = new Set(enviados);
  return c.mensajes
    .slice(ultimoEntrante + 1)
    .some((m) => m.direccion === 'outbound' && !mios.has(m.id));
}
```

- [ ] **Step 4: Ejecutar y verificar que pasa**

Run: `npx vitest run tests/agente-conversacion.test.ts`
Expected: PASS, 22 pruebas.

- [ ] **Step 5: Commit**

```bash
git add lib/agente/conversacion.ts tests/agente-conversacion.test.ts
git commit -m "feat(agente): hidratación de la conversación desde GHL

Re-consulta los mensajes por contactId porque el webhook llega sin texto,
filtra las actividades del CRM y ordena por fecha en vez de confiar en el
orden de la API."
```

---

### Task 4: `lib/agente/estado.ts` — estado y candado anti-duplicado

**Files:**
- Create: `lib/agente/estado.ts`
- Test: `tests/agente-estado.test.ts`

**Interfaces:**
- Consumes: `Producto` de `@/lib/agente/config`. El cliente de Supabase se inyecta, no se importa.
- Produces:
  - re-exporta `type Producto`
  - `type Datos = { nombre: string|null; email: string|null; telefono: string|null; producto: Producto|null; ubicacion: string|null }`
  - `type EstadoAgente = 'activo' | 'humano' | 'agotado' | 'email_respondido'`
  - `type Fila = { contact_id: string; conversation_id: string|null; canal: string|null; estado: EstadoAgente; turnos: number; datos: Datos; ultimo_mensaje_id: string|null; enviados: string[]; notificado_at: string|null }`
  - `DATOS_VACIOS: Datos`
  - `type Db = { from: (tabla: string) => any }` — el cliente de `supabaseAdmin()`
  - `leerOCrear(contactId: string, db: Db): Promise<Fila>`
  - `tomarMensaje(contactId: string, mensajeId: string, db: Db): Promise<boolean>`
  - `guardar(contactId: string, cambios: Partial<Fila>, db: Db): Promise<void>`
  - `fusionarDatos(previos: Datos, nuevos: Partial<Datos>): Datos`

- [ ] **Step 1: Escribir las pruebas que fallan**

Crear `tests/agente-estado.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { fusionarDatos, tomarMensaje, leerOCrear, guardar, DATOS_VACIOS } from '@/lib/agente/estado';

describe('fusionarDatos', () => {
  it('rellena lo que faltaba', () => {
    const r = fusionarDatos(DATOS_VACIOS, { nombre: 'Ana Pérez' });
    expect(r.nombre).toBe('Ana Pérez');
  });

  // El modelo devuelve el objeto completo con nulls en lo que no supo. Si un
  // null pisara un dato ya capturado, el agente perdería el correo del cliente
  // en el turno siguiente y lo volvería a pedir.
  it('un null nuevo nunca borra un dato que ya teníamos', () => {
    const previos = { ...DATOS_VACIOS, email: 'ana@empresa.com' };
    const r = fusionarDatos(previos, { email: null, nombre: 'Ana' });
    expect(r.email).toBe('ana@empresa.com');
    expect(r.nombre).toBe('Ana');
  });

  it('una cadena vacía tampoco borra', () => {
    const previos = { ...DATOS_VACIOS, telefono: '+502 5555 5555' };
    expect(fusionarDatos(previos, { telefono: '   ' }).telefono).toBe('+502 5555 5555');
  });

  it('un valor nuevo sí corrige uno anterior', () => {
    const previos = { ...DATOS_VACIOS, ubicacion: 'Guatemala' };
    expect(fusionarDatos(previos, { ubicacion: 'San Salvador' }).ubicacion).toBe('San Salvador');
  });
});

// El candado de la guarda 3. Se prueba contra un doble del cliente de Supabase
// que registra el filtro `or` construido, porque ese filtro es justamente la
// parte fácil de escribir mal.
function dbFalso(filasDevueltas: unknown[], error: unknown = null) {
  const registro: { or?: string; update?: unknown } = {};
  const db = {
    from: () => ({
      update: (campos: unknown) => {
        registro.update = campos;
        return {
          eq: () => ({
            or: (filtro: string) => {
              registro.or = filtro;
              return { select: async () => ({ data: filasDevueltas, error }) };
            },
          }),
        };
      },
    }),
  };
  return { db, registro };
}

describe('tomarMensaje', () => {
  it('devuelve true cuando gana la carrera', async () => {
    const { db } = dbFalso([{ contact_id: 'c1' }]);
    expect(await tomarMensaje('c1', 'm-99', db as never)).toBe(true);
  });

  // Reintento de GHL o el cliente mandando tres mensajes seguidos: sólo uno
  // debe responder. Si esto devuelve true dos veces, el cliente recibe dos
  // respuestas del bot.
  it('devuelve false cuando otro proceso ya tomó ese mensaje', async () => {
    const { db } = dbFalso([]);
    expect(await tomarMensaje('c1', 'm-99', db as never)).toBe(false);
  });

  // `neq` a secas no matchea filas con NULL, porque en SQL `NULL <> 'x'` es
  // NULL, no true. Una fila recién creada nunca podría reclamarse.
  it('el filtro contempla la fila nueva con ultimo_mensaje_id en NULL', async () => {
    const { db, registro } = dbFalso([{ contact_id: 'c1' }]);
    await tomarMensaje('c1', 'm-99', db as never);
    expect(registro.or).toContain('ultimo_mensaje_id.is.null');
    expect(registro.or).toContain('ultimo_mensaje_id.neq.m-99');
  });

  it('rechaza un id con caracteres que romperían el filtro, en vez de inyectarlo', async () => {
    const { db } = dbFalso([{ contact_id: 'c1' }]);
    await expect(tomarMensaje('c1', 'm,99)', db as never)).rejects.toThrow();
  });

  // Un fallo de base y un duplicado legítimo producen el mismo `data` vacío.
  // Si esto devolviera false, el agente se saltaría en silencio a un cliente
  // real y en el log parecería un reintento normal de GHL.
  it('lanza si la base falla, en vez de devolver false', async () => {
    const { db } = dbFalso([], { message: 'connection reset' });
    await expect(tomarMensaje('c1', 'm-99', db as never)).rejects.toThrow(/connection reset/);
  });
});

// Doble del cliente para las rutas de lectura y alta.
function dbLectura(fila: unknown, error: unknown = null, errorAlta: unknown = null) {
  const registro: { upsert?: unknown } = {};
  const db = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: fila, error }) }) }),
      upsert: async (nueva: unknown) => {
        registro.upsert = nueva;
        return { error: errorAlta };
      },
    }),
  };
  return { db, registro };
}

const FILA_COMPLETA = {
  contact_id: 'c1', conversation_id: null, canal: null, estado: 'activo',
  turnos: 0, datos: {}, ultimo_mensaje_id: null, enviados: [], notificado_at: null,
};

describe('leerOCrear', () => {
  it('devuelve la fila existente con los datos completados', async () => {
    const { db } = dbLectura({ ...FILA_COMPLETA, turnos: 2, datos: { nombre: 'Ana Pérez' } });
    const fila = await leerOCrear('c1', db as never);
    expect(fila.turnos).toBe(2);
    expect(fila.datos).toEqual({ ...DATOS_VACIOS, nombre: 'Ana Pérez' });
  });

  it('da de alta el contacto la primera vez que lo ve', async () => {
    const { db, registro } = dbLectura(null);
    const fila = await leerOCrear('c1', db as never);
    expect(fila.estado).toBe('activo');
    expect(fila.turnos).toBe(0);
    expect(registro.upsert).toMatchObject({ contact_id: 'c1' });
  });

  // Si las dos ramas devolvieran formas distintas, los consumidores fallarían
  // de maneras difíciles de rastrear: sólo con contactos nuevos, o sólo con
  // los ya vistos.
  it('las dos ramas devuelven exactamente las mismas claves', async () => {
    const existente = await leerOCrear('c1', dbLectura(FILA_COMPLETA).db as never);
    const nueva = await leerOCrear('c1', dbLectura(null).db as never);
    expect(Object.keys(nueva).sort()).toEqual(Object.keys(existente).sort());
  });

  // El caso grave: Supabase devuelve data null tanto si el contacto no existe
  // como si la consulta falló. Tratar el fallo como contacto nuevo resucitaría
  // a uno marcado 'humano' con los turnos a cero, y el agente volvería a hablar
  // encima del asesor.
  it('lanza si la lectura falla, en vez de fingir un contacto nuevo', async () => {
    const { db } = dbLectura(null, { message: 'timeout' });
    await expect(leerOCrear('c1', db as never)).rejects.toThrow(/timeout/);
  });

  it('lanza si el alta falla', async () => {
    const { db } = dbLectura(null, null, { message: 'conflicto' });
    await expect(leerOCrear('c1', db as never)).rejects.toThrow(/conflicto/);
  });
});

function dbGuardar(error: unknown = null) {
  const registro: { update?: Record<string, unknown> } = {};
  const db = {
    from: () => ({
      update: (campos: Record<string, unknown>) => {
        registro.update = campos;
        return { eq: async () => ({ error }) };
      },
    }),
  };
  return { db, registro };
}

describe('guardar', () => {
  it('escribe los cambios y sella updated_at', async () => {
    const { db, registro } = dbGuardar();
    await guardar('c1', { turnos: 3 }, db as never);
    expect(registro.update).toMatchObject({ turnos: 3 });
    expect(typeof registro.update?.updated_at).toBe('string');
  });

  // No lanza a propósito: al cliente ya se le respondió y fallar el turno no
  // desharía el envío. Pero tiene que verse, porque perder esta escritura
  // pierde el id que alimenta la guarda del humano.
  it('no lanza si la escritura falla, pero deja rastro en el log', async () => {
    const espia = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db } = dbGuardar({ message: 'disco lleno' });
    await expect(guardar('c1', { turnos: 3 }, db as never)).resolves.toBeUndefined();
    expect(espia).toHaveBeenCalled();
    espia.mockRestore();
  });
});
```

- [ ] **Step 2: Ejecutar y verificar que falla**

Run: `npx vitest run tests/agente-estado.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/agente/estado"`

- [ ] **Step 3: Escribir `lib/agente/estado.ts`**

```ts
import type { Producto } from '@/lib/agente/config';

export type { Producto };

export type Datos = {
  nombre: string | null;
  email: string | null;
  telefono: string | null;
  producto: Producto | null;
  ubicacion: string | null;
};

export const DATOS_VACIOS: Datos = {
  nombre: null, email: null, telefono: null, producto: null, ubicacion: null,
};

export type EstadoAgente = 'activo' | 'humano' | 'agotado' | 'email_respondido';

export type Fila = {
  contact_id: string;
  conversation_id: string | null;
  canal: string | null;
  estado: EstadoAgente;
  turnos: number;
  datos: Datos;
  ultimo_mensaje_id: string | null;
  enviados: string[];
  notificado_at: string | null;
};

// El cliente que devuelve supabaseAdmin(). Se inyecta para poder probar sin
// base de datos, igual que fetchImpl en lib/ghl.ts.
export type Db = { from: (tabla: string) => any };

const TABLA = 'agente_conversaciones';

export function fusionarDatos(previos: Datos, nuevos: Partial<Datos>): Datos {
  const fusionado = { ...previos };
  for (const clave of Object.keys(DATOS_VACIOS) as (keyof Datos)[]) {
    const valor = nuevos[clave];
    // Un null o una cadena en blanco significan "no lo supe en este turno",
    // no "bórralo". El modelo devuelve el objeto entero cada vez, así que sin
    // esta condición perderíamos el correo del cliente en el turno siguiente.
    if (typeof valor === 'string' && valor.trim() !== '') {
      (fusionado[clave] as string) = valor.trim();
    }
  }
  return fusionado;
}

export async function leerOCrear(contactId: string, db: Db): Promise<Fila> {
  const { data, error } = await db.from(TABLA).select('*').eq('contact_id', contactId).maybeSingle();

  // Un error de lectura NO puede confundirse con "contacto nuevo". Supabase
  // devuelve data null en ambos casos, y tratarlo como fila fresca sería grave:
  // un contacto ya marcado 'humano' o 'agotado' volvería a parecer 'activo' con
  // los turnos a cero, y el agente empezaría a hablar otra vez sobre una
  // conversación que un asesor ya había tomado. Se lanza para que el fallo se
  // vea en el log del webhook en vez de convertirse en un bot indeseado.
  if (error) {
    throw new Error(`[agente] No se pudo leer el estado de ${contactId}: ${error.message}`);
  }

  if (data) return { ...data, datos: { ...DATOS_VACIOS, ...(data.datos ?? {}) } } as Fila;

  const nueva = { contact_id: contactId, estado: 'activo', turnos: 0, datos: DATOS_VACIOS, enviados: [] };
  const { error: errorAlta } = await db.from(TABLA).upsert(nueva, { onConflict: 'contact_id' });
  if (errorAlta) {
    throw new Error(`[agente] No se pudo crear el estado de ${contactId}: ${errorAlta.message}`);
  }

  return { ...nueva, conversation_id: null, canal: null, ultimo_mensaje_id: null, notificado_at: null } as Fila;
}

// Guarda 3. UPDATE condicional: si la fila ya tiene registrado este mismo
// mensaje, no devuelve nada y el turno se abandona. Es lo que hace que un
// reintento de GHL no produzca una segunda respuesta al cliente.
export async function tomarMensaje(contactId: string, mensajeId: string, db: Db): Promise<boolean> {
  // El filtro `or` de PostgREST se construye como texto, así que una coma o un
  // paréntesis en el id lo partirían y cambiarían la condición. Los ids de GHL
  // son alfanuméricos; cualquier otra cosa es señal de algo raro y se rechaza
  // en vez de mandarse a la base.
  if (!/^[A-Za-z0-9_-]+$/.test(mensajeId)) {
    throw new Error(`[agente] Id de mensaje con forma inesperada: ${mensajeId.slice(0, 20)}`);
  }

  const { data, error } = await db
    .from(TABLA)
    .update({ ultimo_mensaje_id: mensajeId, updated_at: new Date().toISOString() })
    .eq('contact_id', contactId)
    // `neq` a secas no matchea NULL (en SQL `NULL <> 'x'` es NULL, no true),
    // así que una fila recién creada nunca podría reclamarse. El `or` con
    // `is.null` cubre ese caso.
    .or(`ultimo_mensaje_id.is.null,ultimo_mensaje_id.neq.${mensajeId}`)
    .select('contact_id');

  // Un fallo de base NO es lo mismo que "otro proceso ya lo tomó". Devolver
  // false aquí haría que el agente se saltara en silencio el mensaje de un
  // cliente real — que es exactamente el silencio que este proyecto existe para
  // evitar, y encima indistinguible de un duplicado legítimo en los logs.
  if (error) {
    throw new Error(`[agente] Falló el candado de ${contactId}: ${error.message}`);
  }

  return Array.isArray(data) && data.length > 0;
}

export async function guardar(contactId: string, cambios: Partial<Fila>, db: Db): Promise<void> {
  const { error } = await db
    .from(TABLA)
    .update({ ...cambios, updated_at: new Date().toISOString() })
    .eq('contact_id', contactId);

  // Aquí NO se lanza: al cliente ya se le respondió y hacer fallar el turno no
  // desharía ese envío. Pero tiene que verse, porque un fallo aquí pierde el id
  // que alimenta la guarda del humano y el contador de turnos.
  if (error) {
    console.error('[agente] No se pudo guardar el estado.', 'contacto:', contactId, error.message);
  }
}
```

- [ ] **Step 4: Ejecutar y verificar que pasa**

Run: `npx vitest run tests/agente-estado.test.ts`
Expected: PASS, 10 pruebas.

- [ ] **Step 5: Commit**

```bash
git add lib/agente/estado.ts tests/agente-estado.test.ts
git commit -m "feat(agente): estado en Supabase y candado anti-duplicado

El UPDATE condicional contempla la fila nueva con ultimo_mensaje_id en NULL,
porque neq a secas no matchea NULL y esa fila nunca podría reclamarse."
```

---

### Task 5: `lib/agente/medios.ts` — audio e imágenes

**Files:**
- Create: `lib/agente/medios.ts`
- Test: `tests/agente-medios.test.ts`

**Interfaces:**
- Consumes: nada de tareas previas.
- Produces:
  - `type BloqueImagen = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }`
  - `type Medios = { bloques: BloqueImagen[]; transcripciones: string[]; fallos: number }`
  - `prepararMedios(urls: string[], deps: { openaiKey: string; fetchImpl?: typeof fetch }): Promise<Medios>`

- [ ] **Step 1: Escribir las pruebas que fallan**

Crear `tests/agente-medios.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { prepararMedios } from '@/lib/agente/medios';

const deps = { openaiKey: 'sk-prueba' };

function descarga(bytes: number, contentType: string) {
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => new ArrayBuffer(bytes),
  };
}

function transcripcion(texto: string) {
  return { ok: true, status: 200, text: async () => JSON.stringify({ text: texto }) };
}

describe('prepararMedios', () => {
  it('convierte una imagen en bloque base64 para Claude', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(descarga(10, 'image/jpeg'));
    const r = await prepararMedios(['https://cdn/foto.jpg'], { ...deps, fetchImpl });
    expect(r.bloques).toHaveLength(1);
    expect(r.bloques[0].source.media_type).toBe('image/jpeg');
    expect(typeof r.bloques[0].source.data).toBe('string');
    expect(r.fallos).toBe(0);
  });

  it('transcribe un audio y no lo manda como imagen', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(descarga(10, 'audio/ogg'))
      .mockResolvedValueOnce(transcripcion('Necesito cotizar 200 filipinas'));
    const r = await prepararMedios(['https://cdn/nota.ogg'], { ...deps, fetchImpl });
    expect(r.transcripciones).toEqual(['Necesito cotizar 200 filipinas']);
    expect(r.bloques).toHaveLength(0);
  });

  it('deduce el tipo por la extensión cuando el content-type no sirve', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(descarga(10, 'application/octet-stream'))
      .mockResolvedValueOnce(transcripcion('hola'));
    const r = await prepararMedios(['https://cdn/nota.m4a'], { ...deps, fetchImpl });
    expect(r.transcripciones).toEqual(['hola']);
  });

  // Claude rechaza imágenes por encima de ~5 MB. Mandarla igual es un 400 que
  // tumbaría la respuesta entera por una foto; mejor perder la foto.
  it('descarta una imagen demasiado grande y lo cuenta como fallo', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(descarga(6 * 1024 * 1024, 'image/png'));
    const r = await prepararMedios(['https://cdn/enorme.png'], { ...deps, fetchImpl });
    expect(r.bloques).toHaveLength(0);
    expect(r.fallos).toBe(1);
  });

  it('un adjunto que falla no arrastra a los demás', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(descarga(10, 'image/png'));
    const r = await prepararMedios(['https://cdn/rota.png', 'https://cdn/buena.png'], { ...deps, fetchImpl });
    expect(r.bloques).toHaveLength(1);
    expect(r.fallos).toBe(1);
  });

  it('cuenta como fallo el audio cuando Whisper devuelve error', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(descarga(10, 'audio/ogg'))
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });
    const r = await prepararMedios(['https://cdn/nota.ogg'], { ...deps, fetchImpl });
    expect(r.transcripciones).toEqual([]);
    expect(r.fallos).toBe(1);
  });

  it('ignora los tipos que no sabe tratar sin contarlos como fallo del cliente', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(descarga(10, 'application/pdf'));
    const r = await prepararMedios(['https://cdn/catalogo.pdf'], { ...deps, fetchImpl });
    expect(r.bloques).toHaveLength(0);
    expect(r.transcripciones).toEqual([]);
  });

  // El caso real de GHL: sus URLs de CDN no traen extensión y el content-type
  // llega genérico. Antes esto se descartaba en silencio, sin avisar al modelo.
  it('cuenta como fallo lo que no puede clasificar, para que el modelo pueda preguntar', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(descarga(10, 'application/octet-stream'));
    const r = await prepararMedios(['https://files.leadconnectorhq.com/uploads/abc123'], { ...deps, fetchImpl });
    expect(r.bloques).toHaveLength(0);
    expect(r.transcripciones).toEqual([]);
    expect(r.fallos).toBe(1);
  });

  it('cuenta como fallo una descarga que responde con error HTTP', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    const r = await prepararMedios(['https://cdn/borrada.jpg'], { ...deps, fetchImpl });
    expect(r.bloques).toHaveLength(0);
    expect(r.fallos).toBe(1);
  });

  it('no llama a la red cuando no hay adjuntos', async () => {
    const fetchImpl = vi.fn();
    const r = await prepararMedios([], { ...deps, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r).toEqual({ bloques: [], transcripciones: [], fallos: 0 });
  });
});
```

- [ ] **Step 2: Ejecutar y verificar que falla**

Run: `npx vitest run tests/agente-medios.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/agente/medios"`

- [ ] **Step 3: Escribir `lib/agente/medios.ts`**

```ts
// Las imágenes van directas a Claude, que las procesa de forma nativa.
// Sólo el audio necesita OpenAI: es lo único que Claude no puede leer.

export type BloqueImagen = {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
};

export type Medios = {
  bloques: BloqueImagen[];
  transcripciones: string[];
  fallos: number;
};

type Deps = { openaiKey: string; fetchImpl?: typeof fetch };

// Claude rechaza imágenes por encima de ~5 MB con un 400 que tumbaría la
// respuesta entera. Perder la foto es preferible a perder la conversación.
const MAX_IMAGEN = 5 * 1024 * 1024;

const IMAGENES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const EXT_IMAGEN: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', webp: 'image/webp',
};
const EXT_AUDIO = ['ogg', 'oga', 'opus', 'mp3', 'm4a', 'wav', 'amr', 'mp4', 'webm'];

function extension(url: string): string {
  const limpia = url.split('?')[0].split('#')[0];
  return (limpia.split('.').pop() ?? '').toLowerCase();
}

function normalizar(contentType: string | null): string {
  return (contentType ?? '').split(';')[0].trim().toLowerCase();
}

const GENERICOS = ['', 'application/octet-stream', 'binary/octet-stream'];

// GHL no siempre manda un content-type útil (a veces application/octet-stream),
// así que la extensión de la URL es el desempate.
//
// 'otro' y 'desconocido' NO son lo mismo, y confundirlos costaría adjuntos:
// 'otro' es un tipo que identificamos y sabemos que no tratamos —un PDF seguirá
// siendo un PDF por mucho que el cliente lo reenvíe, así que no es un fallo
// suyo—, mientras que 'desconocido' es que ninguna de las dos señales dijo
// nada. Eso último pasa de verdad: las URLs del CDN de GHL vienen sin extensión
// (files.leadconnectorhq.com/uploads/abc123) y a veces con content-type
// genérico, así que una foto real puede caer aquí. Se cuenta como fallo para
// que el modelo sepa pedirla por escrito en vez de descartarla en silencio.
function clasificar(url: string, contentType: string | null): 'imagen' | 'audio' | 'otro' | 'desconocido' {
  const ct = normalizar(contentType);
  if (IMAGENES.includes(ct)) return 'imagen';
  if (ct.startsWith('audio/') || ct === 'video/mp4' || ct === 'video/webm') return 'audio';

  const ext = extension(url);
  if (EXT_IMAGEN[ext]) return 'imagen';
  if (EXT_AUDIO.includes(ext)) return 'audio';

  return GENERICOS.includes(ct) ? 'desconocido' : 'otro';
}

function tipoImagen(url: string, contentType: string | null): string {
  const ct = normalizar(contentType);
  if (IMAGENES.includes(ct)) return ct;
  return EXT_IMAGEN[extension(url)] ?? 'image/jpeg';
}

async function transcribir(
  bytes: ArrayBuffer, url: string, openaiKey: string, fetchImpl: typeof fetch,
): Promise<string | null> {
  const forma = new FormData();
  forma.append('file', new Blob([bytes]), `audio.${extension(url) || 'ogg'}`);
  forma.append('model', 'whisper-1');

  const res = await fetchImpl('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${openaiKey}` },
    body: forma,
  });
  if (!res.ok) return null;

  const texto = (JSON.parse(await res.text()) as { text?: string }).text;
  return typeof texto === 'string' && texto.trim() ? texto.trim() : null;
}

export async function prepararMedios(urls: string[], deps: Deps): Promise<Medios> {
  const { openaiKey, fetchImpl = fetch } = deps;
  const medios: Medios = { bloques: [], transcripciones: [], fallos: 0 };
  if (urls.length === 0) return medios;

  for (const url of urls) {
    try {
      const res = await fetchImpl(url);
      if (!res.ok) { medios.fallos += 1; continue; }

      const contentType = res.headers.get('content-type');
      const clase = clasificar(url, contentType);

      // Un PDF o un vCard no son un fallo del cliente: simplemente no sabemos
      // tratarlos y el modelo se las arregla con el texto del mensaje.
      if (clase === 'otro') continue;

      // Aquí, en cambio, no sabemos qué es. Podría ser una foto real que no
      // supimos reconocer, así que cuenta como fallo y el modelo pedirá el dato
      // por escrito en vez de perderlo sin que nadie se entere.
      if (clase === 'desconocido') {
        medios.fallos += 1;
        continue;
      }

      const bytes = await res.arrayBuffer();

      if (clase === 'imagen') {
        if (bytes.byteLength > MAX_IMAGEN) { medios.fallos += 1; continue; }
        medios.bloques.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: tipoImagen(url, contentType),
            data: Buffer.from(bytes).toString('base64'),
          },
        });
        continue;
      }

      const texto = await transcribir(bytes, url, openaiKey, fetchImpl);
      if (texto) medios.transcripciones.push(texto);
      else medios.fallos += 1;
    } catch {
      // Un adjunto roto no debe arrastrar a los demás ni impedir la respuesta.
      medios.fallos += 1;
    }
  }

  return medios;
}
```

- [ ] **Step 4: Ejecutar y verificar que pasa**

Run: `npx vitest run tests/agente-medios.test.ts`
Expected: PASS, 8 pruebas.

- [ ] **Step 5: Commit**

```bash
git add lib/agente/medios.ts tests/agente-medios.test.ts
git commit -m "feat(agente): imágenes a Claude y audio a Whisper

Las imágenes van nativas a Claude; OpenAI sólo se usa para el audio, que es
lo único que Claude no procesa."
```

---

### Task 6: `lib/agente/cerebro.ts` — la llamada a Claude

**Files:**
- Create: `lib/agente/cerebro.ts`
- Test: `tests/agente-cerebro.test.ts`

**Interfaces:**
- Consumes: `config.PROMPT_SISTEMA` y `PRODUCTOS` de `@/lib/agente/config`; `Datos` de `@/lib/agente/estado`; `BloqueImagen` de `@/lib/agente/medios`; `MensajeReal` de `@/lib/agente/conversacion`.
- Produces:
  - `type Salida = { respuesta: string; datos: Partial<Datos> }`
  - `type EntradaCerebro = { mensajes: MensajeReal[]; transcripciones: string[]; bloques: BloqueImagen[]; datosPrevios: Datos; huboFallosDeMedios: boolean; esCorreo: boolean }`
  - `generar(entrada: EntradaCerebro, deps: { anthropicKey: string; fetchImpl?: typeof fetch }): Promise<{ ok: true; salida: Salida } | { ok: false; error: string }>`

- [ ] **Step 1: Escribir las pruebas que fallan**

Crear `tests/agente-cerebro.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { generar } from '@/lib/agente/cerebro';
import { DATOS_VACIOS } from '@/lib/agente/estado';

const deps = { anthropicKey: 'sk-ant-prueba' };

const entrada = {
  mensajes: [
    { id: 'm1', tipo: 'TYPE_WHATSAPP' as const, direccion: 'inbound' as const,
      texto: 'Hola, necesito uniformes', adjuntos: [] },
  ],
  transcripciones: [],
  bloques: [],
  datosPrevios: DATOS_VACIOS,
  huboFallosDeMedios: false,
  esCorreo: false,
};

function claude(payload: unknown, stopReason = 'end_turn') {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        stop_reason: stopReason,
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      }),
  });
}

describe('generar', () => {
  it('devuelve la respuesta y los datos extraídos', async () => {
    const fetchImpl = claude({
      respuesta: 'Con gusto. ¿Me compartes tu nombre?',
      datos: { ...DATOS_VACIOS, producto: 'uniformes' },
    });
    const r = await generar(entrada, { ...deps, fetchImpl });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.salida.respuesta).toContain('nombre');
    expect(r.salida.datos.producto).toBe('uniformes');
  });

  it('usa Opus 5 con effort low y max_tokens acotado', async () => {
    const fetchImpl = claude({ respuesta: 'ok', datos: DATOS_VACIOS });
    await generar(entrada, { ...deps, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.model).toBe('claude-opus-5');
    expect(body.max_tokens).toBe(1024);
    expect(body.output_config.effort).toBe('low');
  });

  // Apagar el thinking en Opus 5 hace que la salida estructurada salga a veces
  // como texto plano: el turno "funciona", el JSON nunca llega y no hay error.
  // El parámetro simplemente no debe ir.
  it('no manda el parámetro thinking', async () => {
    const fetchImpl = claude({ respuesta: 'ok', datos: DATOS_VACIOS });
    await generar(entrada, { ...deps, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.thinking).toBeUndefined();
  });

  it('cachea el bloque de sistema', async () => {
    const fetchImpl = claude({ respuesta: 'ok', datos: DATOS_VACIOS });
    await generar(entrada, { ...deps, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('manda las cabeceras que exige la API de Anthropic', async () => {
    const fetchImpl = claude({ respuesta: 'ok', datos: DATOS_VACIOS });
    await generar(entrada, { ...deps, fetchImpl });
    const headers = fetchImpl.mock.calls[0][1].headers;
    expect(headers['x-api-key']).toBe('sk-ant-prueba');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('adjunta los bloques de imagen al último turno del cliente', async () => {
    const fetchImpl = claude({ respuesta: 'ok', datos: DATOS_VACIOS });
    await generar(
      { ...entrada, bloques: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] },
      { ...deps, fetchImpl },
    );
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    const ultimo = body.messages[body.messages.length - 1];
    expect(ultimo.content.some((b: { type: string }) => b.type === 'image')).toBe(true);
  });

  it('inyecta la transcripción del audio como texto del cliente', async () => {
    const fetchImpl = claude({ respuesta: 'ok', datos: DATOS_VACIOS });
    await generar({ ...entrada, transcripciones: ['Quiero 200 filipinas'] }, { ...deps, fetchImpl });
    expect(JSON.stringify(fetchImpl.mock.calls[0][1].body)).toContain('Quiero 200 filipinas');
  });

  it('falla limpio cuando Claude devuelve un JSON que no valida', async () => {
    const fetchImpl = claude({ respuesta: 123, datos: 'no es un objeto' });
    const r = await generar(entrada, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
  });

  it('falla limpio cuando el contenido no es JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'lo siento, no puedo' }] }),
    });
    const r = await generar(entrada, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
  });

  // Un refusal llega con HTTP 200 y content vacío. Leer content[0].text sin
  // mirar stop_reason revienta con un TypeError críptico.
  it('trata el refusal como fallo, no como respuesta', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({ stop_reason: 'refusal', content: [] }),
    });
    const r = await generar(entrada, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('refusal');
  });

  it('falla limpio cuando la API responde 429', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => 'rate limited' });
    const r = await generar(entrada, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('429');
  });
});
```

- [ ] **Step 2: Ejecutar y verificar que falla**

Run: `npx vitest run tests/agente-cerebro.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/agente/cerebro"`

- [ ] **Step 3: Escribir `lib/agente/cerebro.ts`**

```ts
import { z } from 'zod';
import { config, PRODUCTOS } from '@/lib/agente/config';
import type { Datos } from '@/lib/agente/estado';
import type { BloqueImagen } from '@/lib/agente/medios';
import type { MensajeReal } from '@/lib/agente/conversacion';

// El esquema que se le impone a la API. `additionalProperties: false` y todas
// las claves en `required` son obligatorios para la salida estructurada.
const ESQUEMA = {
  type: 'object',
  properties: {
    respuesta: { type: 'string' },
    datos: {
      type: 'object',
      properties: {
        nombre: { type: ['string', 'null'] },
        email: { type: ['string', 'null'] },
        telefono: { type: ['string', 'null'] },
        producto: { type: ['string', 'null'], enum: [...PRODUCTOS, null] },
        ubicacion: { type: ['string', 'null'] },
      },
      required: ['nombre', 'email', 'telefono', 'producto', 'ubicacion'],
      additionalProperties: false,
    },
  },
  required: ['respuesta', 'datos'],
  additionalProperties: false,
} as const;

// El mismo contrato, validado de nuestro lado. La API garantiza la forma, pero
// no confiamos en ella para algo que se le envía a un cliente real.
const salidaSchema = z.object({
  respuesta: z.string().trim().min(1).max(1500),
  datos: z.object({
    nombre: z.string().nullable(),
    email: z.string().nullable(),
    telefono: z.string().nullable(),
    producto: z.enum(PRODUCTOS).nullable(),
    ubicacion: z.string().nullable(),
  }),
});

export type Salida = z.infer<typeof salidaSchema>;

export type EntradaCerebro = {
  mensajes: MensajeReal[];
  transcripciones: string[];
  bloques: BloqueImagen[];
  datosPrevios: Datos;
  huboFallosDeMedios: boolean;
  esCorreo: boolean;
};

type Deps = { anthropicKey: string; fetchImpl?: typeof fetch };
type Resultado = { ok: true; salida: Salida } | { ok: false; error: string };

type Bloque = BloqueImagen | { type: 'text'; text: string };

function construirMensajes(e: EntradaCerebro) {
  const turnos = e.mensajes.map((m) => ({
    role: m.direccion === 'inbound' ? ('user' as const) : ('assistant' as const),
    content: [{ type: 'text' as const, text: m.texto || '(sin texto)' }] as Bloque[],
  }));

  // La API exige que el primer turno sea del usuario.
  while (turnos.length > 0 && turnos[0].role === 'assistant') turnos.shift();
  if (turnos.length === 0) {
    turnos.push({ role: 'user', content: [{ type: 'text', text: '(sin texto)' }] });
  }

  const ultimo = turnos[turnos.length - 1];
  for (const t of e.transcripciones) {
    ultimo.content.push({ type: 'text', text: `[nota de voz transcrita] ${t}` });
  }
  ultimo.content.push(...e.bloques);
  if (e.huboFallosDeMedios) {
    ultimo.content.push({
      type: 'text',
      text: '[el cliente envió un adjunto que no se pudo leer; pídele amablemente que lo repita por escrito]',
    });
  }

  // Los datos ya capturados van como contexto para que no los vuelva a pedir.
  const yaSe = Object.entries(e.datosPrevios)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');
  ultimo.content.push({
    type: 'text',
    text: yaSe
      ? `[datos que ya tienes de esta persona: ${yaSe}]`
      : '[aún no tienes ningún dato de esta persona]',
  });

  if (e.esCorreo) {
    ultimo.content.push({
      type: 'text',
      text: '[este es un correo y sólo se le responderá una vez: pide todos los datos que falten en este único mensaje]',
    });
  }

  return turnos;
}

export async function generar(entrada: EntradaCerebro, deps: Deps): Promise<Resultado> {
  const { anthropicKey, fetchImpl = fetch } = deps;

  const cuerpo = {
    model: 'claude-opus-5',
    max_tokens: 1024,
    // El thinking NO se manda: en Opus 5 está adaptativo por defecto, y
    // apagarlo hace que la salida estructurada salga a veces como texto plano,
    // con el turno terminando en éxito aparente y sin JSON.
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: ESQUEMA },
    },
    system: [
      { type: 'text', text: config.PROMPT_SISTEMA, cache_control: { type: 'ephemeral' } },
    ],
    messages: construirMensajes(entrada),
  };

  try {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(cuerpo),
    });

    const texto = await res.text();
    if (!res.ok) return { ok: false, error: `Anthropic ${res.status}: ${texto.slice(0, 200)}` };

    const datos = JSON.parse(texto) as {
      stop_reason?: string;
      content?: { type?: string; text?: string }[];
    };

    // Un refusal llega con HTTP 200 y content vacío. Hay que mirarlo ANTES de
    // tocar content[0], o el fallo aparece como un TypeError sin relación.
    if (datos.stop_reason === 'refusal') {
      return { ok: false, error: 'Anthropic devolvió stop_reason: refusal' };
    }

    const bruto = datos.content?.find((b) => b.type === 'text')?.text;
    if (!bruto) return { ok: false, error: 'Anthropic no devolvió ningún bloque de texto.' };

    const parseado = salidaSchema.safeParse(JSON.parse(bruto));
    if (!parseado.success) {
      return { ok: false, error: `La salida no cumple el esquema: ${parseado.error.issues[0]?.message}` };
    }

    return { ok: true, salida: parseado.data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

- [ ] **Step 4: Ejecutar y verificar que pasa**

Run: `npx vitest run tests/agente-cerebro.test.ts`
Expected: PASS, 11 pruebas.

- [ ] **Step 5: Commit**

```bash
git add lib/agente/cerebro.ts tests/agente-cerebro.test.ts
git commit -m "feat(agente): generación con Claude Opus 5 en salida estructurada

Sin parámetro thinking a propósito: apagarlo en Opus 5 hace que la salida
estructurada salga a veces como texto plano, fallando en silencio."
```

---

### Task 7: `lib/agente/acciones.ts` — las escrituras en GHL

**Files:**
- Create: `lib/agente/acciones.ts`
- Test: `tests/agente-acciones.test.ts`

**Interfaces:**
- Consumes: `config`; `CanalEnvio` de `@/lib/agente/canal`; `Datos` de `@/lib/agente/estado`.
- Produces:
  - `type DepsEscritura = { apiKey: string; fetchImpl?: typeof fetch }`
  - `enviarMensaje(p: { contactId: string; canal: CanalEnvio; texto: string }, deps): Promise<{ ok: true; messageId: string | null } | { ok: false; error: string }>`
  - `actualizarContacto(contactId: string, datos: Datos, deps): Promise<string | undefined>` — devuelve el error si lo hubo, `undefined` si fue bien
  - `agregarNota(contactId: string, texto: string, deps): Promise<string | undefined>`
  - `dispararWorkflow(contactId: string, deps): Promise<string | undefined>`
  - `resumenParaNota(datos: Datos, canal: CanalEnvio): string`

- [ ] **Step 1: Escribir las pruebas que fallan**

Crear `tests/agente-acciones.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { enviarMensaje, actualizarContacto, dispararWorkflow, resumenParaNota } from '@/lib/agente/acciones';
import { DATOS_VACIOS } from '@/lib/agente/estado';

const deps = { apiKey: 'llave' };

function ok(body: unknown) {
  return vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify(body) });
}

describe('enviarMensaje', () => {
  it('manda el type de envío, no el messageType leído', async () => {
    const fetchImpl = ok({ messageId: 'msg-1' });
    await enviarMensaje({ contactId: 'c1', canal: 'WhatsApp', texto: 'Hola' }, { ...deps, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.type).toBe('WhatsApp');
    expect(body.contactId).toBe('c1');
    expect(body.message).toBe('Hola');
  });

  it('añade asunto cuando el canal es correo', async () => {
    const fetchImpl = ok({ messageId: 'msg-1' });
    await enviarMensaje({ contactId: 'c1', canal: 'Email', texto: 'Hola' }, { ...deps, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(typeof body.subject).toBe('string');
    expect(body.subject.length).toBeGreaterThan(0);
  });

  it('usa la versión de conversaciones', async () => {
    const fetchImpl = ok({ messageId: 'm' });
    await enviarMensaje({ contactId: 'c1', canal: 'IG', texto: 'x' }, { ...deps, fetchImpl });
    expect(fetchImpl.mock.calls[0][1].headers.Version).toBe('2021-04-15');
  });

  it('devuelve el id del mensaje creado, que alimenta la guarda del humano', async () => {
    const fetchImpl = ok({ messageId: 'msg-42' });
    const r = await enviarMensaje({ contactId: 'c1', canal: 'FB', texto: 'x' }, { ...deps, fetchImpl });
    expect(r).toEqual({ ok: true, messageId: 'msg-42' });
  });

  // Si GHL no devuelve id, el mensaje SÍ salió. Marcarlo como fallo lo haría
  // reenviarse y el cliente lo recibiría dos veces.
  it('cuenta como enviado aunque no venga el id', async () => {
    const fetchImpl = ok({});
    const r = await enviarMensaje({ contactId: 'c1', canal: 'FB', texto: 'x' }, { ...deps, fetchImpl });
    expect(r).toEqual({ ok: true, messageId: null });
  });

  it('falla limpio con un 403 de scope faltante', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => 'forbidden' });
    const r = await enviarMensaje({ contactId: 'c1', canal: 'WhatsApp', texto: 'x' }, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('403');
  });
});

describe('actualizarContacto', () => {
  // Primero LEE el contacto y luego escribe: sin la lectura, el PUT pisaría el
  // correo o el teléfono que el asesor ya hubiera cargado a mano.
  function contactoYPut(actual: Record<string, unknown>) {
    return vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ contact: actual }) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '{}' });
  }

  // `city` es la subzona de ruta en la base importada, no la ciudad del cliente.
  it('nunca escribe city, ni siquiera si está vacío', async () => {
    const fetchImpl = contactoYPut({});
    await actualizarContacto('c1', { ...DATOS_VACIOS, nombre: 'Ana', ubicacion: 'Tamarindo' }, { ...deps, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect('city' in body).toBe(false);
  });

  // En la base importada firstName es el nombre comercial del negocio, así que
  // el nombre de la persona necesita su propio campo o se pierde.
  it('guarda el nombre de la persona en persona_contacto', async () => {
    const fetchImpl = contactoYPut({ firstName: 'Hotel Papagayo' });
    await actualizarContacto('c1', { ...DATOS_VACIOS, nombre: 'Ana Pérez' }, { ...deps, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(body.customFields).toEqual([{ key: 'persona_contacto', field_value: 'Ana Pérez' }]);
    expect('firstName' in body).toBe(false);
  });

  it('usa la versión de contactos y sólo manda lo que tiene valor', async () => {
    const fetchImpl = contactoYPut({});
    await actualizarContacto('c1', { ...DATOS_VACIOS, nombre: 'Ana Pérez', email: 'ana@x.com' }, { ...deps, fetchImpl });
    const [, init] = fetchImpl.mock.calls[1];
    expect(init.method).toBe('PUT');
    expect(init.headers.Version).toBe('2021-07-28');
    const body = JSON.parse(init.body);
    expect(body.firstName).toBe('Ana');
    expect(body.lastName).toBe('Pérez');
    expect(body.email).toBe('ana@x.com');
    expect('phone' in body).toBe(false);
  });

  // Prueba 15 del spec. El asesor pudo haber corregido el correo a mano; el
  // agente no tiene derecho a sobrescribirlo con lo que dedujo de un chat.
  it('no pisa un dato que el contacto ya tenía en GHL', async () => {
    const fetchImpl = contactoYPut({ email: 'el-bueno@empresa.com' });
    await actualizarContacto(
      'c1', { ...DATOS_VACIOS, email: 'deducido@chat.com', telefono: '+502 5555' }, { ...deps, fetchImpl },
    );
    const body = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect('email' in body).toBe(false);
    expect(body.phone).toBe('+502 5555');
  });

  // Si no sabemos qué hay, no escribimos: los datos igual quedan en la nota,
  // así que no se pierde nada y no se arriesga pisar a ciegas.
  it('no escribe si no pudo leer el contacto', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    const err = await actualizarContacto('c1', { ...DATOS_VACIOS, email: 'x@y.com' }, { ...deps, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(err).toBeTruthy();
  });

  it('etiqueta con el producto de interés', async () => {
    const fetchImpl = contactoYPut({});
    await actualizarContacto('c1', { ...DATOS_VACIOS, nombre: 'Ana', producto: 'hogar' }, { ...deps, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(body.tags).toContain('agente-ia');
    expect(body.tags).toContain('interes-hogar');
  });

  it('no llama a la red cuando no hay ni un dato que guardar', async () => {
    const fetchImpl = vi.fn();
    await actualizarContacto('c1', DATOS_VACIOS, { ...deps, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('devuelve el error sin lanzar', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const err = await actualizarContacto('c1', { ...DATOS_VACIOS, nombre: 'Ana' }, { ...deps, fetchImpl });
    expect(err).toContain('ECONNRESET');
  });
});

describe('dispararWorkflow', () => {
  it('pega en la ruta del workflow de aviso interno', async () => {
    const fetchImpl = ok({});
    await dispararWorkflow('c1', { ...deps, fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toContain('/contacts/c1/workflow/1235c311-b3e6-4b7d-be40-0ec2a1f01a60');
    expect(fetchImpl.mock.calls[0][1].method).toBe('POST');
  });
});

describe('resumenParaNota', () => {
  it('lista los datos capturados y el canal', () => {
    const nota = resumenParaNota({ ...DATOS_VACIOS, nombre: 'Ana Pérez', telefono: '+502 5555' }, 'WhatsApp');
    expect(nota).toContain('Ana Pérez');
    expect(nota).toContain('+502 5555');
    expect(nota).toContain('WhatsApp');
  });

  it('dice explícitamente qué falta, para que el asesor lo vea de un vistazo', () => {
    const nota = resumenParaNota({ ...DATOS_VACIOS, nombre: 'Ana' }, 'IG');
    expect(nota.toLowerCase()).toContain('falta');
  });
});
```

- [ ] **Step 2: Ejecutar y verificar que falla**

Run: `npx vitest run tests/agente-acciones.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/agente/acciones"`

- [ ] **Step 3: Escribir `lib/agente/acciones.ts`**

```ts
import { config } from '@/lib/agente/config';
import type { CanalEnvio } from '@/lib/agente/canal';
import type { Datos } from '@/lib/agente/estado';

export type DepsEscritura = { apiKey: string; fetchImpl?: typeof fetch };

function cabeceras(apiKey: string, version: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Version: version,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

const ASUNTO_CORREO = 'Recibimos tu mensaje — Luxe Essentials';

export async function enviarMensaje(
  p: { contactId: string; canal: CanalEnvio; texto: string },
  deps: DepsEscritura,
): Promise<{ ok: true; messageId: string | null } | { ok: false; error: string }> {
  const { apiKey, fetchImpl = fetch } = deps;

  const cuerpo: Record<string, unknown> = {
    type: p.canal,
    contactId: p.contactId,
    message: p.texto,
  };
  if (p.canal === 'Email') cuerpo.subject = ASUNTO_CORREO;

  try {
    const res = await fetchImpl(`${config.BASE_GHL}/conversations/messages`, {
      method: 'POST',
      headers: cabeceras(apiKey, config.VERSION_CONVERSACIONES),
      body: JSON.stringify(cuerpo),
    });
    const texto = await res.text();
    if (!res.ok) return { ok: false, error: `GHL envío ${res.status}: ${texto.slice(0, 200)}` };

    // Si GHL no devuelve id, el mensaje igual salió. Tratarlo como fallo haría
    // que se reenviara y el cliente lo recibiría dos veces. El precio de no
    // tener el id es que la guarda del humano lo verá como saliente ajeno y el
    // agente callará de más: el fallo seguro.
    const datos = JSON.parse(texto) as { messageId?: string; id?: string };
    return { ok: true, messageId: datos.messageId ?? datos.id ?? null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function partirNombre(completo: string) {
  const partes = completo.trim().split(/\s+/);
  return { firstName: partes[0] ?? '', lastName: partes.slice(1).join(' ') || undefined };
}

// Nunca lanza: un fallo guardando los datos no debe borrar el hecho de que al
// cliente ya se le respondió. Devuelve el texto del error para el log.
//
// LEE el contacto antes de escribirlo. El PUT de GHL sobrescribe, y el asesor
// pudo haber corregido el correo o el teléfono a mano: el agente no tiene
// derecho a pisar eso con lo que dedujo de un chat.
export async function actualizarContacto(
  contactId: string, datos: Datos, deps: DepsEscritura,
): Promise<string | undefined> {
  const { apiKey, fetchImpl = fetch } = deps;

  // Sin ningún dato no hay nada que escribir, y ni siquiera vale la pena leer.
  const hayAlgo = Object.values(datos).some(Boolean);
  if (!hayAlgo) return undefined;

  let actual: Record<string, unknown>;
  try {
    const res = await fetchImpl(`${config.BASE_GHL}/contacts/${contactId}`, {
      headers: cabeceras(apiKey, config.VERSION_CONTACTOS),
    });
    if (!res.ok) {
      // Si no sabemos qué hay, no escribimos. Los datos igual quedan en la
      // nota, así que no se pierde nada y no se arriesga pisar a ciegas.
      return `GHL lectura de contacto ${res.status}: no se escribieron los campos`;
    }
    actual = (JSON.parse(await res.text()) as { contact?: Record<string, unknown> }).contact ?? {};
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }

  const vacio = (campo: string) => {
    const v = actual[campo];
    return v === undefined || v === null || v === '';
  };

  const cuerpo: Record<string, unknown> = {};
  if (datos.nombre && vacio('firstName')) Object.assign(cuerpo, partirNombre(datos.nombre));
  if (datos.email && vacio('email')) cuerpo.email = datos.email;
  if (datos.telefono && vacio('phone')) cuerpo.phone = datos.telefono;

  // `city` NO se escribe nunca. La importación de la base comercial 2026 mapea
  // "Subzona / ruta" a City, así que ese campo es la ruta de visita del cliente,
  // no su ciudad. Escribir ahí lo que alguien mencione por chat rompería la
  // segmentación comercial. La ubicación declarada vive sólo en la nota.

  // El nombre de la persona va a un campo propio: en la base importada
  // firstName lleva el nombre comercial del negocio, no el de nadie.
  if (datos.nombre) {
    cuerpo.customFields = [{ key: config.CAMPO_PERSONA, field_value: datos.nombre }];
  }

  if (Object.keys(cuerpo).length === 0) return undefined;

  const tagProducto = config.tagDeProducto(datos.producto);
  // Los tags del PUT reemplazan, así que se conservan los que ya tenía.
  const previos = Array.isArray(actual.tags) ? (actual.tags as string[]) : [];
  cuerpo.tags = [...new Set([...previos, ...config.TAGS_BASE, ...(tagProducto ? [tagProducto] : [])])];

  try {
    const res = await fetchImpl(`${config.BASE_GHL}/contacts/${contactId}`, {
      method: 'PUT',
      headers: cabeceras(apiKey, config.VERSION_CONTACTOS),
      body: JSON.stringify(cuerpo),
    });
    if (!res.ok) return `GHL contacto ${res.status}: ${(await res.text()).slice(0, 200)}`;
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export function resumenParaNota(datos: Datos, canal: CanalEnvio): string {
  const etiquetas: Record<keyof Datos, string> = {
    nombre: 'Nombre', email: 'Correo', telefono: 'Teléfono',
    producto: 'Producto de interés', ubicacion: 'Ubicación',
  };

  const lineas = [`Conversación atendida por el agente automático (canal: ${canal}).`, ''];
  const faltan: string[] = [];

  for (const clave of Object.keys(etiquetas) as (keyof Datos)[]) {
    const valor = datos[clave];
    if (valor) lineas.push(`${etiquetas[clave]}: ${valor}`);
    else faltan.push(etiquetas[clave].toLowerCase());
  }

  if (faltan.length > 0) {
    lineas.push('', `Falta por confirmar: ${faltan.join(', ')}.`);
  }
  return lineas.join('\n');
}

export async function agregarNota(
  contactId: string, texto: string, deps: DepsEscritura,
): Promise<string | undefined> {
  const { apiKey, fetchImpl = fetch } = deps;
  try {
    const res = await fetchImpl(`${config.BASE_GHL}/contacts/${contactId}/notes`, {
      method: 'POST',
      headers: cabeceras(apiKey, config.VERSION_CONTACTOS),
      body: JSON.stringify({ body: texto }),
    });
    if (!res.ok) return `GHL nota ${res.status}: ${(await res.text()).slice(0, 200)}`;
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export async function dispararWorkflow(
  contactId: string, deps: DepsEscritura,
): Promise<string | undefined> {
  const { apiKey, fetchImpl = fetch } = deps;
  try {
    const res = await fetchImpl(
      `${config.BASE_GHL}/contacts/${contactId}/workflow/${config.WORKFLOW_AVISO}`,
      {
        method: 'POST',
        headers: cabeceras(apiKey, config.VERSION_CONTACTOS),
        body: JSON.stringify({ eventStartTime: new Date().toISOString() }),
      },
    );
    if (!res.ok) return `GHL workflow ${res.status}: ${(await res.text()).slice(0, 200)}`;
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
```

- [ ] **Step 4: Ejecutar y verificar que pasa**

Run: `npx vitest run tests/agente-acciones.test.ts`
Expected: PASS, 17 pruebas.

- [ ] **Step 5: Commit**

```bash
git add lib/agente/acciones.ts tests/agente-acciones.test.ts
git commit -m "feat(agente): escrituras en GHL — enviar, actualizar contacto, avisar"
```

---

### Task 8: `lib/agente/procesar.ts` — la orquestación y las tres guardas

**Desviación deliberada del spec.** La §13 del spec asigna la orquestación a
`app/api/ghl/webhook/route.ts`. Aquí se separa en `lib/agente/procesar.ts` por dos razones:
el route handler importa `supabaseAdmin()`, que trae `server-only` y complica probarlo; y
las guardas merecen su propio archivo de pruebas exhaustivo. El route queda con lo que la
§13 le atribuye textualmente —validar, responder 200, agendar— y nada más.

**Files:**
- Create: `lib/agente/procesar.ts`
- Test: `tests/agente-procesar.test.ts`

**Interfaces:**
- Consumes: todo lo anterior.
- Produces:
  - `type Desenlace = 'respondido' | 'sin-entrante' | 'humano-presente' | 'duplicado' | 'inactivo' | 'canal-no-soportado' | 'error'`
  - `type DepsProcesar = { db: Db; ghlApiKey: string; locationId: string; anthropicKey: string; openaiKey: string; fetchImpl?: typeof fetch }`
  - `procesar(contactId: string, deps: DepsProcesar): Promise<{ desenlace: Desenlace; detalle?: string }>`

- [ ] **Step 1: Escribir las pruebas que fallan**

Crear `tests/agente-procesar.test.ts`. Las dependencias de red se simulan por módulo, porque
aquí lo que se prueba es la *decisión*, no el transporte:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const hidratar = vi.fn();
vi.mock('@/lib/agente/conversacion', async (original) => ({
  ...(await original<typeof import('@/lib/agente/conversacion')>()),
  hidratar: (...a: unknown[]) => hidratar(...a),
}));

const generar = vi.fn();
vi.mock('@/lib/agente/cerebro', () => ({ generar: (...a: unknown[]) => generar(...a) }));

const prepararMedios = vi.fn();
vi.mock('@/lib/agente/medios', () => ({ prepararMedios: (...a: unknown[]) => prepararMedios(...a) }));

const enviarMensaje = vi.fn();
const actualizarContacto = vi.fn();
const agregarNota = vi.fn();
const dispararWorkflow = vi.fn();
vi.mock('@/lib/agente/acciones', async (original) => ({
  ...(await original<typeof import('@/lib/agente/acciones')>()),
  enviarMensaje: (...a: unknown[]) => enviarMensaje(...a),
  actualizarContacto: (...a: unknown[]) => actualizarContacto(...a),
  agregarNota: (...a: unknown[]) => agregarNota(...a),
  dispararWorkflow: (...a: unknown[]) => dispararWorkflow(...a),
}));

const leerOCrear = vi.fn();
const tomarMensaje = vi.fn();
const guardar = vi.fn();
vi.mock('@/lib/agente/estado', async (original) => ({
  ...(await original<typeof import('@/lib/agente/estado')>()),
  leerOCrear: (...a: unknown[]) => leerOCrear(...a),
  tomarMensaje: (...a: unknown[]) => tomarMensaje(...a),
  guardar: (...a: unknown[]) => guardar(...a),
}));

const { procesar } = await import('@/lib/agente/procesar');
const { DATOS_VACIOS } = await import('@/lib/agente/estado');

const deps = {
  db: {} as never, ghlApiKey: 'k', locationId: 'l',
  anthropicKey: 'a', openaiKey: 'o',
};

const FILA_NUEVA = {
  contact_id: 'c1', conversation_id: null, canal: null, estado: 'activo',
  turnos: 0, datos: DATOS_VACIOS, ultimo_mensaje_id: null,
  enviados: [] as string[], notificado_at: null,
};

const entrante = (over = {}) => ({
  id: 'in-1', tipo: 'TYPE_WHATSAPP', direccion: 'inbound',
  texto: 'Hola', adjuntos: [], ...over,
});

function conversacionCon(mensajes: unknown[]) {
  return { ok: true, conversacion: { conversationId: 'conv-1', mensajes } };
}

beforeEach(() => {
  vi.clearAllMocks();
  leerOCrear.mockResolvedValue({ ...FILA_NUEVA });
  tomarMensaje.mockResolvedValue(true);
  guardar.mockResolvedValue(undefined);
  prepararMedios.mockResolvedValue({ bloques: [], transcripciones: [], fallos: 0 });
  generar.mockResolvedValue({ ok: true, salida: { respuesta: 'Hola, ¿tu nombre?', datos: DATOS_VACIOS } });
  enviarMensaje.mockResolvedValue({ ok: true, messageId: 'out-1' });
  actualizarContacto.mockResolvedValue(undefined);
  agregarNota.mockResolvedValue(undefined);
  dispararWorkflow.mockResolvedValue(undefined);
  hidratar.mockResolvedValue(conversacionCon([entrante()]));
});

describe('camino feliz', () => {
  it('responde por el canal del último entrante', async () => {
    const r = await procesar('c1', deps);
    expect(r.desenlace).toBe('respondido');
    expect(enviarMensaje).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: 'c1', canal: 'WhatsApp' }),
      expect.anything(),
    );
  });

  it('acumula el id enviado, que es lo que alimenta la guarda del humano', async () => {
    await procesar('c1', deps);
    expect(guardar).toHaveBeenCalledWith('c1', expect.objectContaining({ enviados: ['out-1'] }), expect.anything());
  });

  it('incrementa el contador de turnos', async () => {
    await procesar('c1', deps);
    expect(guardar).toHaveBeenCalledWith('c1', expect.objectContaining({ turnos: 1 }), expect.anything());
  });
});

describe('guarda 1 — anti-bucle', () => {
  // Nuestra propia respuesta vuelve a disparar el workflow de GHL. Sin esto,
  // el agente se contesta a sí mismo indefinidamente, cobrando cada vuelta.
  it('no responde cuando el último mensaje real es saliente propio', async () => {
    leerOCrear.mockResolvedValue({ ...FILA_NUEVA, enviados: ['out-1'] });
    hidratar.mockResolvedValue(conversacionCon([entrante(), entrante({ id: 'out-1', direccion: 'outbound' })]));
    const r = await procesar('c1', deps);
    expect(r.desenlace).toBe('sin-entrante');
    expect(enviarMensaje).not.toHaveBeenCalled();
  });

  // El caso original del proyecto: la conversación sólo trae actividades del
  // CRM, así que tras filtrar no queda nada que responder.
  it('no responde cuando no queda ningún mensaje real', async () => {
    hidratar.mockResolvedValue(conversacionCon([]));
    const r = await procesar('c1', deps);
    expect(r.desenlace).toBe('sin-entrante');
    expect(generar).not.toHaveBeenCalled();
  });
});

describe('guarda 2 — humano presente', () => {
  it('calla para siempre en cuanto detecta un saliente ajeno', async () => {
    hidratar.mockResolvedValue(conversacionCon([entrante(), entrante({ id: 'del-asesor', direccion: 'outbound' })]));
    const r = await procesar('c1', deps);
    expect(r.desenlace).toBe('humano-presente');
    expect(guardar).toHaveBeenCalledWith('c1', expect.objectContaining({ estado: 'humano' }), expect.anything());
    expect(enviarMensaje).not.toHaveBeenCalled();
  });

  it('ni siquiera hidrata cuando el contacto ya estaba marcado como humano', async () => {
    leerOCrear.mockResolvedValue({ ...FILA_NUEVA, estado: 'humano' });
    const r = await procesar('c1', deps);
    expect(r.desenlace).toBe('inactivo');
    expect(hidratar).not.toHaveBeenCalled();
  });
});

describe('guarda 3 — anti-duplicado', () => {
  it('abandona sin responder cuando otro proceso ya tomó el mensaje', async () => {
    tomarMensaje.mockResolvedValue(false);
    const r = await procesar('c1', deps);
    expect(r.desenlace).toBe('duplicado');
    expect(enviarMensaje).not.toHaveBeenCalled();
  });

  // El candado va ANTES del trabajo caro: si se tomara después, dos webhooks
  // simultáneos pagarían dos llamadas a Claude para descartar una.
  it('toma el candado antes de llamar a Claude', async () => {
    const orden: string[] = [];
    tomarMensaje.mockImplementation(async () => { orden.push('candado'); return true; });
    generar.mockImplementation(async () => { orden.push('claude'); return { ok: true, salida: { respuesta: 'x', datos: DATOS_VACIOS } }; });
    await procesar('c1', deps);
    expect(orden).toEqual(['candado', 'claude']);
  });
});

describe('tope de turnos', () => {
  it('en el cuarto turno responde y deja el contacto agotado', async () => {
    leerOCrear.mockResolvedValue({ ...FILA_NUEVA, turnos: 3 });
    const r = await procesar('c1', deps);
    expect(r.desenlace).toBe('respondido');
    expect(guardar).toHaveBeenCalledWith('c1', expect.objectContaining({ estado: 'agotado', turnos: 4 }), expect.anything());
  });

  it('no responde un quinto mensaje', async () => {
    leerOCrear.mockResolvedValue({ ...FILA_NUEVA, estado: 'agotado', turnos: 4 });
    const r = await procesar('c1', deps);
    expect(r.desenlace).toBe('inactivo');
    expect(enviarMensaje).not.toHaveBeenCalled();
  });
});

describe('correo', () => {
  it('responde una vez y marca el contacto como ya respondido', async () => {
    hidratar.mockResolvedValue(conversacionCon([entrante({ tipo: 'TYPE_EMAIL' })]));
    const r = await procesar('c1', deps);
    expect(r.desenlace).toBe('respondido');
    expect(enviarMensaje).toHaveBeenCalledWith(expect.objectContaining({ canal: 'Email' }), expect.anything());
    expect(guardar).toHaveBeenCalledWith('c1', expect.objectContaining({ estado: 'email_respondido' }), expect.anything());
  });

  it('no responde un segundo correo', async () => {
    leerOCrear.mockResolvedValue({ ...FILA_NUEVA, estado: 'email_respondido' });
    const r = await procesar('c1', deps);
    expect(r.desenlace).toBe('inactivo');
  });
});

describe('aviso al equipo', () => {
  it('dispara el workflow cuando hay nombre y un medio de contacto', async () => {
    generar.mockResolvedValue({
      ok: true,
      salida: { respuesta: 'Gracias', datos: { ...DATOS_VACIOS, nombre: 'Ana Pérez', email: 'ana@x.com' } },
    });
    await procesar('c1', deps);
    expect(dispararWorkflow).toHaveBeenCalledWith('c1', expect.anything());
  });

  it('no dispara con nombre pero sin correo ni teléfono', async () => {
    generar.mockResolvedValue({
      ok: true, salida: { respuesta: 'Gracias', datos: { ...DATOS_VACIOS, nombre: 'Ana' } },
    });
    await procesar('c1', deps);
    expect(dispararWorkflow).not.toHaveBeenCalled();
  });

  // Para que el equipo se entere aunque el cliente nunca suelte sus datos.
  it('dispara igual al agotar los turnos, sin datos', async () => {
    leerOCrear.mockResolvedValue({ ...FILA_NUEVA, turnos: 3 });
    await procesar('c1', deps);
    expect(dispararWorkflow).toHaveBeenCalled();
  });

  it('no dispara dos veces para el mismo contacto', async () => {
    leerOCrear.mockResolvedValue({ ...FILA_NUEVA, turnos: 3, notificado_at: '2026-08-24T10:00:00Z' });
    await procesar('c1', deps);
    expect(dispararWorkflow).not.toHaveBeenCalled();
  });
});

describe('fallos', () => {
  it('no responde si la hidratación falla', async () => {
    hidratar.mockResolvedValue({ ok: false, error: 'GHL search 500' });
    const r = await procesar('c1', deps);
    expect(r.desenlace).toBe('error');
    expect(enviarMensaje).not.toHaveBeenCalled();
  });

  it('no responde si Claude falla', async () => {
    generar.mockResolvedValue({ ok: false, error: 'refusal' });
    const r = await procesar('c1', deps);
    expect(r.desenlace).toBe('error');
    expect(enviarMensaje).not.toHaveBeenCalled();
  });

  // Si el envío falla, el turno no se consume: el siguiente mensaje del
  // cliente vuelve a intentarlo.
  it('no consume turno si el envío falla', async () => {
    enviarMensaje.mockResolvedValue({ ok: false, error: 'GHL envío 403' });
    const r = await procesar('c1', deps);
    expect(r.desenlace).toBe('error');
    expect(guardar).not.toHaveBeenCalledWith('c1', expect.objectContaining({ turnos: 1 }), expect.anything());
  });

  it('no responde a un canal que no sabe contestar', async () => {
    hidratar.mockResolvedValue(conversacionCon([entrante({ tipo: 'TYPE_SMS' })]));
    const r = await procesar('c1', deps);
    expect(['canal-no-soportado', 'sin-entrante']).toContain(r.desenlace);
    expect(enviarMensaje).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Ejecutar y verificar que falla**

Run: `npx vitest run tests/agente-procesar.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/agente/procesar"`

- [ ] **Step 3: Escribir `lib/agente/procesar.ts`**

```ts
import { config } from '@/lib/agente/config';
import { canalDeEnvio, esCorreo } from '@/lib/agente/canal';
import { hidratar, ultimoReal, huboRespuestaHumana } from '@/lib/agente/conversacion';
import { prepararMedios } from '@/lib/agente/medios';
import { generar } from '@/lib/agente/cerebro';
import { enviarMensaje, actualizarContacto, agregarNota, dispararWorkflow, resumenParaNota } from '@/lib/agente/acciones';
import { leerOCrear, tomarMensaje, guardar, fusionarDatos, type Db, type Datos, type Fila } from '@/lib/agente/estado';

// No hay variante 'agotado': al consumir el último turno el desenlace sigue
// siendo 'respondido' (el cliente sí recibió respuesta), y es el mensaje
// SIGUIENTE el que sale por 'inactivo'.
export type Desenlace =
  | 'respondido' | 'sin-entrante' | 'humano-presente' | 'duplicado'
  | 'inactivo' | 'canal-no-soportado' | 'error';

export type DepsProcesar = {
  db: Db;
  ghlApiKey: string;
  locationId: string;
  anthropicKey: string;
  openaiKey: string;
  fetchImpl?: typeof fetch;
};

// El equipo se entera cuando tenemos con quién hablar y cómo contactarlo, o
// cuando el agente se quedó sin turnos — esto último para que un cliente que
// nunca da sus datos no desaparezca en silencio.
function debeAvisar(fila: Fila, datos: Datos, turnos: number): boolean {
  if (fila.notificado_at) return false;
  if (datos.nombre && (datos.email || datos.telefono)) return true;
  return turnos >= config.TOPE_TURNOS;
}

export async function procesar(
  contactId: string, deps: DepsProcesar,
): Promise<{ desenlace: Desenlace; detalle?: string }> {
  const { db, ghlApiKey, locationId, anthropicKey, openaiKey, fetchImpl } = deps;
  const escritura = { apiKey: ghlApiKey, fetchImpl };

  const fila = await leerOCrear(contactId, db);
  if (fila.estado !== 'activo') return { desenlace: 'inactivo', detalle: fila.estado };

  const hidratado = await hidratar(contactId, { apiKey: ghlApiKey, locationId, fetchImpl });
  if (!hidratado.ok) return { desenlace: 'error', detalle: hidratado.error };
  const { conversacion } = hidratado;

  // Guarda 2, antes que nada: si el asesor ya entró, el agente no vuelve a
  // hablar aunque el cliente siga escribiendo.
  if (huboRespuestaHumana(conversacion, fila.enviados)) {
    await guardar(contactId, { estado: 'humano' }, db);
    return { desenlace: 'humano-presente' };
  }

  // Guarda 1: si lo último no es un entrante real, no hay nada que contestar.
  // Es lo que mata el bucle de responderse a sí mismo, y también el caso del
  // webhook cuya conversación sólo trae actividades del CRM.
  const ultimo = ultimoReal(conversacion);
  if (!ultimo || ultimo.direccion !== 'inbound') return { desenlace: 'sin-entrante' };

  const canal = canalDeEnvio(ultimo.tipo);
  if (!canal) return { desenlace: 'canal-no-soportado', detalle: ultimo.tipo };

  // Guarda 3, antes del trabajo caro: si se tomara después, dos webhooks
  // simultáneos pagarían dos llamadas a Claude para acabar descartando una.
  if (!(await tomarMensaje(contactId, ultimo.id, db))) return { desenlace: 'duplicado' };

  const medios = await prepararMedios(ultimo.adjuntos, { openaiKey, fetchImpl });

  const generado = await generar(
    {
      mensajes: conversacion.mensajes,
      transcripciones: medios.transcripciones,
      bloques: medios.bloques,
      datosPrevios: fila.datos,
      huboFallosDeMedios: medios.fallos > 0,
      esCorreo: esCorreo(ultimo.tipo),
    },
    { anthropicKey, fetchImpl },
  );
  if (!generado.ok) return { desenlace: 'error', detalle: generado.error };

  const envio = await enviarMensaje(
    { contactId, canal, texto: generado.salida.respuesta }, escritura,
  );
  // El turno no se consume si el envío falló: el siguiente mensaje del cliente
  // lo reintenta en vez de darlo por perdido.
  if (!envio.ok) return { desenlace: 'error', detalle: envio.error };

  const datos = fusionarDatos(fila.datos, generado.salida.datos);
  const turnos = fila.turnos + 1;
  const avisar = debeAvisar(fila, datos, turnos);

  const estado = esCorreo(ultimo.tipo)
    ? 'email_respondido'
    : turnos >= config.TOPE_TURNOS
      ? 'agotado'
      : 'activo';

  await guardar(
    contactId,
    {
      conversation_id: conversacion.conversationId,
      canal: ultimo.tipo,
      datos,
      turnos,
      estado,
      enviados: envio.messageId ? [...fila.enviados, envio.messageId] : fila.enviados,
      ...(avisar ? { notificado_at: new Date().toISOString() } : {}),
    },
    db,
  );

  // Estas tres escrituras no pueden hacer fallar el turno: al cliente ya se le
  // respondió, que es lo que importa. Sus errores van al log y nada más.
  const errores = [
    await actualizarContacto(contactId, datos, escritura),
    await agregarNota(contactId, resumenParaNota(datos, canal), escritura),
    avisar ? await dispararWorkflow(contactId, escritura) : undefined,
  ].filter(Boolean);

  if (errores.length > 0) {
    console.error('[agente] Se respondió pero falló alguna escritura.', 'contacto:', contactId, errores);
  }

  return { desenlace: 'respondido' };
}
```

- [ ] **Step 4: Ejecutar y verificar que pasa**

Run: `npx vitest run tests/agente-procesar.test.ts`
Expected: PASS, 21 pruebas.

- [ ] **Step 5: Commit**

```bash
git add lib/agente/procesar.ts tests/agente-procesar.test.ts
git commit -m "feat(agente): orquestación con las tres guardas

Anti-bucle (sólo actúa si el último real es entrante), humano-presente (calla
para siempre si respondió una persona) y anti-duplicado (candado antes del
trabajo caro)."
```

---

### Task 9: `app/api/ghl/webhook/route.ts` — el webhook, y cierre

**Files:**
- Create: `app/api/ghl/webhook/route.ts`
- Test: `tests/agente-webhook.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `procesar` de `@/lib/agente/procesar`; `supabaseAdmin` de `@/lib/supabase/server`.
- Produces: el endpoint `POST /api/ghl/webhook`.

- [ ] **Step 1: Escribir las pruebas que fallan**

Crear `tests/agente-webhook.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// `after()` difiere el trabajo hasta después de la respuesta. En pruebas lo
// capturamos para poder ejecutarlo a mano y comprobar qué se agendó.
const tareas: (() => unknown)[] = [];
vi.mock('next/server', async (original) => {
  const real = await original<typeof import('next/server')>();
  return { ...real, after: (fn: () => unknown) => { tareas.push(fn); } };
});

vi.mock('@/lib/supabase/server', () => ({ supabaseAdmin: () => ({ from: () => ({}) }) }));

const procesar = vi.fn();
vi.mock('@/lib/agente/procesar', () => ({ procesar: (...a: unknown[]) => procesar(...a) }));

const { POST } = await import('@/app/api/ghl/webhook/route');

const SECRETO = 'secreto-de-prueba';

function peticion(cuerpo: unknown, secreto: string | null = SECRETO) {
  return new Request('http://localhost/api/ghl/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(secreto === null ? {} : { 'x-luxe-agente-secreto': secreto }),
    },
    body: typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo),
  });
}

beforeEach(() => {
  tareas.length = 0;
  vi.clearAllMocks();
  procesar.mockResolvedValue({ desenlace: 'respondido' });
  process.env.LUXE_AGENTE_WEBHOOK_SECRET = SECRETO;
  process.env.LUXE_GHL_API_KEY = 'k';
  process.env.LUXE_GHL_LOCATION_ID = 'l';
  process.env.LUXE_ANTHROPIC_API_KEY = 'a';
  process.env.LUXE_OPENAI_API_KEY = 'o';
});

describe('POST /api/ghl/webhook', () => {
  it('rechaza sin cabecera secreta', async () => {
    const res = await POST(peticion({ contactId: 'c1' }, null));
    expect(res.status).toBe(401);
    expect(tareas).toHaveLength(0);
  });

  it('rechaza con secreto equivocado', async () => {
    const res = await POST(peticion({ contactId: 'c1' }, 'otro'));
    expect(res.status).toBe(401);
  });

  it('rechaza si el secreto no está configurado en el servidor', async () => {
    delete process.env.LUXE_AGENTE_WEBHOOK_SECRET;
    const res = await POST(peticion({ contactId: 'c1' }));
    expect(res.status).toBe(401);
  });

  // Responder rápido es el punto: si tardamos, GHL reintenta y el cliente
  // recibe dos respuestas.
  it('responde 200 y agenda el trabajo en vez de esperarlo', async () => {
    const res = await POST(peticion({ contactId: 'c1' }));
    expect(res.status).toBe(200);
    expect(procesar).not.toHaveBeenCalled();
    expect(tareas).toHaveLength(1);

    await tareas[0]();
    expect(procesar).toHaveBeenCalledWith('c1', expect.objectContaining({ ghlApiKey: 'k', locationId: 'l' }));
  });

  it('encuentra el contactId en las formas que manda GHL', async () => {
    for (const cuerpo of [
      { contactId: 'c1' },
      { contact_id: 'c1' },
      { contact: { id: 'c1' } },
      { customData: { contactId: 'c1' } },
    ]) {
      tareas.length = 0;
      vi.clearAllMocks();
      procesar.mockResolvedValue({ desenlace: 'respondido' });
      await POST(peticion(cuerpo));
      await tareas[0]?.();
      expect(procesar).toHaveBeenCalledWith('c1', expect.anything());
    }
  });

  // 200 y no 4xx: un cuerpo irreparable no debe hacer que GHL reintente en bucle.
  it('acepta sin agendar cuando no viene contactId', async () => {
    const res = await POST(peticion({ hola: 'mundo' }));
    expect(res.status).toBe(200);
    expect(tareas).toHaveLength(0);
  });

  it('acepta sin agendar cuando el cuerpo no es JSON', async () => {
    const res = await POST(peticion('esto no es json'));
    expect(res.status).toBe(200);
    expect(tareas).toHaveLength(0);
  });

  it('un fallo dentro del trabajo diferido no propaga', async () => {
    procesar.mockRejectedValue(new Error('boom'));
    await POST(peticion({ contactId: 'c1' }));
    await expect(tareas[0]()).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Ejecutar y verificar que falla**

Run: `npx vitest run tests/agente-webhook.test.ts`
Expected: FAIL — `Failed to resolve import "@/app/api/ghl/webhook/route"`

- [ ] **Step 3: Escribir `app/api/ghl/webhook/route.ts`**

```ts
import { NextResponse, after } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/server';
import { procesar } from '@/lib/agente/procesar';

export const runtime = 'nodejs';

function secretoValido(recibido: string | null): boolean {
  const esperado = process.env.LUXE_AGENTE_WEBHOOK_SECRET;
  if (!esperado || !recibido) return false;

  // Comparación en tiempo constante. El ataque de temporización sobre HTTP es
  // improbable, pero son tres líneas y evita tener que razonarlo nunca más.
  const a = Buffer.from(recibido);
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

// GHL manda el contacto en formas distintas según cómo se configure la acción
// de webhook en el workflow. Se aceptan todas las que aparecen en la práctica.
function contactoDe(cuerpo: unknown): string | null {
  const c = cuerpo as {
    contactId?: unknown; contact_id?: unknown;
    contact?: { id?: unknown }; customData?: { contactId?: unknown };
  };
  const candidato = c?.contactId ?? c?.contact_id ?? c?.contact?.id ?? c?.customData?.contactId;
  return typeof candidato === 'string' && candidato.trim() ? candidato.trim() : null;
}

export async function POST(request: Request) {
  if (!secretoValido(request.headers.get('x-luxe-agente-secreto'))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let cuerpo: unknown;
  try {
    cuerpo = await request.json();
  } catch {
    // 200 y no 400: un cuerpo irreparable no mejora reintentándolo, y un 4xx
    // haría que GHL lo reintentara en bucle.
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  const contactId = contactoDe(cuerpo);
  if (!contactId) {
    console.error('[agente] Webhook sin contactId; no hay nada que procesar.');
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  // El pipeline completo tarda entre 5 y 20 segundos. GHL reintenta lo que
  // tarda, y un reintento son dos respuestas al mismo cliente, así que se
  // responde ya y el trabajo sigue en segundo plano.
  after(async () => {
    try {
      const resultado = await procesar(contactId, {
        db: supabaseAdmin(),
        ghlApiKey: process.env.LUXE_GHL_API_KEY ?? '',
        locationId: process.env.LUXE_GHL_LOCATION_ID ?? '',
        anthropicKey: process.env.LUXE_ANTHROPIC_API_KEY ?? '',
        openaiKey: process.env.LUXE_OPENAI_API_KEY ?? '',
      });
      if (resultado.desenlace === 'error') {
        console.error('[agente] Turno abandonado.', 'contacto:', contactId, resultado.detalle);
      }
    } catch (err) {
      // Nada de lo que ocurra aquí puede propagarse: la respuesta HTTP ya salió.
      console.error('[agente] Fallo inesperado en el trabajo diferido.', 'contacto:', contactId, err);
    }
  });

  return NextResponse.json({ ok: true }, { status: 200 });
}
```

- [ ] **Step 4: Ejecutar y verificar que pasa**

Run: `npx vitest run tests/agente-webhook.test.ts`
Expected: PASS, 8 pruebas.

- [ ] **Step 5: Ejecutar la suite completa**

Run: `npm test`
Expected: PASS, todo verde. Las pruebas previas del repo (landing, formulario, a11y) no deben verse afectadas — nada de este trabajo toca esos archivos.

- [ ] **Step 6: Comprobar los tipos y la compilación**

Run: `npx tsc --noEmit`
Expected: sin errores.

Run: `npm run build`
Expected: build exitoso, con `/api/ghl/webhook` listado entre las rutas.

- [ ] **Step 7: Documentar en el README**

Añadir esta sección al final de `README.md`:

```markdown
## Agente de respuesta multicanal

Responde automáticamente los mensajes que entran por WhatsApp, Instagram, Facebook y correo
en GoHighLevel, mientras un asesor toma la conversación. Diseño completo en
`docs/superpowers/specs/2026-08-24-agente-ghl-multicanal-design.md`.

**Puesta en marcha en GHL:** crear un workflow con trigger *Customer Replied* y una acción
*Webhook* apuntando a `https://<dominio>/api/ghl/webhook`, método POST, con la cabecera
`x-luxe-agente-secreto` igual al valor de `LUXE_AGENTE_WEBHOOK_SECRET`.

**Requisito del token:** el Private Integration necesita los scopes `conversations.readonly`,
`conversations/message.readonly`, `conversations/message.write` y `contacts.write`.

**El agente calla solo** en cuanto un humano responde desde GHL, y tras 4 respuestas
automáticas. Para reactivarlo en un contacto:

```sql
update public.agente_conversaciones
   set estado = 'activo', turnos = 0
 where contact_id = '<id>';
```

**Para ver qué hizo:**

```sql
select contact_id, canal, estado, turnos, notificado_at, datos
  from public.agente_conversaciones
 order by updated_at desc limit 20;
```
```

- [ ] **Step 8: Commit**

```bash
git add app/api/ghl/webhook/route.ts tests/agente-webhook.test.ts README.md
git commit -m "feat(agente): webhook que responde 200 y difiere el trabajo con after()

GHL reintenta los webhooks lentos y un reintento son dos respuestas al mismo
cliente, así que el pipeline corre en segundo plano."
```

---

## Antes de desplegar

Estos pasos no son código y no los puede hacer quien ejecute el plan sin acceso a las
consolas. Hay que confirmarlos con el dueño del proyecto.

1. **Verificar el scope `conversations/message.write`** en la UI de GoHighLevel. Es el único
   riesgo abierto del spec (§14): no se comprobó porque comprobarlo envía un mensaje real.
   Sin él, todo el pipeline funciona y el agente se queda mudo en el último paso, con un 403.
2. **Cargar las variables nuevas en Vercel** (`LUXE_AGENTE_WEBHOOK_SECRET`,
   `LUXE_ANTHROPIC_API_KEY`, `LUXE_OPENAI_API_KEY`) y **eliminar allí** cualquier
   `GHL_PRIVATE_INTEGRATION`, `ANTHROPIC_API_KEY` u `OPENAI_API_KEY` sin prefijo.
3. **Restaurar Supabase y aplicar la migración.** El proyecto `ayjcduotuvvjdwgyuvih` no
   respondía el 2026-08-24 — ni DNS ni pooler — y las variables de producción en Vercel
   apuntan a él. Hasta que se resuelva, la Fase 1 tampoco puede guardar leads. Una vez
   restaurado (o migrado a un proyecto nuevo, actualizando las variables en Vercel y en
   `.env.local`): `npm run db:migrate`.
4. **Primera prueba en real:** escribir desde un WhatsApp propio antes de dejar el workflow
   activo para todos. Comprobar en la tabla que `turnos` sube a 1 y que `enviados` trae el id.
5. **Comprobar que el bucle no existe:** tras esa primera respuesta, verificar que no llega
   un segundo mensaje del agente. Si llega, la Guarda 1 no está funcionando: **apagar el
   workflow en GHL de inmediato** antes de seguir depurando.
