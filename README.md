# Luxe Essentials — Landing

Landing B2B de captación de cotizaciones. Next.js, Supabase y GoHighLevel.

## Puesta en marcha

```bash
npm install
cp .env.example .env.local   # y rellenar los valores
npm run db:migrate
npm run images               # requiere IMÁGENES/ con los originales
npm run dev
```

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor de desarrollo |
| `npm test` | Pruebas con Vitest |
| `npm run images` | Optimiza `IMÁGENES/` a `public/images/` |
| `npm run db:migrate` | Aplica las migraciones de `supabase/migrations/` |
| `node scripts/ghl-discover.mjs` | Diagnostica la conexión con GoHighLevel |

## Dónde tocar qué

- **Texto del sitio:** `content/copy.ts`. No hay texto visible en los componentes.
- **Imágenes:** `content/media.ts` declara cada una. Para añadir una pendiente, colocar el
  archivo en `public/images/<id>.webp` y cambiar `pending: true` a `pending: false` en su
  entrada. `pending` es un campo obligatorio de `MediaEntry` (no opcional): omitirlo es un
  error de compilación (TS2741), a propósito.
- **Fotografía pendiente:** toda la línea de hogar y seis de los siete pasos de proceso.

## Leads

Cada envío se guarda en `public.leads` y luego se sincroniza a GoHighLevel. Si GHL falla, la
fila queda con `ghl_error` poblado y el lead sigue recuperable:

```sql
select id, created_at, email, ghl_error from public.leads where ghl_contact_id is null;
```

## Agente de respuesta multicanal

Responde automáticamente los mensajes que entran por WhatsApp, Instagram, Facebook y correo
en GoHighLevel, mientras un asesor toma la conversación. Diseño completo en
`docs/superpowers/specs/2026-08-24-agente-ghl-multicanal-design.md`.

**Puesta en marcha en GHL:** crear un workflow con trigger *Customer Replied* y una acción
*Webhook* apuntando a `https://<dominio>/api/ghl/webhook`, método POST, con la cabecera
`x-luxe-agente-secreto` igual al valor de `LUXE_AGENTE_WEBHOOK_SECRET`.

**Requisito del token:** el Private Integration necesita los scopes `conversations.readonly`,
`conversations/message.readonly`, `conversations/message.write` y `contacts.write`.

**Orden de despliegue.** Hay dos migraciones: `0002_agente.sql` crea la tabla y
`0003_agente_arriendo.sql` añade la columna `procesando_hasta`, que el código usa en cada
mensaje. `npm run db:migrate` aplica las pendientes en orden, pero **hay que ejecutarlo antes
de desplegar el código**: si el código llega primero, cada intento de tomar el candado recibe
un error de columna inexistente y el agente no responde a nadie. Falla cerrado y ruidoso, no
en silencio, pero el orden ahorra el susto.

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
