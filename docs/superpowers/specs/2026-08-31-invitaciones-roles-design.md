# Invitaciones, roles y pantalla de equipo — diseño (fase 4)

Fecha: 2026-08-31
Fase anterior: `docs/superpowers/specs/2026-08-28-usuarios-panel-design.md`

## El problema

La fase 3 dejó las credenciales por persona, pero el alta la hace una sola persona desde
su computadora, y la clave la elige ella:

**El vendedor no puede elegir su propia clave.** Se la ponen y se la dicen por WhatsApp, donde
queda en el teléfono de los dos para siempre. Tampoco puede cambiarla si sospecha que alguien
la vio: depende de quien tenga la consola.

**Dar de alta a alguien exige una computadora con las credenciales de administrador de la base
de datos.** Nadie en Luxe puede sumar a un vendedor sin el desarrollador.

**No hay roles.** Cualquiera que entra puede hacer todo lo que el panel permita.

## Lo que se construye

Se invita por correo. La persona invitada recibe un mensaje con un botón, elige su propia
clave, y queda dentro. Las invitaciones las manda un **superadmin** desde una pestaña nueva del
panel, sin tocar la consola.

## Decisiones

### El correo pasa a ser la identidad

Hoy se entra con un nombre de usuario (`guillermo`). Pasa a ser el correo, por tres razones que
apuntan al mismo lado: la invitación viaja a un correo, los superadmin iniciales están
identificados por correo, y un dato menos que inventar es un dato menos que olvidar.

**La tabla tiene cero filas**, así que el cambio no migra nada ni rompe a nadie. Es ahora o
nunca: con gente adentro habría que mantener las dos formas de entrar.

### El enlace de la invitación no se guarda

Se genera un valor al azar de 32 bytes que viaja en el enlace, y en la base queda **sólo su
huella SHA-256**. Quien lea la tabla no puede reconstruir ningún enlace vivo.

No se usa `scrypt` acá, a diferencia de las claves: un valor de 32 bytes al azar no se adivina
por fuerza bruta, así que el costo de `scrypt` no compraría nada y sí haría lento cada clic.

Vence a las **72 horas** y es de **un solo uso**: al fijarse la clave, la huella se borra.

### Los endpoints privilegiados releen la base, no confían en la cookie

El rol viaja dentro de la cookie firmada, y eso alcanza para decidir si se dibuja la pestaña de
equipo. **No alcanza para autorizar nada.**

Cada llamada a `/api/equipo/*` vuelve a leer la fila del usuario y comprueba `rol = 'superadmin'`
y `activo = true` contra la base. Son operaciones raras —invitar a alguien, desactivarlo— así
que una lectura extra no cuesta nada.

Esto cierra parcialmente el hueco que la fase 3 declaró y aceptó: allí `desactivar` no cortaba
la sesión viva hasta 30 días. Sigue sin cortarla **para cotizar**, pero sí la corta de
inmediato **para administrar al equipo**, que es donde el daño sería irreversible. Un superadmin
degradado o desactivado pierde el poder en la siguiente petición, no en un mes.

### El último superadmin no se puede quedar sin serlo

Ni desactivarse a sí mismo, ni ser degradado, si es el único activo que queda. Sin esa guarda,
un clic deja el panel sin nadie que pueda invitar, y la única salida es la consola contra la
base de producción.

### La pantalla de clave vive fuera del iframe

El enlace del correo se abre en una pestaña normal, no dentro de GoHighLevel. Eso es una
ventaja: ahí la cookie es de primera mano y no depende de que el navegador permita cookies de
terceros.

**Y trae una limitación que hay que decir en voz alta.** Al fijar la clave, la sesión queda
abierta *en esa pestaña*. Cuando esa misma persona abra el panel dentro de GoHighLevel, va a
tener que escribir su clave una vez, porque el navegador guarda las cookies del iframe en un
compartimento aparte (`Partitioned`). No es un fallo: es cómo funciona el aislamiento por sitio.
La clave que acaba de elegir es la que sirve.

### La consola no desaparece

Sigue siendo el arranque: sin un superadmin en la tabla no hay quien invite desde el panel. Sus
órdenes pasan a hablar de correos en vez de usuarios, y `alta` se convierte en `invitar`.

## Base de datos

```sql
alter table public.usuarios_panel
  rename column usuario to correo;

alter table public.usuarios_panel
  add column if not exists rol text not null default 'vendedor'
    check (rol in ('vendedor', 'superadmin')),
  -- Huella del enlace de invitación, no el enlace.
  add column if not exists invitacion_hash   text,
  add column if not exists invitacion_expira timestamptz;

-- Un invitado todavía no tiene clave: sin esto no se puede crear su fila.
alter table public.usuarios_panel
  alter column clave_hash drop not null,
  alter column clave_sal  drop not null;
```

Estados de una cuenta, derivados y no almacenados: **invitada** (sin `clave_hash`, con
invitación vigente), **vencida** (sin `clave_hash`, invitación caduca), **activa**
(`clave_hash` puesto, `activo`), **desactivada**.

## Superficie nueva

| Ruta | Quién | Para qué |
|---|---|---|
| `POST /api/equipo/listar` | superadmin | La tabla del equipo |
| `POST /api/equipo/invitar` | superadmin | Crea la fila y manda el correo |
| `POST /api/equipo/reenviar` | superadmin | Enlace nuevo, reloj nuevo |
| `POST /api/equipo/estado` | superadmin | Activar y desactivar |
| `GET /cotizador/clave` | cualquiera con enlace | Pantalla para elegir la clave |
| `POST /api/cotizacion/fijar-clave` | cualquiera con enlace | Fija la clave y abre la sesión |

`fijar-clave` es la única ruta del panel sin sesión previa, así que es la más expuesta: valida
el enlace en tiempo constante y no dice nunca si un correo existe. El enlace son 256 bits al
azar, se busca por huella con una igualdad indexada, y un contador no aportaría nada: no se
implementa.

## Riesgos declarados

**Un correo que no llega deja a alguien afuera** sin que nadie se entere. Por eso la tabla del
equipo muestra el estado de cada invitación y el botón de reenviar.

**El dominio de envío es nuevo** (`send.luxeessentialscr.com`, verificado el 2026-08-31). Los
primeros correos pueden caer en spam hasta que el dominio tenga reputación. Hay que avisarle al
equipo que revise esa carpeta la primera vez.

## Supuestos, para objetar

- El correo reemplaza al nombre de usuario como forma de entrar.
- Hay dos roles y nada más: vendedor y superadmin.
- La invitación vence a las 72 horas y es de un solo uso.
- Fijar la clave abre la sesión de inmediato, en esa pestaña.
- La pantalla de equipo agrega, desactiva y reenvía; no edita nombres ni cambia claves ajenas.
- Los superadmin iniciales son `aguilartradesfx@gmail.com` e `infocr.luxe@gmail.com`; sólo al
  primero se le manda la invitación al terminar.
