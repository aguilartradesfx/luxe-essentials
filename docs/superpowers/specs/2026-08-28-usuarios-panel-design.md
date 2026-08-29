# Usuarios del panel — diseño (fase 3)

Fecha: 2026-08-28
Fase anterior: `docs/superpowers/specs/2026-08-27-panel-cotizaciones-design.md`

## El problema

El panel se entra con **una sola clave compartida**. No existe ningún concepto de usuario:
ni en el esquema, ni en el código. Eso deja tres huecos que hay que cerrar antes de que la
herramienta llegue a manos de vendedores:

**Una cotización no tiene autor.** La tabla guarda cliente, montos, estado y fechas, pero no
quién la hizo. Si dos vendedores cotizan al mismo hotel, nadie sabe quién fue, y no se puede
medir quién vende.

**No se le puede quitar el acceso a una persona.** La única forma es cambiar la clave, y eso
saca a todo el equipo al mismo tiempo.

**Nada frena los intentos.** Una sola credencial, sin límite de intentos, delante del acceso
administrativo a las cotizaciones de todos los clientes.

## Lo que se construye

**Una credencial por persona, en una tabla.** No en variables de entorno: con una tabla,
agregar o quitar a alguien es un registro y no un despliegue, y el dueño del proyecto lo hace
sin depender de nadie.

El vendedor escribe su nombre de usuario y su clave. La sesión recuerda quién es. Cada
cotización queda firmada con su nombre, y eso aparece en el listado y habilita medir cuánto
cotiza y cierra cada quien.

## Decisiones

### Las claves se guardan cifradas

Con `scrypt` del módulo `node:crypto` — sin dependencias nuevas — y sal por usuario. Hoy la
clave única vive en texto plano en una variable de entorno; eso es tolerable para un secreto
de servidor, no para las credenciales de un equipo.

La comparación es en tiempo constante, igual que el resto del proyecto.

### Los usuarios se administran por línea de comandos

Un script para dar de alta, desactivar y listar. **No una pantalla de administración**: es
más superficie de ataque, más código y más pruebas para algo que se usa tres veces al año.

Desactivar en vez de borrar: una cotización firmada por alguien que ya no está tiene que
seguir diciendo quién la hizo.

### `/q7m4` no se toca

El banco de pruebas del agente usa hoy la misma clave. Al separarse, cada uno queda con la
suya y ese sigue funcionando exactamente igual. **`LUXE_TALLER_CLAVE` sigue siendo el secreto
con el que se firma la cookie de sesión** — eso es un secreto de servidor, no una credencial
de usuario, y no cambia.

### Límite de intentos

Por usuario, en la misma tabla: se cuentan los fallos consecutivos y se bloquea
temporalmente. Es lo que hace que una tabla de credenciales sea mejor que una clave
compartida y no sólo distinta.

No hace falta almacenamiento compartido entre funciones: el contador vive en la fila del
usuario, que ya es la fuente de verdad.

### El pie del documento lleva los datos de la empresa, no los del vendedor

Decisión del dueño del proyecto. El hotel ve a Luxe como empresa; la atribución es interna.

Datos tomados del pie del sitio (`content/copy.ts`), para no duplicar una fuente de verdad:
teléfono, correo, horario y sitio.

## Base de datos

```sql
create table public.usuarios_panel (
  id            uuid primary key default gen_random_uuid(),
  usuario       text not null unique,      -- con lo que entra
  nombre        text not null,             -- lo que firma las cotizaciones
  clave_hash    text not null,
  clave_sal     text not null,
  activo        boolean not null default true,
  intentos      integer not null default 0,
  bloqueado_hasta timestamptz,
  creado_at     timestamptz not null default now(),
  ultimo_acceso timestamptz
);
```

Y en `cotizaciones`, una columna `vendedor text` con el nombre de quien la armó. **Se guarda
el nombre, no el id**: una cotización de hace un año tiene que decir quién la hizo aunque esa
persona se haya dado de baja, igual que `lineas` guarda los precios de ese día y no una
referencia al catálogo.

## Migración desde la clave compartida

El panel deja de aceptar `LUXE_TALLER_CLAVE` como credencial de entrada. El primer usuario se
crea con el script antes de desplegar.

**Esto es un corte, no una transición gradual**, y es a propósito: dejar las dos vías vivas
mantendría el hueco que esta fase existe para cerrar.

Antes de desplegar, con la migración ya aplicada:

    npm run db:migrate
    npm run usuarios -- alta guillermo "Guillermo Rojas" '<clave>'
    npm run usuarios -- listar

Si esto no se hace, nadie entra al panel: la clave compartida ya no sirve.

## Riesgos declarados

**Si el equipo no crea usuarios antes de desplegar, nadie entra.** El script tiene que correrse
como parte del despliegue, no después. Es el mismo criterio que las migraciones.

**El límite de intentos puede dejar afuera a alguien legítimo** que se equivoque varias veces.
El bloqueo es temporal y el script permite desbloquear.

## Supuestos, para objetar

- Los usuarios se administran por consola, no por pantalla.
- Las cotizaciones guardan el nombre del vendedor, no una referencia a su fila.
- El pie del PDF lleva los datos de la empresa, tomados del contenido del sitio.
- La clave compartida deja de servir para entrar al panel, de golpe.
