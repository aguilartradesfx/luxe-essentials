# Luxe Essentials — Landing

Landing B2B de captación de cotizaciones. Next.js, Supabase y GoHighLevel.

## Puesta en marcha

```bash
npm install
cp .env.example .env.local   # y rellenar los valores
npm run db:migrate
npm run usuarios -- invitar aguilartradesfx@gmail.com "Alejandro Aguilar" --superadmin
npm run images               # requiere IMÁGENES/ con los originales
npm run dev
```

En producción los dos superadmin iniciales **ya están creados**: `aguilartradesfx@gmail.com`
(invitación ya enviada) e `infocr.luxe@gmail.com` (creado con `--sin-correo`, su invitación
todavía no se mandó). No hace falta —ni conviene— volver a crearlos. Para mandarle la
invitación pendiente a `infocr.luxe@gmail.com`: entrar con `aguilartradesfx@gmail.com`, ir a la
pestaña Equipo y tocar "Reenviar" en su fila. **No existe un `reenviar` por consola:** la orden
`usuarios` no lo tiene (ver la lista completa más abajo); reenviar es sólo de la pestaña Equipo.

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor de desarrollo |
| `npm test` | Pruebas con Vitest |
| `npm run images` | Optimiza `IMÁGENES/` a `public/images/` |
| `npm run db:migrate` | Aplica las migraciones de `supabase/migrations/` |
| `npm run usuarios` | Administra las cuentas del panel de cotizaciones (invita, lista, etc.) |
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
| `RESEND_API_KEY` | Enviar la cotización y las invitaciones del equipo por correo | De la consola de Resend |
| `LUXE_CORREO_REMITENTE` | Remitente de esos dos correos | `Luxe Essentials <cotizaciones@luxeessentialscr.com>` |
| `LUXE_CONTACTO_TELEFONO` | Pie del PDF de cotización | `+506 6140 2511` |
| `LUXE_CONTACTO_CORREO` | Ídem | `info@luxeessentialscr.com` |
| `LUXE_CONTACTO_SITIO` | Ídem | `luxeessentialscr.com` |
| `LUXE_CONTACTO_HORARIO` | Ídem | `Lunes a viernes, 8:00 a 17:00` |

`LUXE_SESION_SECRETO` es **distinta** de `LUXE_TALLER_CLAVE` y no puede ser la misma: la del
taller la teclea una persona en un formulario y queda guardada en su navegador, así que quien
la conozca podría fabricarse una sesión del panel a nombre de cualquiera. Si `LUXE_SESION_SECRETO`
falta, nadie puede entrar al panel y el log dice `LUXE_SESION_SECRETO no está configurada: no se puede emitir una sesión.`

`SUPABASE_DB_URL` (o `SUPABASE_DATABASE_PASSWORD`) sólo hace falta en la máquina desde la que
se corren `npm run db:migrate` y `npm run usuarios`: son conexiones directas a Postgres, no
las usa la aplicación desplegada.

Las invitaciones y las cotizaciones se mandan desde el dominio verificado
`send.luxeessentialscr.com`. Es un dominio nuevo (verificado el 2026-08-31): los primeros
correos que salgan pueden caer en spam hasta que junte reputación — avisale al equipo que
revise esa carpeta la primera vez, sobre todo con la invitación.

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
un iframe de GoHighLevel. Se entra con **el correo**, no con un nombre de usuario, y cada
cotización queda firmada con el nombre de quien la hizo. Hay dos roles, **vendedor** y
**superadmin**; sólo un superadmin ve la pestaña Equipo del panel, desde donde se invita, se
reenvía y se desactiva gente sin tocar la consola.

**Ya no se da de alta: se invita.** La orden es:

```bash
npm run usuarios -- invitar <correo> "<nombre completo>" [--superadmin] [--sin-correo]
```

Crea la cuenta sin clave y manda un correo con un enlace para que la persona elija la suya
(vence en **72 horas** y es de un solo uso). Con `--sin-correo` la cuenta queda creada igual
pero no se manda nada — la consola muestra el enlace para pasarlo a mano.

**Ya están creados los dos superadmin de producción**, ver "Puesta en marcha" arriba: no hace
falta —ni conviene— volver a crearlos con `invitar`, porque el correo ya está tomado (`23505`,
"Ese correo ya está en el equipo.").

**Orden de puesta en marcha en un entorno nuevo.** Estos pasos, en este orden, antes de que
alguien intente entrar:

```bash
npm run db:migrate                              # crea usuarios_panel, invitaciones, roles y las
                                                 # funciones de intentos y de guarda del equipo
npm run usuarios -- invitar guillermo@luxe.cr "Guillermo Rojas" --superadmin
npm run usuarios -- listar                      # confirma que la fila quedó, y su estado

# Verifica el bloqueo tras 5 intentos (única prueba de esa función; sin ella, errores silenciosos)
# Entrar 5 veces a http://localhost:3000/cotizador con guillermo@luxe.cr + clave incorrecta
# La quinta intenta debe bloquear con "Cuenta bloqueada por intentos fallidos."; luego limpiar:
npm run usuarios -- desbloquear guillermo@luxe.cr

# Verifica la guarda del último superadmin (única verificación de esa función: la regla que
# impide dejar al equipo sin ningún administrador vive dentro de una función de Postgres, y las
# pruebas automáticas comprueban una reimplementación en JavaScript, no la función real — si
# alguien cambiara ese SQL, nada se pondría rojo. Si contara mal, el síntoma sería un panel que
# ya no puede administrar nadie)
# Con un solo superadmin activo: desde la pestaña Equipo, intentar desactivarlo o degradarlo a
# vendedor. El panel debe rechazarlo con "No se puede completar: dejaría al equipo sin su
# último superadmin activo."
```

**Sin invitar a alguien, el panel no abre para nadie.** La tabla arranca vacía, así que el
síntoma es *"Correo o clave incorrectos"* para todo el equipo, incluida la persona que
administra. No es un error de despliegue ni de credenciales de Supabase: es que no hay
usuarios. Se arregla con el `invitar` de arriba.

**La clave se teclea, no se pasa como argumento.** `clave` la pide por consola (sin eco, dos
veces) cuando no viene en la línea de órdenes. Es la forma recomendada: pasarla como argumento
la deja en `~/.zsh_history` y visible en `ps` para cualquier otro proceso de la máquina. La
forma con argumento sigue existiendo para automatizar. `invitar` ya no pide ninguna clave: la
persona invitada elige la suya la primera vez que entra, desde el enlace que esa orden manda.

**Órdenes disponibles:**

```bash
npm run usuarios -- listar                              # quién tiene acceso (nunca muestra hashes)
npm run usuarios -- invitar <correo> "<nombre>" [--superadmin] [--sin-correo]
npm run usuarios -- clave <correo>                       # clave nueva; de paso desbloquea la cuenta
npm run usuarios -- desbloquear <correo>                 # tras 5 intentos fallidos, sin esperar 15 minutos
npm run usuarios -- desactivar <correo>                  # le quita el acceso
npm run usuarios -- activar <correo>                     # se lo devuelve
```

No hay un `reenviar` por consola: el reenvío del enlace de invitación (enlace nuevo, reloj
nuevo) es sólo desde la pestaña Equipo del panel, con el botón "Reenviar" en la fila de esa
persona.

Se desactiva, nunca se borra: una cotización firmada por alguien que ya no está tiene que
seguir diciendo quién la hizo.

**Para sacar a alguien del equipo hacen falta dos pasos, no uno:** desactivarla —por consola o
desde la pestaña Equipo, es lo mismo— y **además** rotar `LUXE_SESION_SECRETO` en Vercel
(`openssl rand -hex 32`) y volver a desplegar.

```bash
npm run usuarios -- desactivar guillermo@luxe.cr
```

`desactivar` impide entradas futuras, y para **administrar el equipo** (invitar, reenviar,
activar, desactivar, cambiar de rol) corta el poder de inmediato: esas cuatro rutas releen la
base en cada llamada. Pero **no corta la sesión que esa persona ya tenga abierta para
cotizar**: esa cookie dura 30 días y las rutas de cotizar no vuelven a consultar la tabla en
cada petición. Rotar el secreto invalida todas las sesiones vivas de una vez, y ése es el paso
que de verdad la saca de cotizar. El costo es que **todo el equipo tiene que volver a entrar
una vez** —con cinco personas es trivial, y no afecta a `/q7m4`, que tiene su propia clave.

**Salir / cambiar de usuario.** El panel tiene un botón "Salir" junto a "Sesión de …". En una
computadora compartida hay que usarlo: si no, la siguiente persona cotiza con la sesión de la
anterior y la cotización queda firmada con el nombre equivocado.

**Para ver el estado de las cuentas:**

```sql
select correo, nombre, rol, activo, intentos, bloqueado_hasta, invitacion_expira, ultimo_acceso
  from public.usuarios_panel order by activo desc, correo;
```

**La limitación del iframe.** Quien fija su clave desde el enlace del correo lo hace en una
pestaña normal del navegador, no dentro de GoHighLevel, y queda dentro **de esa pestaña**. La
primera vez que esa misma persona abra el panel embebido en GoHighLevel va a tener que escribir
su clave una vez más: el navegador guarda las cookies del iframe en un compartimento aparte
(`Partitioned`), separado del de la pestaña donde recién entró. No es un error ni significa que
la clave elegida no sirvió — es justamente la que sirve. Vale la pena avisarlo de antemano,
para que no llegue como sorpresa a quien recién se sumó.

**Aviso de despliegue.** El formato de la cookie de sesión cambió con esta fase (suma el rol y
el id de la fila, firmados junto con el resto). Al desplegar, **todas las sesiones abiertas
quedan invalidadas**: quien esté dentro del panel en ese momento tiene que volver a entrar una
vez, con su misma clave — no hay que resetear nada.

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
