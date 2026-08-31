# Invitaciones, roles y pantalla de equipo — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que un superadmin invite gente por correo desde el panel, que la persona invitada elija
su propia clave desde un enlace de un solo uso, y que quede dentro sin pasar por la consola.

**Architecture:** El correo reemplaza al nombre de usuario como identidad. La invitación es un
valor al azar de 32 bytes que viaja en el enlace y del que la base guarda sólo la huella
SHA-256. La cookie de sesión suma el rol para decidir qué se dibuja, pero cada endpoint de
`/api/equipo/*` relee la fila del usuario y comprueba rol y estado contra la base antes de
actuar.

**Tech Stack:** Next.js 16 (App Router), TypeScript, `node:crypto`, Supabase (Postgres),
Resend por `fetch`, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-31-invitaciones-roles-design.md`

## Global Constraints

- **Nada de dependencias nuevas.**
- **La tabla `usuarios_panel` tiene cero filas.** Todo cambio de esquema es libre: no hay datos
  que migrar y no hay sesiones vivas que romper.
- **El rol de la cookie no autoriza nada.** Sirve para dibujar la interfaz. Toda ruta de
  `/api/equipo/*` relee la fila y comprueba `rol = 'superadmin'` y `activo = true`.
- **El enlace de invitación nunca se guarda**, sólo su huella SHA-256. Vence a las 72 horas y es
  de un solo uso.
- **El último superadmin activo no puede desactivarse ni ser degradado.**
- **Correo saliente:** `RESEND_API_KEY` y `LUXE_CORREO_REMITENTE` ya están configuradas y
  verificadas (dominio `send.luxeessentialscr.com`, primer envío correcto el 2026-08-31). Se
  manda con `fetch` crudo y `fetchImpl` inyectable, como `lib/cotizador/correo.ts`.
- **Comparaciones de secretos en tiempo constante** con `timingSafeEqual`.
- **Todo el texto en español de Costa Rica**, voseo, sin tuteo peninsular. Commits sin tildes.
- **El PDF no menciona métodos de pago.** Restricción vigente desde la fase 1.
- **Pruebas:** `npm test`. La suite está en 782 y debe quedar verde al final de cada tarea.
  `npx tsc --noEmit` limpio.

## Corrección al diseño

El diseño dice que `fijar-clave` «limita los intentos por enlace igual que la entrada normal».
**No se implementa así, y es a propósito:** el enlace son 32 bytes al azar (256 bits). Un
contador de intentos no compra nada contra eso, y añade una escritura y un estado que mantener.
Lo que sí se hace es buscar la fila **por la huella** —una igualdad indexada, no una comparación
en la aplicación— y devolver siempre el mismo error. La primera tarea que toque el diseño debe
corregir esa frase.

---

## Estructura de archivos

**Nuevos:**
- `supabase/migrations/0014_equipo_invitaciones.sql`
- `lib/cotizador/invitaciones.ts` — generar enlace, huella, validar y consumir.
- `lib/cotizador/equipo.ts` — capa de base del equipo: listar, invitar, reenviar, cambiar estado,
  y la relectura que autoriza.
- `lib/cotizador/correo-invitacion.ts` — el correo de invitación.
- `app/api/equipo/{listar,invitar,reenviar,estado}/route.ts`
- `app/api/cotizacion/fijar-clave/route.ts`
- `app/cotizador/clave/page.tsx` y `app/cotizador/PantallaFijarClave.tsx`
- `app/cotizador/VistaEquipo.tsx`
- `tests/equipo-invitaciones.test.ts`, `tests/equipo-api.test.ts`,
  `tests/api-fijar-clave.test.ts`, `tests/equipo-ui.test.tsx`

**Modificados:**
- `lib/cotizador/usuarios.ts` — `correo` en vez de `usuario`; devuelve el rol.
- `lib/sesion.ts` — la cookie lleva el rol.
- `lib/autenticacion-cotizador.ts` — devuelve el rol.
- `app/api/cotizacion/entrar/route.ts` — recibe `correo`.
- `app/api/cotizacion/catalogo/route.ts` — la sonda devuelve el rol.
- `app/cotizador/PantallaClave.tsx` — el campo pasa a ser Correo.
- `app/cotizador/Panel.tsx` — pestaña Equipo, sólo si el rol es superadmin.
- `scripts/usuarios.mjs` — órdenes por correo; `alta` pasa a `invitar`.
- `README.md`, `docs/superpowers/specs/2026-08-31-invitaciones-roles-design.md`

---

### Task 1: Esquema y módulo de invitaciones

**Files:**
- Create: `supabase/migrations/0014_equipo_invitaciones.sql`
- Create: `lib/cotizador/invitaciones.ts`
- Modify: `docs/superpowers/specs/2026-08-31-invitaciones-roles-design.md` (la corrección de arriba)
- Test: `tests/equipo-invitaciones.test.ts`

**Interfaces:**
- Produces:
  - `generarInvitacion(): { enlace: string; huella: string; expira: Date }` — `enlace` es hex de
    32 bytes al azar; `huella` es su SHA-256 en hex; `expira` es 72 horas después de ahora.
  - `huellaDe(enlace: string): string` — SHA-256 en hex.
  - `HORAS_VIGENCIA = 72`
  - Columnas nuevas: `correo` (renombrada), `rol`, `invitacion_hash`, `invitacion_expira`;
    `clave_hash` y `clave_sal` pasan a admitir nulo.

- [ ] **Step 1: Escribir la prueba que falla**

```ts
import { describe, it, expect } from 'vitest';
import { generarInvitacion, huellaDe, HORAS_VIGENCIA } from '@/lib/cotizador/invitaciones';

describe('invitaciones', () => {
  it('genera un enlace de 32 bytes en hexadecimal', () => {
    expect(generarInvitacion().enlace).toMatch(/^[0-9a-f]{64}$/);
  });

  it('no repite el enlace', () => {
    expect(generarInvitacion().enlace).not.toBe(generarInvitacion().enlace);
  });

  // Lo que se guarda es la huella. Si alguien lee la tabla no puede
  // reconstruir ningún enlace vivo.
  it('la huella no contiene el enlace y es determinista', () => {
    const { enlace, huella } = generarInvitacion();
    expect(huella).not.toContain(enlace);
    expect(huella).toMatch(/^[0-9a-f]{64}$/);
    expect(huellaDe(enlace)).toBe(huella);
  });

  it('vence a las 72 horas', () => {
    const antes = Date.now();
    const { expira } = generarInvitacion();
    const horas = (expira.getTime() - antes) / 3_600_000;
    expect(HORAS_VIGENCIA).toBe(72);
    expect(horas).toBeGreaterThan(71.9);
    expect(horas).toBeLessThan(72.1);
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run tests/equipo-invitaciones.test.ts`
Expected: FAIL — no existe el módulo.

- [ ] **Step 3: Escribir `lib/cotizador/invitaciones.ts`**

```ts
import 'server-only';
import { createHash, randomBytes } from 'node:crypto';

// El enlace son 32 bytes al azar (256 bits). Contra eso un contador de
// intentos no compra nada —no se adivina—, así que no se implementa: la fila
// se busca POR la huella, que es una igualdad indexada en la base y no una
// comparación en la aplicación.
//
// Se guarda la huella y no el enlace, por la misma razón que las claves van
// cifradas: quien lea la tabla no debe poder entrar como nadie. Acá alcanza
// SHA-256 y no hace falta `scrypt`, que existe para encarecer la fuerza bruta
// sobre secretos que un humano eligió; un valor al azar de 256 bits no tiene
// esa debilidad, y `scrypt` sólo haría lento cada clic del enlace.
export const HORAS_VIGENCIA = 72;

export function huellaDe(enlace: string): string {
  return createHash('sha256').update(enlace).digest('hex');
}

export function generarInvitacion(): { enlace: string; huella: string; expira: Date } {
  const enlace = randomBytes(32).toString('hex');
  return {
    enlace,
    huella: huellaDe(enlace),
    expira: new Date(Date.now() + HORAS_VIGENCIA * 3_600_000),
  };
}
```

- [ ] **Step 4: Correr y verificar que pasa**

Run: `npx vitest run tests/equipo-invitaciones.test.ts`
Expected: PASS (4 pruebas).

- [ ] **Step 5: Escribir la migración**

```sql
-- supabase/migrations/0014_equipo_invitaciones.sql
-- Fase 4: se invita por correo y hay dos roles. La tabla tiene cero filas al
-- momento de escribir esto, así que el renombre no migra nada.

alter table public.usuarios_panel rename column usuario to correo;

alter table public.usuarios_panel
  add column if not exists rol text not null default 'vendedor'
    check (rol in ('vendedor', 'superadmin')),
  -- La HUELLA del enlace, nunca el enlace.
  add column if not exists invitacion_hash   text,
  add column if not exists invitacion_expira timestamptz;

-- Una persona invitada todavía no eligió su clave: sin esto no se puede
-- crear su fila.
alter table public.usuarios_panel
  alter column clave_hash drop not null,
  alter column clave_sal  drop not null;

-- El índice único de la 0012 era sobre lower(usuario); la columna cambió de
-- nombre y Postgres NO actualiza la expresión sola.
drop index if exists usuarios_panel_usuario_idx;
create unique index if not exists usuarios_panel_correo_idx
  on public.usuarios_panel (lower(correo));

-- Se busca por huella en cada clic del enlace del correo.
create index if not exists usuarios_panel_invitacion_idx
  on public.usuarios_panel (invitacion_hash) where invitacion_hash is not null;
```

- [ ] **Step 6: Aplicar y verificar**

Run: `npm run db:migrate`
Expected: `✓ 0014_equipo_invitaciones.sql`.

Después, comprobar que el índice único quedó sobre la columna nueva:

Run: `npm run usuarios -- listar`
Expected: no revienta (la orden todavía consulta `usuario`; si falla por eso, es esperado y lo
arregla la Tarea 7 — anotalo y seguí).

- [ ] **Step 7: Corregir el diseño**

En `docs/superpowers/specs/2026-08-31-invitaciones-roles-design.md`, la sección de superficie
nueva dice que `fijar-clave` «limita los intentos por enlace igual que la entrada normal».
Reemplazalo por la razón real: el enlace son 256 bits al azar, se busca por huella con una
igualdad indexada, y un contador no aportaría nada.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/0014_equipo_invitaciones.sql lib/cotizador/invitaciones.ts tests/equipo-invitaciones.test.ts docs/superpowers/specs/2026-08-31-invitaciones-roles-design.md
git commit -m "feat(equipo): esquema de invitaciones y roles, y modulo de enlaces"
```

---

### Task 2: La identidad pasa a ser el correo, y aparece el rol

**Files:**
- Modify: `lib/cotizador/usuarios.ts`
- Test: `tests/usuarios-autenticacion.test.ts` (existente)

**Interfaces:**
- Consumes: nada de la Tarea 1.
- Produces:
  - `normalizarCorreo(correo: string): string` — reemplaza a `normalizarUsuario`; `trim()` y
    `toLowerCase()`.
  - `autenticarUsuario(correo: string, clave: string, db: Db, ahora?: Date): Promise<ResultadoEntrada>`
  - `type ResultadoEntrada = { ok: true; nombre: string; rol: Rol } | { ok: false; motivo: 'credenciales' | 'bloqueado' }`
  - `type Rol = 'vendedor' | 'superadmin'`

- [ ] **Step 1: Escribir las pruebas que fallan**

En `tests/usuarios-autenticacion.test.ts`, adaptar el doble de base para que la fila traiga
`correo` y `rol`, y añadir:

```ts
it('devuelve el rol junto al nombre', async () => {
  const { cliente } = db(await filaDe('Turrialba-2026', { rol: 'superadmin' }));
  const r = await autenticarUsuario('guillermo@luxe.cr', 'Turrialba-2026', cliente);
  expect(r).toEqual({ ok: true, nombre: 'Guillermo Rojas', rol: 'superadmin' });
});

it('el rol por defecto es vendedor', async () => {
  const { cliente } = db(await filaDe('Turrialba-2026', { rol: 'vendedor' }));
  const r = await autenticarUsuario('guillermo@luxe.cr', 'Turrialba-2026', cliente);
  expect(r.ok && r.rol).toBe('vendedor');
});

it('normaliza el correo: mayúsculas y espacios no impiden entrar', async () => {
  const { cliente } = db(await filaDe('Turrialba-2026'));
  const r = await autenticarUsuario('  GUILLERMO@LUXE.CR ', 'Turrialba-2026', cliente);
  expect(r.ok).toBe(true);
});

// Una persona invitada que todavía no eligió su clave no tiene con qué
// entrar. Sin esta guarda, `verificarClave` recibiría null y el
// comportamiento dependería de que ese módulo lo tolere.
it('rechaza a quien fue invitado pero aún no fijó su clave', async () => {
  const { cliente } = db(await filaDe('Turrialba-2026', { clave_hash: null, clave_sal: null }));
  const r = await autenticarUsuario('guillermo@luxe.cr', 'x', cliente);
  expect(r).toEqual({ ok: false, motivo: 'credenciales' });
});
```

Actualizar el resto del archivo: `usuario:` pasa a `correo:` en las filas de ejemplo, y todas
las llamadas usan un correo. **Conservar cada aserción existente**; esto es un renombre, no una
reescritura.

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run tests/usuarios-autenticacion.test.ts`
Expected: FAIL — no existe `rol` en el resultado.

- [ ] **Step 3: Modificar `lib/cotizador/usuarios.ts`**

- `normalizarUsuario` pasa a `normalizarCorreo` (mismo cuerpo).
- La consulta selecciona `correo` en vez de `usuario` y filtra `.eq('correo', …)`.
- `FilaUsuario` suma `rol: Rol` y sus `clave_hash`/`clave_sal` pasan a `string | null`.
- Antes de verificar la clave, si `clave_hash` o `clave_sal` son nulos: gastar el tiempo de hash
  y devolver `{ ok: false, motivo: 'credenciales' }`. Comentario explicando que una invitación
  pendiente no es una credencial.
- El caso feliz devuelve `{ ok: true, nombre, rol: fila.rol }`.
- Exportar `export type Rol = 'vendedor' | 'superadmin';`

- [ ] **Step 4: Correr la suite completa**

Run: `npm test` y `npx tsc --noEmit`
Expected: fallan las llamadas a `normalizarUsuario` en `scripts/usuarios.mjs` (lo arregla la
Tarea 7) — si el script no está en el alcance de `tsc`, la suite queda verde. Anotá lo que veas.

- [ ] **Step 5: Commit**

```bash
git add lib/cotizador/usuarios.ts tests/usuarios-autenticacion.test.ts
git commit -m "feat(equipo): el correo es la identidad y la autenticacion devuelve el rol"
```

---

### Task 3: La sesión lleva el rol

**Files:**
- Modify: `lib/sesion.ts`
- Modify: `lib/autenticacion-cotizador.ts`
- Modify: `app/api/cotizacion/entrar/route.ts`
- Modify: `app/api/cotizacion/catalogo/route.ts`
- Test: `tests/panel-sesion.test.ts`, `tests/api-cotizacion-sesion.test.ts`,
  `tests/api-cotizacion-catalogo.test.ts` (existentes)

**Interfaces:**
- Consumes: `Rol` de `@/lib/cotizador/usuarios` (Tarea 2).
- Produces:
  - `emitirSesion(nombre: string, rol: Rol): { cookie: string; csrf: string }` — **cambia de firma**.
  - `sesionDe(request: Request): { nombre: string; rol: Rol } | null` — reemplaza a
    `nombreDeSesion`, que se elimina.
  - `sesionValida(request)` sigue igual, definida como `sesionDe(request) !== null`.
  - `autenticarPeticion(...)` → `{ ok: true; vendedor: string; rol: Rol } | { ok: false; status; error }`.
  - `/entrar` responde `{ ok: true, csrf, vendedor, rol }`; `/catalogo` suma `rol` a su respuesta.

El valor de la cookie pasa de `<emitidoEn>.<nombre>.<firma>` a `<emitidoEn>.<nombre>.<rol>.<firma>`,
con la firma cubriendo `<emitidoEn>.<nombre>.<rol>`. El rol va en claro (no es secreto) pero
**dentro** del valor firmado, para que no se pueda cambiar. Una cookie de tres partes —el
formato de la fase 3— queda rechazada.

- [ ] **Step 1: Escribir las pruebas que fallan**

En `tests/panel-sesion.test.ts`:

```ts
it('recuerda el rol con el que se emitió', () => {
  const { cookie } = emitirSesion('Guillermo Rojas', 'superadmin');
  expect(sesionDe(pedirCon(cookie))).toEqual({ nombre: 'Guillermo Rojas', rol: 'superadmin' });
});

// Sin esto, cualquiera con una sesión de vendedor se asciende editando su
// propia cookie. La firma cubre el rol justamente para impedirlo.
it('rechaza una cookie con el rol alterado', () => {
  const { cookie } = emitirSesion('Guillermo Rojas', 'vendedor');
  const valor = cookie.split(';')[0].split('=')[1];
  const [emitido, nombre, , firma] = valor.split('.');
  const falsa = `luxe_sesion=${emitido}.${nombre}.superadmin.${firma}`;
  const req = new Request('https://luxeessentialscr.com/x', { headers: { cookie: falsa } });
  expect(sesionDe(req)).toBeNull();
});

it('rechaza una cookie del formato anterior, de tres partes', () => {
  const req = new Request('https://luxeessentialscr.com/x', {
    headers: { cookie: 'luxe_sesion=1756000000000.R3VpbGxlcm1v.deadbeef' },
  });
  expect(sesionDe(req)).toBeNull();
});

it('rechaza un rol que no es ninguno de los dos', () => {
  const { cookie } = emitirSesion('Guillermo Rojas', 'vendedor');
  const valor = cookie.split(';')[0].split('=')[1];
  const [emitido, nombre] = valor.split('.');
  // Firmada de verdad, pero con un rol inventado: se rechaza por el valor,
  // no por la firma.
  expect(sesionDe(new Request('https://luxeessentialscr.com/x', {
    headers: { cookie: `luxe_sesion=${emitido}.${nombre}.dios.${'0'.repeat(64)}` },
  }))).toBeNull();
});

it('no emite una sesión con un rol inválido', () => {
  // @ts-expect-error se prueba el guard en tiempo de ejecución
  expect(() => emitirSesion('Guillermo Rojas', 'dios')).toThrow();
});
```

Y actualizar **todas** las llamadas existentes a `emitirSesion(...)` en los tres archivos de
prueba para que pasen un rol, y las de `nombreDeSesion` para que usen `sesionDe`.

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run tests/panel-sesion.test.ts`
Expected: FAIL — `sesionDe` no existe.

- [ ] **Step 3: Modificar `lib/sesion.ts`**

Añadir el rol como cuarto segmento, cubierto por la firma. `emitirSesion` valida que el rol sea
uno de los dos y lanza si no. `sesionDe` exige cuatro partes exactas, verifica la firma sobre
`<emitidoEn>.<nombre>.<rol>`, conserva **las tres protecciones que ya existen** (caducidad
verificada en el servidor, rechazo de fecha de emisión futura con tolerancia de reloj,
comparación en tiempo constante) y valida que el rol leído sea uno de los dos.
`nombreDeSesion` se elimina; `sesionValida` pasa a `sesionDe(request) !== null`.

- [ ] **Step 4: Propagar a las tres rutas y a la autenticación**

- `lib/autenticacion-cotizador.ts`: usa `sesionDe`, devuelve `{ ok: true, vendedor, rol }`.
  Añadir un comentario diciendo que **este rol no autoriza nada**: sirve para la interfaz, y
  las rutas de `/api/equipo/*` releen la base.
- `app/api/cotizacion/entrar/route.ts`: pasa `resultado.rol` a `emitirSesion` y devuelve `rol`.
  El campo del cuerpo pasa de `usuario` a `correo`, validado con `z.string().trim().email()`.
- `app/api/cotizacion/catalogo/route.ts`: suma `rol` junto al `csrf` que ya devuelve.

- [ ] **Step 5: Correr la suite completa**

Run: `npm test` y `npx tsc --noEmit`
Expected: verde.

- [ ] **Step 6: Commit**

```bash
git add lib/sesion.ts lib/autenticacion-cotizador.ts app/api/cotizacion tests/
git commit -m "feat(equipo): la sesion lleva el rol y entrar recibe el correo"
```

---

### Task 4: El correo de invitación y la pantalla para fijar la clave

**Files:**
- Create: `lib/cotizador/correo-invitacion.ts`
- Create: `app/api/cotizacion/fijar-clave/route.ts`
- Create: `app/cotizador/clave/page.tsx`
- Create: `app/cotizador/PantallaFijarClave.tsx`
- Test: `tests/api-fijar-clave.test.ts`

**Interfaces:**
- Consumes: `huellaDe` (T1); `hashClave` de `@/lib/cotizador/credenciales.mjs`;
  `emitirSesion(nombre, rol)` (T3).
- Produces:
  - `enviarInvitacion(p: { para: string; nombre: string; enlace: string }, deps: DepsCorreo): Promise<ResultadoCorreo>`
    — `DepsCorreo` y `ResultadoCorreo` son los que ya exporta `lib/cotizador/correo.ts`;
    importalos de ahí, no los redefinas.
  - `POST /api/cotizacion/fijar-clave` con `{ enlace, clave }` → `{ ok: true, csrf, vendedor, rol }`
    y `Set-Cookie` de sesión.

- [ ] **Step 1: Escribir las pruebas que fallan**

```ts
// tests/api-fijar-clave.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { huellaDe } from '@/lib/cotizador/invitaciones';

const CLAVE_BUENA = 'clave-larga-de-prueba';

function peticion(cuerpo: unknown) {
  return new Request('https://luxeessentialscr.com/api/cotizacion/fijar-clave', {
    method: 'POST',
    body: JSON.stringify(cuerpo),
  });
}

describe('POST /api/cotizacion/fijar-clave', () => {
  beforeEach(() => { process.env.LUXE_SESION_SECRETO = 'secreto-de-firma-de-prueba'; });

  it('fija la clave y abre la sesión de una vez', async () => {
    // fila con invitacion_hash = huellaDe('abc'), expira en el futuro
    const res = await POST(peticion({ enlace: 'abc', clave: CLAVE_BUENA }));
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.vendedor).toBe('Guillermo Rojas');
    expect(cuerpo.rol).toBe('vendedor');
    expect(res.headers.get('set-cookie')).toContain('luxe_sesion=');
  });

  // El enlace es de un solo uso: si la huella no se borrara, quien lo tuviera
  // podría volver a fijar la clave más adelante y entrar cuando quisiera.
  it('borra la invitación al usarla', async () => {
    await POST(peticion({ enlace: 'abc', clave: CLAVE_BUENA }));
    expect(escrituras[0]).toMatchObject({ invitacion_hash: null, invitacion_expira: null });
  });

  it('guarda la clave de forma que sirva para entrar después', async () => {
    await POST(peticion({ enlace: 'abc', clave: CLAVE_BUENA }));
    const { verificarClave } = await import('@/lib/cotizador/credenciales.mjs');
    expect(await verificarClave(CLAVE_BUENA, escrituras[0].clave_hash, escrituras[0].clave_sal)).toBe(true);
  });

  it('rechaza un enlace inexistente sin decir por qué', async () => {
    const res = await POST(peticion({ enlace: 'no-existe', clave: CLAVE_BUENA }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/venci|no es v[áa]lido/i);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('rechaza un enlace vencido', async () => {
    // fila con invitacion_expira en el pasado
    const res = await POST(peticion({ enlace: 'abc', clave: CLAVE_BUENA }));
    expect(res.status).toBe(400);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('exige una clave de al menos 10 caracteres', async () => {
    const res = await POST(peticion({ enlace: 'abc', clave: 'corta' }));
    expect(res.status).toBe(400);
  });

  // Busca por huella, no por enlace: el valor crudo nunca toca la consulta.
  it('consulta por la huella y no por el enlace', async () => {
    await POST(peticion({ enlace: 'abc', clave: CLAVE_BUENA }));
    expect(filtros).toContainEqual(['invitacion_hash', huellaDe('abc')]);
    expect(JSON.stringify(filtros)).not.toContain('"abc"');
  });
});
```

Montá el doble de Supabase con el mismo patrón de `tests/api-cotizacion-sesion.test.ts`,
registrando en `filtros` los pares `[columna, valor]` de cada `.eq()` y en `escrituras` los
objetos de cada `.update()`.

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run tests/api-fijar-clave.test.ts`
Expected: FAIL — no existe la ruta.

- [ ] **Step 3: Escribir la ruta**

`app/api/cotizacion/fijar-clave/route.ts`, con `runtime = 'nodejs'`:

1. Parsear `{ enlace: z.string().min(1), clave: z.string().min(10).max(200) }`. Menos de 10
   caracteres devuelve 400 con «La clave debe tener al menos 10 caracteres.»
2. Buscar la fila por `invitacion_hash = huellaDe(enlace)`.
3. Si no hay fila, si `invitacion_expira` ya pasó, o si `activo` es falso: **el mismo 400 y el
   mismo texto** — «Este enlace ya venció o no es válido. Pedile a tu administrador que te
   mande uno nuevo.» Nunca decir cuál de los tres casos fue.
4. Derivar con `hashClave(clave)` y escribir `clave_hash`, `clave_sal`, `invitacion_hash: null`,
   `invitacion_expira: null`, `intentos: 0`, `bloqueado_hasta: null`, `ultimo_acceso: ahora`.
5. Emitir la sesión con `emitirSesion(fila.nombre, fila.rol)` y devolver
   `{ ok: true, csrf, vendedor, rol }` con la cookie.
6. Un fallo de base es 500 con `console.error`, nunca 400.

- [ ] **Step 4: Escribir el correo de invitación**

`lib/cotizador/correo-invitacion.ts`. Importá `DepsCorreo` y `ResultadoCorreo` de
`lib/cotizador/correo.ts`. El HTML se arma con tablas e estilos en línea —los clientes de correo
no soportan hojas de estilo ni flexbox— usando la paleta de la marca: `#2F4156` (navy),
`#567C8D` (teal), `#F5EFEB` (beige). Un botón que apunta a
`${NEXT_PUBLIC_SITE_URL}/cotizador/clave?enlace=<enlace>`, el enlace también en texto plano por
si el botón no se puede clicar, y la advertencia de que vence en 72 horas. Asunto:
`Tu acceso al cotizador de Luxe Essentials`. Incluir siempre una versión `text` además del
`html`: sin ella el correo puntúa peor en los filtros de spam, y el dominio es nuevo.

- [ ] **Step 5: Escribir la pantalla**

`app/cotizador/clave/page.tsx` es un componente de servidor que lee `searchParams.enlace` y
renderiza `<PantallaFijarClave enlace={...} />`. `PantallaFijarClave.tsx` es de cliente: dos
campos (clave y repetir clave, con `autoComplete="new-password"`), etiquetas visibles asociadas
con `htmlFor`/`id`, comprobación de que coinciden antes de llamar al servidor, mensaje de error
con `role="alert"`, y al recibir 200 redirige a `/cotizador`. **Mismo estilo visual que
`PantallaClave.tsx`** — leelo y seguilo.

Sin enlace en la URL, la pantalla dice que el enlace está incompleto y no muestra el formulario.

- [ ] **Step 6: Correr la suite completa**

Run: `npm test` y `npx tsc --noEmit`
Expected: verde.

- [ ] **Step 7: Commit**

```bash
git add lib/cotizador/correo-invitacion.ts app/api/cotizacion/fijar-clave app/cotizador/clave app/cotizador/PantallaFijarClave.tsx tests/api-fijar-clave.test.ts
git commit -m "feat(equipo): correo de invitacion y pantalla para fijar la clave"
```

---

### Task 5: Las rutas del equipo

**Files:**
- Create: `lib/cotizador/equipo.ts`
- Create: `app/api/equipo/{listar,invitar,reenviar,estado}/route.ts`
- Test: `tests/equipo-api.test.ts`

**Interfaces:**
- Consumes: `autenticarPeticion` (T3); `generarInvitacion` (T1); `enviarInvitacion` (T4);
  `normalizarCorreo`, `Rol` (T2).
- Produces:
  - `type FilaEquipo = { id: string; correo: string; nombre: string; rol: Rol; activo: boolean; estado: 'invitada' | 'vencida' | 'activa' | 'desactivada'; ultimo_acceso: string | null }`
  - `autorizarSuperadmin(vendedor: string, db: Db): Promise<{ ok: true; id: string } | { ok: false }>`
    — **relee la fila por nombre** y comprueba `rol = 'superadmin'` y `activo`.
  - `listarEquipo(db)`, `invitarPersona(...)`, `reenviarInvitacion(...)`, `cambiarEstado(...)`

- [ ] **Step 1: Escribir las pruebas que fallan**

Las que importan de verdad, además de los caminos felices:

```ts
// La promesa central de la fase: el rol de la cookie NO autoriza.
it('rechaza a un vendedor aunque su cookie diga superadmin', async () => {
  // cookie emitida con rol 'superadmin' pero la fila en la base dice 'vendedor'
  const res = await POST(peticionConCookieFalsa());
  expect(res.status).toBe(403);
  expect(correosEnviados).toHaveLength(0);
});

it('rechaza a un superadmin desactivado en la base', async () => {
  // cookie válida con rol superadmin; la fila tiene activo: false
  expect((await POST(peticionValida())).status).toBe(403);
});

it('no deja desactivar al último superadmin activo', async () => {
  const res = await POST(peticion({ id: 'u1', activo: false }));
  expect(res.status).toBe(409);
  expect((await res.json()).error).toMatch(/último superadmin/i);
});

it('no deja degradar al último superadmin activo', async () => {
  const res = await POST(peticion({ id: 'u1', rol: 'vendedor' }));
  expect(res.status).toBe(409);
});

it('invitar guarda la huella y nunca el enlace', async () => {
  await POST(peticion({ correo: 'nuevo@luxe.cr', nombre: 'Nueva Persona', rol: 'vendedor' }));
  const fila = insertado;
  expect(fila.invitacion_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.stringify(fila)).not.toContain(enlaceDelCorreo);
});

// Si el correo no sale, la fila igual queda creada: la respuesta tiene que
// decirlo, o el superadmin cree que invitó a alguien que nunca se enteró.
it('avisa cuando la fila se creó pero el correo falló', async () => {
  resendFalla = true;
  const res = await POST(peticion({ correo: 'nuevo@luxe.cr', nombre: 'X', rol: 'vendedor' }));
  expect(res.status).toBe(200);
  expect((await res.json()).correoEnviado).toBe(false);
});

it('rechaza invitar a un correo que ya está', async () => {
  // el insert devuelve el error 23505 de Postgres
  expect((await POST(peticion({ correo: 'existe@luxe.cr', nombre: 'X', rol: 'vendedor' }))).status).toBe(409);
});

it('exige el token anti-CSRF en las cuatro rutas que escriben', async () => {
  for (const ruta of [invitar, reenviar, estado]) {
    expect((await ruta(peticionSinCsrf())).status).toBe(401);
  }
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run tests/equipo-api.test.ts`
Expected: FAIL — no existen las rutas.

- [ ] **Step 3: Escribir `lib/cotizador/equipo.ts`**

`autorizarSuperadmin` es la pieza central. Lleva un comentario explicando por qué relee la base:
el rol de la cookie vale 30 días, así que un superadmin degradado o desactivado conservaría el
poder de invitar y desactivar durante un mes si se confiara en ella.

`estado` se deriva y no se guarda: sin `clave_hash` y con `invitacion_expira` en el futuro es
`'invitada'`; sin `clave_hash` y vencida es `'vencida'`; con `clave_hash` y `activo` es
`'activa'`; sin `activo` es `'desactivada'`.

`cambiarEstado` comprueba, antes de escribir, si la operación dejaría cero superadmins activos,
contando en la base. Devuelve un resultado distinguible para que la ruta responda 409.

- [ ] **Step 4: Escribir las cuatro rutas**

Todas con `runtime = 'nodejs'`. Todas llaman `autenticarPeticion(request, crudo, { requiereCsrf: true })`
—`listar` con `false`— y **después** `autorizarSuperadmin`. Un no-superadmin recibe 403 con
«No tenés permiso para administrar el equipo.»

`invitar` recibe `{ correo, nombre, rol }`, normaliza el correo, genera la invitación, inserta la
fila, manda el correo, y devuelve `{ ok: true, correoEnviado: boolean }`. Si el insert falla con
`23505`, responde 409 con «Ese correo ya está en el equipo.»

`reenviar` genera una invitación nueva —enlace nuevo, reloj nuevo— y la manda. Sólo sobre filas
sin `clave_hash`: reenviar a alguien que ya entró no tiene sentido y borraría su acceso.

- [ ] **Step 5: Correr la suite completa**

Run: `npm test` y `npx tsc --noEmit`
Expected: verde.

- [ ] **Step 6: Commit**

```bash
git add lib/cotizador/equipo.ts app/api/equipo tests/equipo-api.test.ts
git commit -m "feat(equipo): rutas de equipo que releen la base para autorizar"
```

---

### Task 6: La pestaña de equipo

**Files:**
- Create: `app/cotizador/VistaEquipo.tsx`
- Modify: `app/cotizador/Panel.tsx`
- Modify: `app/cotizador/PantallaClave.tsx`
- Test: `tests/equipo-ui.test.tsx`, `tests/cotizador-ui.test.tsx` (existente)

**Interfaces:**
- Consumes: las cuatro rutas de la Tarea 5; `rol` de `/entrar` y `/catalogo` (T3).
- Produces: `Pestana` suma `'equipo'`.

- [ ] **Step 1: Escribir las pruebas que fallan**

```tsx
it('no muestra la pestaña de equipo a un vendedor', async () => {
  // sonda de sesión devuelve rol 'vendedor'
  expect(screen.queryByRole('button', { name: /equipo/i })).not.toBeInTheDocument();
});

it('la muestra a un superadmin', async () => {
  expect(await screen.findByRole('button', { name: /equipo/i })).toBeInTheDocument();
});

it('lista al equipo con su estado', async () => {
  expect(await screen.findByText('guillermo@luxe.cr')).toBeInTheDocument();
  expect(await screen.findByText(/invitada/i)).toBeInTheDocument();
});

it('invita a alguien y manda correo, nombre y rol', async () => {
  await userEvent.type(screen.getByLabelText(/correo/i), 'nuevo@luxe.cr');
  await userEvent.type(screen.getByLabelText(/nombre/i), 'Nueva Persona');
  await userEvent.click(screen.getByLabelText(/superadmin/i));
  await userEvent.click(screen.getByRole('button', { name: /enviar invitaci/i }));
  expect(JSON.parse(fetchMock.mock.calls.at(-1)[1].body)).toMatchObject({
    correo: 'nuevo@luxe.cr', nombre: 'Nueva Persona', rol: 'superadmin',
  });
});

// El correo que no sale es el modo de fallo más probable de esta pantalla.
it('avisa cuando la persona quedó creada pero el correo no salió', async () => {
  // la ruta responde { ok: true, correoEnviado: false }
  expect(await screen.findByText(/no se pudo enviar/i)).toBeInTheDocument();
});

it('manda el token anti-CSRF al invitar', async () => {
  expect(fetchMock.mock.calls.at(-1)[1].headers['x-csrf-token']).toBe('tok');
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run tests/equipo-ui.test.tsx`
Expected: FAIL — no existe la vista.

- [ ] **Step 3: Escribir `VistaEquipo.tsx`**

Una tabla con correo, nombre, rol, estado y último acceso; por fila, «Reenviar invitación»
(sólo si el estado es `invitada` o `vencida`) y «Desactivar»/«Activar». Arriba, un formulario de
invitación con correo, nombre y una casilla «Es superadmin» — con una línea que diga qué
significa: que puede invitar y desactivar a otros.

El estado se muestra con una pastilla de color, siguiendo lo que ya hace `VistaListado.tsx` para
los estados de cotización: leelo y seguí ese patrón, no inventes otro.

Mensaje visible y distinto cuando `correoEnviado` es `false`: la persona quedó creada, pero hay
que reenviarle la invitación.

- [ ] **Step 4: Enchufarla en el Panel**

`Panel.tsx`: guardar el `rol` que devuelven `/entrar` y `/catalogo`, sumar `'equipo'` al tipo
`Pestana`, y **dibujar la pestaña sólo si el rol es `'superadmin'`**. Añadir un comentario
diciendo que esto es cosmético: quien manipule su estado de React no gana nada, porque las
rutas releen la base.

`PantallaClave.tsx`: la etiqueta y el marcador de posición del primer campo pasan de «Usuario» a
«Correo», y el `type` del campo pasa a `email`. El `autoComplete="username"` **se conserva**: es
el valor correcto para un correo que actúa como identidad.

- [ ] **Step 5: Correr la suite completa**

Run: `npm test` y `npx tsc --noEmit`
Expected: verde.

- [ ] **Step 6: Commit**

```bash
git add app/cotizador tests/
git commit -m "feat(equipo): pestana de equipo visible solo para superadmin"
```

---

### Task 7: La consola habla de correos e invita

**Files:**
- Modify: `scripts/usuarios.mjs`
- Test: `tests/usuarios-script.test.ts` (existente)

**Interfaces:**
- Consumes: `generarInvitacion` de `lib/cotizador/invitaciones.ts` — **ojo**: ese módulo es `.ts`
  y un `.mjs` no puede importarlo. Duplicá las tres líneas de `generarInvitacion` en el script
  **y escribí una prueba que compruebe que las dos implementaciones producen huellas
  compatibles** (`huellaDe` del módulo sobre un enlace del script). Es el mismo problema que
  resolvió `credenciales.mjs`, pero acá no vale la pena mover un módulo entero por tres líneas;
  la prueba cruzada es lo que impide que diverjan.

- [ ] **Step 1: Escribir las pruebas que fallan**

```ts
it('invitar guarda la huella y nunca el enlace', async () => {
  const { texto, valores, enlace } = await construirSql('invitar', ['g@luxe.cr', 'Guillermo Rojas']);
  expect(texto).toContain('insert into public.usuarios_panel');
  expect(valores).toContain('g@luxe.cr');
  expect(valores).not.toContain(enlace);
  expect(valores).toContain(huellaDe(enlace));
});

it('acepta el rol de superadmin', async () => {
  const { valores } = await construirSql('invitar', ['g@luxe.cr', 'Guillermo Rojas', '--superadmin']);
  expect(valores).toContain('superadmin');
});

it('por defecto invita como vendedor', async () => {
  const { valores } = await construirSql('invitar', ['g@luxe.cr', 'Guillermo Rojas']);
  expect(valores).toContain('vendedor');
});

it('las órdenes buscan por correo, no por usuario', async () => {
  for (const orden of ['desactivar', 'activar', 'desbloquear']) {
    const { texto } = await construirSql(orden, ['g@luxe.cr']);
    expect(texto).toContain('correo = $1');
    expect(texto).not.toContain('usuario');
  }
});

it('listar muestra el rol y no filtra el hash', async () => {
  const { texto } = await construirSql('listar', []);
  expect(texto).toContain('rol');
  expect(texto).not.toContain('clave_hash');
  expect(texto).not.toContain('invitacion_hash');
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run tests/usuarios-script.test.ts`
Expected: FAIL.

- [ ] **Step 3: Modificar el script**

- `alta` pasa a `invitar <correo> "<nombre>" [--superadmin] [--sin-correo]`. Crea la fila con
  la huella y, salvo `--sin-correo`, manda la invitación por Resend y lo dice en la consola.
- `clave`, `desactivar`, `activar`, `desbloquear` y `listar` pasan a hablar de `correo`.
- `listar` muestra el rol y el estado derivado (invitada / vencida / activa / desactivada).
- El mensaje del error `23505` pasa a «Ese correo ya está en el equipo.»
- **Conservá todo lo que ya está probado:** parámetros `$1..$n` siempre (nunca interpolación),
  `desactivar`/`activar` con `update` y nunca `delete`, `clave` limpiando bloqueo e intentos, el
  guard de `process.argv[1]`, y la clave pedida por `stdin`.

- [ ] **Step 4: Correr la suite completa**

Run: `npm test` y `npx tsc --noEmit`
Expected: verde.

- [ ] **Step 5: Commit**

```bash
git add scripts/usuarios.mjs tests/usuarios-script.test.ts
git commit -m "feat(equipo): la consola invita por correo y maneja roles"
```

---

### Task 8: Documentación y arranque del equipo

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-31-invitaciones-roles-design.md`

- [ ] **Step 1: Actualizar el README**

La sección del panel cambia: ya no se «da de alta» con una clave elegida por el administrador,
se **invita**. Reescribir el orden de puesta en marcha:

```bash
npm run db:migrate
npm run usuarios -- invitar aguilartradesfx@gmail.com "Alejandro Aguilar" --superadmin
npm run usuarios -- invitar infocr.luxe@gmail.com "Luxe Essentials" --superadmin --sin-correo
npm run usuarios -- listar
```

Y explicar, en prosa breve: que a partir del primer superadmin todo lo demás se hace desde la
pestaña Equipo del panel; que la invitación vence a las 72 horas y se reenvía desde ahí; que el
dominio de envío es nuevo y los primeros correos pueden caer en spam; y que quien fija su clave
desde el enlace queda dentro en **esa pestaña**, pero la primera vez que abra el panel dentro de
GoHighLevel va a escribir su clave una vez, porque el navegador guarda las cookies del iframe en
un compartimento aparte.

Conservar el paso de verificación del bloqueo por intentos que ya está.

- [ ] **Step 2: Cerrar el diseño**

En el documento de diseño, marcar como implementadas las decisiones y anotar la limitación del
iframe donde ya está descrita, si el texto quedó desactualizado respecto de lo construido.

- [ ] **Step 3: Correr la suite y el build**

Run: `npm test` y `npm run build`
Expected: verde y compila.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/superpowers/specs/2026-08-31-invitaciones-roles-design.md
git commit -m "docs(equipo): invitaciones, roles y la limitacion del iframe"
```

---

## Verificación final

- [ ] `npm test` verde, `npx tsc --noEmit` limpio, `npm run build` correcto.
- [ ] `npm run db:migrate` aplicó la `0014`.
- [ ] Invitar a `aguilartradesfx@gmail.com` como superadmin **y que el correo llegue de verdad**.
- [ ] Abrir el enlace, fijar la clave, y confirmar que queda dentro sin volver a escribirla.
- [ ] Desde la pestaña Equipo, invitar a un segundo correo de prueba y confirmar que llega.
- [ ] Confirmar que una cuenta de vendedor **no ve** la pestaña Equipo.
- [ ] Confirmar que `/q7m4` sigue entrando con `LUXE_TALLER_CLAVE`, intacto.
