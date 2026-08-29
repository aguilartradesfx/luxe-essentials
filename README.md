# Luxe Essentials — Landing

Landing B2B de captación de cotizaciones. Next.js, Supabase y GoHighLevel.

## Puesta en marcha

```bash
npm install
cp .env.example .env.local   # y rellenar los valores
npm run db:migrate
npm run usuarios -- alta guillermo "Guillermo Rojas"   # cuenta del panel; sin esto no abre
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
| `npm run usuarios` | Administra las cuentas del panel de cotizaciones |
| `node scripts/ghl-discover.mjs` | Diagnostica la conexión con GoHighLevel |

## Variables de entorno en Vercel

Todas van en el proyecto de Vercel **antes** de desplegar. `.env.example` tiene los mismos
nombres sin valores; `.env.local` es la copia local y no se versiona.

| Variable | Para qué | Valor |
|---|---|---|
| `NEXT_PUBLIC_SITE_URL` | URL canónica del sitio | `https://luxeessentialscr.com` |
| `NEXT_PUBLIC_SUPABASE_URL` | Base de datos | Del panel de Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Base de datos, desde el servidor | Del panel de Supabase |
| `LUXE_GHL_API_KEY` | Leads, cotizaciones y agente en GoHighLevel | Private Integration de GHL |
| `LUXE_GHL_LOCATION_ID` | Ídem | Del panel de GHL |
| `LUXE_AGENTE_WEBHOOK_SECRET` | Cabecera `x-luxe-agente-secreto` del webhook | Cualquier secreto largo |
| `LUXE_ANTHROPIC_API_KEY` | Cerebro del agente | De la consola de Anthropic |
| `LUXE_OPENAI_API_KEY` | Transcripción de audios del agente | De la consola de OpenAI |
| `LUXE_TALLER_CLAVE` | Clave del banco de pruebas `/q7m4` | La que se le da al equipo |
| `LUXE_SESION_SECRETO` | Firma la cookie de sesión del **panel de cotizaciones** | `openssl rand -hex 32` |
| `RESEND_API_KEY` | Enviar la cotización por correo | De la consola de Resend |
| `LUXE_CORREO_REMITENTE` | Remitente de ese correo | `Luxe Essentials <cotizaciones@luxeessentialscr.com>` |
| `LUXE_CONTACTO_TELEFONO` | Pie del PDF de cotización | `+506 6140 2511` |
| `LUXE_CONTACTO_CORREO` | Ídem | `info@luxeessentialscr.com` |
| `LUXE_CONTACTO_SITIO` | Ídem | `luxeessentialscr.com` |
| `LUXE_CONTACTO_HORARIO` | Ídem | `Lunes a viernes, 8:00 a 17:00` |

`LUXE_SESION_SECRETO` es **distinta** de `LUXE_TALLER_CLAVE` y no puede ser la misma: la del
taller la teclea una persona en un formulario y queda guardada en su navegador, así que quien
la conozca podría fabricarse una sesión del panel a nombre de cualquiera. Si `LUXE_SESION_SECRETO`
falta, nadie puede entrar al panel y el log dice `¿Falta LUXE_SESION_SECRETO?`.

`SUPABASE_DB_URL` (o `SUPABASE_DATABASE_PASSWORD`) sólo hace falta en la máquina desde la que
se corren `npm run db:migrate` y `npm run usuarios`: son conexiones directas a Postgres, no
las usa la aplicación desplegada.

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

## Panel de cotizaciones

El panel (`/cotizador`) es donde el equipo arma, envía y cierra cotizaciones. Vive embebido en
un iframe de GoHighLevel. Cada vendedor entra con **su propia cuenta**: usuario y clave por
persona, guardadas cifradas en `public.usuarios_panel`, y cada cotización queda firmada con su
nombre. Ya no hay una clave compartida.

**Orden de puesta en marcha.** Los tres pasos, en este orden, antes de que alguien intente
entrar:

```bash
npm run db:migrate                              # crea usuarios_panel y la función de intentos
npm run usuarios -- alta guillermo "Guillermo Rojas"   # pide la clave por consola
npm run usuarios -- listar                      # confirma que la fila quedó
# Verifica el bloqueo tras 5 intentos (única prueba de esa función; sin ella, errores silenciosos)
# Entrar 5 veces a http://localhost:3000/cotizador con usuario guillermo + clave incorrecta
# La quinta intenta debe bloquear con "Cuenta bloqueada"; luego limpiar:
npm run usuarios -- desbloquear guillermo
```

**Sin dar de alta a alguien, el panel no abre para nadie.** La tabla arranca vacía y la clave
compartida ya no sirve, así que el síntoma es *"Usuario o clave incorrectos"* para todo el
equipo, incluida la persona que administra. No es un error de despliegue ni de credenciales de
Supabase: es que no hay usuarios. Se arregla con el `alta` de arriba.

**La clave se teclea, no se pasa como argumento.** `alta` y `clave` la piden por consola (sin
eco, dos veces) cuando no viene en la línea de órdenes. Es la forma recomendada: pasarla como
argumento la deja en `~/.zsh_history` y visible en `ps` para cualquier otro proceso de la
máquina. La forma con argumento sigue existiendo para automatizar.

**Órdenes disponibles:**

```bash
npm run usuarios -- listar                     # quién tiene acceso (nunca muestra hashes)
npm run usuarios -- alta <usuario> "<nombre>"  # alta; el nombre es lo que firma las cotizaciones
npm run usuarios -- clave <usuario>            # clave nueva; de paso desbloquea la cuenta
npm run usuarios -- desbloquear <usuario>      # tras 5 intentos fallidos, sin esperar 15 minutos
npm run usuarios -- desactivar <usuario>       # le quita el acceso
npm run usuarios -- activar <usuario>          # se lo devuelve
```

Se desactiva, nunca se borra: una cotización firmada por alguien que ya no está tiene que
seguir diciendo quién la hizo.

**Para sacar a alguien del equipo hacen falta dos pasos, no uno:**

```bash
npm run usuarios -- desactivar guillermo
```

y **además** rotar `LUXE_SESION_SECRETO` en Vercel (`openssl rand -hex 32`) y volver a
desplegar. `desactivar` impide entradas futuras, pero **no corta la sesión que esa persona ya
tenga abierta**: la cookie dura 30 días y el servidor no vuelve a consultar la tabla en cada
petición. Rotar el secreto invalida todas las sesiones vivas de una vez, y ése es el paso que
de verdad la saca. El costo es que **todo el equipo tiene que volver a entrar una vez** —con
cinco personas es trivial, y ya no afecta a `/q7m4`, que tiene su propia clave.

**Salir / cambiar de usuario.** El panel tiene un botón "Salir" junto a "Sesión de …". En una
computadora compartida hay que usarlo: si no, la siguiente persona cotiza con la sesión de la
anterior y la cotización queda firmada con el nombre equivocado.

**Para ver el estado de las cuentas:**

```sql
select usuario, nombre, activo, intentos, bloqueado_hasta, ultimo_acceso
  from public.usuarios_panel order by activo desc, usuario;
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
