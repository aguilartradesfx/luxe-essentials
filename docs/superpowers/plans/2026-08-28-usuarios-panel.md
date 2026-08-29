# Usuarios del panel — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sustituir la clave compartida del panel de cotizaciones por una credencial
por persona, guardada cifrada en una tabla, con límite de intentos, administrada por
consola, y que firme cada cotización con el nombre de quien la hizo.

**Architecture:** Una tabla `usuarios_panel` guarda usuario, nombre, hash `scrypt` y sal.
`/api/cotizacion/entrar` cambia usuario+clave por la cookie de sesión que ya existe, ahora
con el nombre del vendedor dentro del valor firmado. `autenticarPeticion` deja de aceptar la
clave compartida en el cuerpo y devuelve el vendedor, que la ruta de creación estampa en la
fila. Un script de Node administra las altas y bajas.

**Tech Stack:** Next.js 16 (App Router), TypeScript, `node:crypto` (`scrypt`, `timingSafeEqual`,
`createHmac`), Supabase (Postgres), `pg` para el script, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-28-usuarios-panel-design.md`

## Global Constraints

- **Nada de dependencias nuevas.** El hash usa `node:crypto`. `pg` y `dotenv` ya son
  devDependencies y sólo los usa `scripts/`.
- **Parámetros de `scrypt`, exactos y en un solo lugar:** `N=16384, r=8, p=1, keylen=64`,
  sal de 16 bytes. Hash y sal se guardan en hexadecimal.
- **Una sola implementación del hash.** Vive en `lib/cotizador/credenciales.mjs` (JavaScript
  plano, ESM) porque la importan tanto el código TypeScript del servidor como
  `scripts/usuarios.mjs`, y un `.mjs` no puede importar un `.ts`. Duplicarla haría que un
  usuario creado por el script no pudiera entrar por el panel. `tsconfig.json` ya tiene
  `allowJs: true` y el alias `@/*` a la raíz.
- **`LUXE_TALLER_CLAVE` no cambia de papel.** Sigue siendo el secreto con el que se firma la
  cookie (`lib/sesion.ts`) y la clave de `/q7m4`. Deja de ser una credencial de entrada al
  panel. **No se toca `app/api/q7m4/route.ts`.**
- **Comparaciones en tiempo constante** con `timingSafeEqual`, igual que el resto del
  repositorio. Longitudes distintas se cortan antes de llamarlo.
- **Todo el texto de cara al usuario va en español de Costa Rica**, sin tuteo español
  peninsular. Los mensajes de error del panel no revelan si el usuario existe.
- **El PDF no menciona métodos de pago.** Restricción del cliente, vigente desde la fase 1.
- **Pruebas:** `npm test` (Vitest). La suite está en 681 pruebas y debe quedar verde al final
  de cada tarea. Los archivos que rendericen un PDF llevan `// @vitest-environment node`.

---

## Estructura de archivos

**Nuevos:**
- `supabase/migrations/0012_usuarios_panel.sql` — la tabla y la columna `vendedor`.
- `lib/cotizador/credenciales.mjs` — `scrypt`: derivar y verificar. Sin base de datos.
- `lib/cotizador/usuarios.ts` — autenticación contra la tabla: intentos, bloqueo, activo.
- `scripts/usuarios.mjs` — alta, baja, alta de nuevo, listar, desbloquear, cambiar clave.
- `tests/usuarios-credenciales.test.ts`, `tests/usuarios-autenticacion.test.ts`,
  `tests/usuarios-script.test.ts`, `tests/panel-vendedor-ui.test.tsx`.

**Modificados:**
- `lib/sesion.ts` — la cookie lleva el nombre del vendedor.
- `lib/autenticacion-cotizador.ts` — se retira la clave compartida; devuelve el vendedor.
- `app/api/cotizacion/entrar/route.ts` — autentica contra la tabla.
- `app/api/cotizacion/route.ts` — estampa el vendedor en el insert.
- `app/api/cotizacion/listado/route.ts` — `vendedor` entre las columnas.
- `app/cotizador/PantallaClave.tsx` — dos campos.
- `app/cotizador/Panel.tsx`, `VistaCrear.tsx`, `VistaListado.tsx`, `VistaMetricas.tsx` — se
  retira el hilo de `clave`.
- `lib/cotizador/documento.tsx` — el horario en el pie.
- `.env.example`, `package.json`.

---

### Task 1: La tabla y el módulo de credenciales

**Files:**
- Create: `supabase/migrations/0012_usuarios_panel.sql`
- Create: `lib/cotizador/credenciales.mjs`
- Test: `tests/usuarios-credenciales.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `hashClave(clave: string): Promise<{ hash: string; sal: string }>` — sal nueva de 16
    bytes; ambos en hexadecimal.
  - `verificarClave(clave: string, hash: string, sal: string): Promise<boolean>` — tiempo
    constante; `false` ante un hash o sal mal formados en vez de lanzar.
  - Tabla `public.usuarios_panel` y columna `public.cotizaciones.vendedor`.

- [ ] **Step 1: Escribir la prueba que falla**

Crear `tests/usuarios-credenciales.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { hashClave, verificarClave } from '@/lib/cotizador/credenciales.mjs';

describe('credenciales', () => {
  it('acepta la clave correcta', async () => {
    const { hash, sal } = await hashClave('Turrialba-2026');
    expect(await verificarClave('Turrialba-2026', hash, sal)).toBe(true);
  });

  it('rechaza una clave distinta', async () => {
    const { hash, sal } = await hashClave('Turrialba-2026');
    expect(await verificarClave('turrialba-2026', hash, sal)).toBe(false);
  });

  // Sin sal por usuario, dos vendedores con la misma clave tendrían el mismo
  // hash: quien viera la tabla sabría que coinciden, y una tabla precalculada
  // serviría para todos a la vez.
  it('produce hashes distintos para la misma clave', async () => {
    const a = await hashClave('Turrialba-2026');
    const b = await hashClave('Turrialba-2026');
    expect(a.sal).not.toBe(b.sal);
    expect(a.hash).not.toBe(b.hash);
  });

  it('devuelve hash y sal en hexadecimal, con los tamaños esperados', async () => {
    const { hash, sal } = await hashClave('Turrialba-2026');
    expect(sal).toMatch(/^[0-9a-f]{32}$/);   // 16 bytes
    expect(hash).toMatch(/^[0-9a-f]{128}$/); // 64 bytes
  });

  // Una fila corrupta o truncada no puede tumbar el endpoint de entrada: eso
  // convertiría un dato malo en una caída, no en un rechazo.
  it('devuelve false ante hash o sal mal formados, sin lanzar', async () => {
    expect(await verificarClave('x', 'no-es-hex', 'tampoco')).toBe(false);
    expect(await verificarClave('x', '', '')).toBe(false);
    expect(await verificarClave('x', 'ab', 'cd')).toBe(false);
  });

  // Una clave vacía guardada por error dejaría una puerta abierta.
  it('no permite derivar un hash de una clave vacía', async () => {
    await expect(hashClave('')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Correr la prueba y verificar que falla**

Run: `npx vitest run tests/usuarios-credenciales.test.ts`
Expected: FAIL — no se resuelve `@/lib/cotizador/credenciales.mjs`.

- [ ] **Step 3: Escribir `lib/cotizador/credenciales.mjs`**

```js
// JavaScript plano, no TypeScript, y a propósito: este módulo lo importan dos
// mundos —el servidor de Next.js (TypeScript) y `scripts/usuarios.mjs` (Node
// suelto)— y un `.mjs` no puede importar un `.ts`. Tener dos implementaciones
// del hash sería peor que este archivo raro: un usuario creado por el script no
// podría entrar por el panel, y el síntoma sería "la clave no me sirve" sin
// ninguna pista de por qué. `tsconfig.json` tiene `allowJs`, así que los tipos
// de JSDoc de abajo son los que ve el código TypeScript.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derivar = promisify(scrypt);

// Parámetros fijos. `N=16384` es el estándar de referencia de scrypt: unos 100
// ms y 16 MB por derivación en hardware corriente. Es deliberadamente lento —
// es lo único que hace cara una fuerza bruta contra la tabla si alguien se la
// lleva. Por eso el hash se calcula UNA vez, al entrar, y no en cada petición:
// la sesión por cookie es lo que evita repetirlo.
const N = 16384;
const R = 8;
const P = 1;
const LARGO_CLAVE = 64;
const LARGO_SAL = 16;

/**
 * @param {string} clave
 * @param {string} sal hexadecimal
 * @returns {Promise<Buffer>}
 */
function derivarCon(clave, sal) {
  return /** @type {Promise<Buffer>} */ (
    derivar(clave, Buffer.from(sal, 'hex'), LARGO_CLAVE, { N, r: R, p: P })
  );
}

/**
 * Deriva el hash de una clave con una sal nueva.
 * @param {string} clave
 * @returns {Promise<{ hash: string, sal: string }>}
 */
export async function hashClave(clave) {
  // Una clave vacía guardada en la tabla es una cuenta sin clave. Se corta acá
  // y no en el script, para que ninguna vía de alta futura pueda saltárselo.
  if (typeof clave !== 'string' || clave.length === 0) {
    throw new Error('La clave no puede estar vacía.');
  }
  const sal = randomBytes(LARGO_SAL).toString('hex');
  const hash = await derivarCon(clave, sal);
  return { hash: hash.toString('hex'), sal };
}

/**
 * Verifica una clave contra el hash y la sal guardados.
 * @param {string} clave
 * @param {string} hash hexadecimal
 * @param {string} sal hexadecimal
 * @returns {Promise<boolean>}
 */
export async function verificarClave(clave, hash, sal) {
  if (typeof clave !== 'string' || typeof hash !== 'string' || typeof sal !== 'string') {
    return false;
  }
  // Una fila corrupta o a medio escribir tiene que dar "no coincide", no una
  // excepción: si no, un dato malo en una fila tumba el endpoint de entrada
  // para el usuario que lo tenga.
  if (!/^[0-9a-f]+$/.test(hash) || !/^[0-9a-f]+$/.test(sal)) return false;
  if (hash.length !== LARGO_CLAVE * 2 || sal.length !== LARGO_SAL * 2) return false;

  try {
    const calculado = await derivarCon(clave, sal);
    const guardado = Buffer.from(hash, 'hex');
    // Mismo tamaño garantizado por el chequeo de largo de arriba, pero
    // `timingSafeEqual` lanza si no coinciden, así que se comprueba igual.
    return calculado.length === guardado.length && timingSafeEqual(calculado, guardado);
  } catch {
    return false;
  }
}

/**
 * Deriva contra una sal descartable. Existe para que autenticar a un usuario
 * inexistente cueste el mismo tiempo que autenticar a uno real: sin esto, la
 * diferencia entre responder al instante y responder en 100 ms le dice a quien
 * pruebe nombres cuáles existen.
 * @returns {Promise<void>}
 */
export async function gastarTiempoDeHash() {
  await derivarCon('credencial-inexistente', randomBytes(LARGO_SAL).toString('hex'));
}
```

- [ ] **Step 4: Correr la prueba y verificar que pasa**

Run: `npx vitest run tests/usuarios-credenciales.test.ts`
Expected: PASS (6 pruebas).

- [ ] **Step 5: Escribir la migración**

Crear `supabase/migrations/0012_usuarios_panel.sql`:

```sql
-- supabase/migrations/0012_usuarios_panel.sql
-- Hasta acá el panel se entraba con una sola clave compartida: las cotizaciones
-- no tenían autor y no se le podía quitar el acceso a una persona sin sacar al
-- equipo entero. Esta tabla es lo que convierte "el equipo" en personas.

create table if not exists public.usuarios_panel (
  id              uuid primary key default gen_random_uuid(),
  -- Con lo que entra. En minúsculas y sin espacios: lo normaliza la aplicación
  -- antes de escribir, y el índice único de abajo lo hace valer aunque alguien
  -- inserte a mano.
  usuario         text not null,
  -- Lo que firma las cotizaciones y ve el equipo en el listado.
  nombre          text not null,
  clave_hash      text not null,
  clave_sal       text not null,
  -- Se desactiva, no se borra: una cotización firmada por alguien que ya no
  -- está tiene que seguir diciendo quién la hizo.
  activo          boolean not null default true,
  -- Fallos consecutivos. Vuelve a cero con cada entrada correcta.
  intentos        integer not null default 0,
  bloqueado_hasta timestamptz,
  creado_at       timestamptz not null default now(),
  ultimo_acceso   timestamptz
);

-- Único e insensible a mayúsculas: "Guillermo" y "guillermo" no pueden ser dos
-- cuentas distintas. La aplicación ya normaliza, esto es el cinturón.
create unique index if not exists usuarios_panel_usuario_idx
  on public.usuarios_panel (lower(usuario));

-- Misma postura que el resto del esquema: nadie llega acá con la llave anónima.
-- Sólo el cliente de servicio del servidor, y el script de administración por
-- conexión directa.
alter table public.usuarios_panel enable row level security;

-- El nombre de quien armó la cotización. Se guarda el NOMBRE y no el id del
-- usuario: dentro de un año esta fila tiene que seguir diciendo quién la hizo
-- aunque esa persona se haya dado de baja — el mismo criterio por el que
-- `lineas` guarda los precios de ese día y no una referencia al catálogo.
alter table public.cotizaciones
  add column if not exists vendedor text;
```

- [ ] **Step 6: Verificar que la migración corre**

Run: `npm run db:migrate`
Expected: `✓ 0012_usuarios_panel.sql`, y las once anteriores como `(ya aplicada)`.

Si faltan credenciales de base de datos en el entorno, **no inventar ninguna**: dejarlo
anotado en el reporte como paso pendiente y seguir — el resto de la tarea no depende de
que la migración esté aplicada.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0012_usuarios_panel.sql lib/cotizador/credenciales.mjs tests/usuarios-credenciales.test.ts
git commit -m "feat(usuarios): tabla de usuarios del panel y hash scrypt"
```

---

### Task 2: Autenticar contra la tabla, con límite de intentos

**Files:**
- Create: `lib/cotizador/usuarios.ts`
- Test: `tests/usuarios-autenticacion.test.ts`

**Interfaces:**
- Consumes: `hashClave`, `verificarClave`, `gastarTiempoDeHash` de
  `@/lib/cotizador/credenciales.mjs`.
- Produces:
  - `type ResultadoEntrada = { ok: true; nombre: string } | { ok: false; motivo: 'credenciales' | 'bloqueado' }`
  - `autenticarUsuario(usuario: string, clave: string, db: Db, ahora?: Date): Promise<ResultadoEntrada>`
  - `type Db = { from: (tabla: string) => any }` — el mismo tipo inyectable de
    `lib/agente/estado.ts`, para poder probar sin base de datos.
  - `MAX_INTENTOS = 5`, `BLOQUEO_MINUTOS = 15` (exportadas, las usan las pruebas y el script).

- [ ] **Step 1: Escribir la prueba que falla**

Crear `tests/usuarios-autenticacion.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { hashClave } from '@/lib/cotizador/credenciales.mjs';
import { autenticarUsuario, MAX_INTENTOS } from '@/lib/cotizador/usuarios';

// Doble de la parte de PostgREST que usa `autenticarUsuario`: una lectura por
// `lower(usuario)` y una escritura por id. Guarda lo escrito para poder
// afirmar sobre ello — que es donde viven los intentos y el bloqueo.
function db(fila: Record<string, unknown> | null) {
  const escrituras: Record<string, unknown>[] = [];
  const cliente = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle: async () => ({ data: fila, error: null }),
        update(cambios: Record<string, unknown>) {
          escrituras.push(cambios);
          return { eq: async () => ({ error: null }) };
        },
      };
    },
  };
  return { cliente: cliente as any, escrituras };
}

async function filaDe(clave: string, extra: Record<string, unknown> = {}) {
  const { hash, sal } = await hashClave(clave);
  return {
    id: 'u1', usuario: 'guillermo', nombre: 'Guillermo Rojas',
    clave_hash: hash, clave_sal: sal,
    activo: true, intentos: 0, bloqueado_hasta: null,
    ...extra,
  };
}

describe('autenticarUsuario', () => {
  it('devuelve el nombre con la clave correcta', async () => {
    const { cliente } = db(await filaDe('Turrialba-2026'));
    const r = await autenticarUsuario('guillermo', 'Turrialba-2026', cliente);
    expect(r).toEqual({ ok: true, nombre: 'Guillermo Rojas' });
  });

  it('normaliza el usuario: mayúsculas y espacios no impiden entrar', async () => {
    const { cliente } = db(await filaDe('Turrialba-2026'));
    const r = await autenticarUsuario('  GUILLERMO ', 'Turrialba-2026', cliente);
    expect(r.ok).toBe(true);
  });

  it('rechaza la clave incorrecta', async () => {
    const { cliente } = db(await filaDe('Turrialba-2026'));
    const r = await autenticarUsuario('guillermo', 'otra', cliente);
    expect(r).toEqual({ ok: false, motivo: 'credenciales' });
  });

  it('rechaza a un usuario que no existe, con el mismo motivo', async () => {
    const { cliente } = db(null);
    const r = await autenticarUsuario('nadie', 'x', cliente);
    expect(r).toEqual({ ok: false, motivo: 'credenciales' });
  });

  it('rechaza a un usuario desactivado aunque la clave sea correcta', async () => {
    const { cliente } = db(await filaDe('Turrialba-2026', { activo: false }));
    const r = await autenticarUsuario('guillermo', 'Turrialba-2026', cliente);
    expect(r).toEqual({ ok: false, motivo: 'credenciales' });
  });

  it('cuenta el intento fallido', async () => {
    const { cliente, escrituras } = db(await filaDe('Turrialba-2026', { intentos: 2 }));
    await autenticarUsuario('guillermo', 'otra', cliente);
    expect(escrituras[0].intentos).toBe(3);
  });

  it('bloquea al llegar al máximo de intentos', async () => {
    const ahora = new Date('2026-08-28T10:00:00Z');
    const { cliente, escrituras } = db(
      await filaDe('Turrialba-2026', { intentos: MAX_INTENTOS - 1 }),
    );
    const r = await autenticarUsuario('guillermo', 'otra', cliente, ahora);
    expect(r).toEqual({ ok: false, motivo: 'bloqueado' });
    expect(escrituras[0].bloqueado_hasta).toBe('2026-08-28T10:15:00.000Z');
    // El contador vuelve a cero al bloquear: si no, el siguiente fallo tras
    // vencer el bloqueo volvería a bloquear de inmediato y la cuenta quedaría
    // atrapada en un ciclo del que sólo se sale por consola.
    expect(escrituras[0].intentos).toBe(0);
  });

  it('rechaza mientras el bloqueo sigue vigente, aun con la clave correcta', async () => {
    const ahora = new Date('2026-08-28T10:00:00Z');
    const fila = await filaDe('Turrialba-2026', {
      bloqueado_hasta: '2026-08-28T10:10:00.000Z',
    });
    const { cliente } = db(fila);
    const r = await autenticarUsuario('guillermo', 'Turrialba-2026', cliente, ahora);
    expect(r).toEqual({ ok: false, motivo: 'bloqueado' });
  });

  it('deja entrar cuando el bloqueo ya venció', async () => {
    const ahora = new Date('2026-08-28T10:20:00Z');
    const fila = await filaDe('Turrialba-2026', {
      bloqueado_hasta: '2026-08-28T10:10:00.000Z',
    });
    const { cliente } = db(fila);
    const r = await autenticarUsuario('guillermo', 'Turrialba-2026', cliente, ahora);
    expect(r.ok).toBe(true);
  });

  it('al entrar bien, reinicia los intentos y levanta el bloqueo', async () => {
    const ahora = new Date('2026-08-28T10:00:00Z');
    const { cliente, escrituras } = db(await filaDe('Turrialba-2026', { intentos: 3 }));
    await autenticarUsuario('guillermo', 'Turrialba-2026', cliente, ahora);
    expect(escrituras[0]).toMatchObject({
      intentos: 0,
      bloqueado_hasta: null,
      ultimo_acceso: '2026-08-28T10:00:00.000Z',
    });
  });

  // Un fallo de lectura no puede confundirse con "credenciales malas": eso
  // dejaría al equipo afuera con un mensaje que culpa a su clave, y el problema
  // real (la base caída) no aparecería en ningún lado.
  it('lanza si la lectura de la base falla', async () => {
    const cliente = {
      from: () => ({
        select() { return this; },
        eq() { return this; },
        maybeSingle: async () => ({ data: null, error: { message: 'conexión caída' } }),
      }),
    } as any;
    await expect(autenticarUsuario('guillermo', 'x', cliente)).rejects.toThrow(/conexión caída/);
  });
});
```

- [ ] **Step 2: Correr la prueba y verificar que falla**

Run: `npx vitest run tests/usuarios-autenticacion.test.ts`
Expected: FAIL — no existe `lib/cotizador/usuarios.ts`.

- [ ] **Step 3: Escribir `lib/cotizador/usuarios.ts`**

```ts
import 'server-only';
import { verificarClave, gastarTiempoDeHash } from '@/lib/cotizador/credenciales.mjs';

// Mismo tipo inyectable que `lib/agente/estado.ts`: permite probar la lógica de
// intentos y bloqueo sin una base de datos.
export type Db = { from: (tabla: string) => any };

const TABLA = 'usuarios_panel';

// Cinco fallos seguidos y quince minutos. Es lo que hace que una tabla de
// credenciales sea mejor que una clave compartida y no sólo distinta: sin
// contador, probar claves contra este endpoint sale gratis. Quince minutos
// frena una fuerza bruta sin dejar a un vendedor fuera media mañana por
// escribir mal la clave cinco veces.
export const MAX_INTENTOS = 5;
export const BLOQUEO_MINUTOS = 15;

export type ResultadoEntrada =
  | { ok: true; nombre: string }
  | { ok: false; motivo: 'credenciales' | 'bloqueado' };

type FilaUsuario = {
  id: string;
  usuario: string;
  nombre: string;
  clave_hash: string;
  clave_sal: string;
  activo: boolean;
  intentos: number;
  bloqueado_hasta: string | null;
};

export function normalizarUsuario(usuario: string): string {
  return usuario.trim().toLowerCase();
}

export async function autenticarUsuario(
  usuario: string,
  clave: string,
  db: Db,
  ahora: Date = new Date(),
): Promise<ResultadoEntrada> {
  const nombreUsuario = normalizarUsuario(usuario);

  const { data, error } = await db
    .from(TABLA)
    .select('id, usuario, nombre, clave_hash, clave_sal, activo, intentos, bloqueado_hasta')
    .eq('usuario', nombreUsuario)
    .maybeSingle();

  // Un fallo de lectura NO es "credenciales incorrectas". Devolverlo como tal
  // dejaría al equipo entero afuera con un mensaje que culpa a su clave,
  // mientras la causa real —la base caída— no aparece en ningún lado. Se lanza
  // para que la ruta lo convierta en un 500 visible.
  if (error) {
    throw new Error(`[cotizador] No se pudo leer el usuario del panel: ${error.message}`);
  }

  const fila = data as FilaUsuario | null;

  // Usuario inexistente o desactivado: se gasta el mismo tiempo que costaría
  // verificar una clave real. Sin esto, responder al instante frente a
  // responder en ~100 ms le dice a quien pruebe nombres cuáles existen. Y se
  // devuelve el mismo motivo que una clave mala, para no decirlo tampoco por
  // el mensaje.
  if (!fila || !fila.activo) {
    await gastarTiempoDeHash();
    return { ok: false, motivo: 'credenciales' };
  }

  if (fila.bloqueado_hasta) {
    const hasta = new Date(fila.bloqueado_hasta);
    // Una fecha ilegible se ignora en vez de bloquear para siempre: un dato
    // corrupto no debe dejar una cuenta inaccesible salvo por consola.
    if (Number.isFinite(hasta.getTime()) && hasta > ahora) {
      await gastarTiempoDeHash();
      return { ok: false, motivo: 'bloqueado' };
    }
  }

  const coincide = await verificarClave(clave, fila.clave_hash, fila.clave_sal);

  if (!coincide) {
    const intentos = fila.intentos + 1;
    if (intentos >= MAX_INTENTOS) {
      const hasta = new Date(ahora.getTime() + BLOQUEO_MINUTOS * 60 * 1000);
      // El contador vuelve a cero junto con el bloqueo: si se dejara en el
      // máximo, el primer fallo después de vencer el bloqueo volvería a
      // bloquear de inmediato y la cuenta quedaría en un ciclo del que sólo se
      // sale por consola.
      await escribir(db, fila.id, { intentos: 0, bloqueado_hasta: hasta.toISOString() });
      return { ok: false, motivo: 'bloqueado' };
    }
    await escribir(db, fila.id, { intentos });
    return { ok: false, motivo: 'credenciales' };
  }

  await escribir(db, fila.id, {
    intentos: 0,
    bloqueado_hasta: null,
    ultimo_acceso: ahora.toISOString(),
  });
  return { ok: true, nombre: fila.nombre };
}

// No lanza: si falla el registro del intento o del último acceso, la decisión
// de dejar entrar (o no) ya está tomada y es correcta. Hacer fallar la entrada
// por no poder anotar la contabilidad sería peor que perder la anotación.
async function escribir(db: Db, id: string, cambios: Record<string, unknown>): Promise<void> {
  const { error } = await db.from(TABLA).update(cambios).eq('id', id);
  if (error) {
    console.error('[cotizador] No se pudo actualizar el usuario del panel.', id, error.message);
  }
}
```

- [ ] **Step 4: Correr la prueba y verificar que pasa**

Run: `npx vitest run tests/usuarios-autenticacion.test.ts`
Expected: PASS (12 pruebas).

- [ ] **Step 5: Commit**

```bash
git add lib/cotizador/usuarios.ts tests/usuarios-autenticacion.test.ts
git commit -m "feat(usuarios): autenticacion contra la tabla con limite de intentos"
```

---

### Task 3: La sesión lleva el nombre del vendedor

**Files:**
- Modify: `lib/sesion.ts`
- Test: `tests/panel-sesion.test.ts` (existente — se amplía)

**Interfaces:**
- Consumes: nada de tareas anteriores.
- Produces:
  - `emitirSesion(nombre: string): { cookie: string; csrf: string }` — **cambia de firma**,
    antes no recibía nada.
  - `nombreDeSesion(request: Request): string | null` — el vendedor de la sesión, o `null`.
  - `sesionValida(request: Request): boolean` — se conserva, ahora definida como
    `nombreDeSesion(request) !== null`.
  - `csrfValido`, `csrfDeSesion` — sin cambios de firma.

- [ ] **Step 1: Escribir las pruebas que fallan**

Añadir a `tests/panel-sesion.test.ts` (conservando todo lo que ya tiene):

```ts
import { emitirSesion, sesionValida, nombreDeSesion, csrfDeSesion } from '@/lib/sesion';

// Ayuda: convierte la cabecera Set-Cookie en una cabecera Cookie de petición.
function pedirCon(cookie: string): Request {
  const valor = cookie.split(';')[0];
  return new Request('https://luxeessentialscr.com/api/cotizacion/listado', {
    headers: { cookie: valor },
  });
}

describe('la sesión recuerda al vendedor', () => {
  it('devuelve el nombre con el que se emitió', () => {
    const { cookie } = emitirSesion('Guillermo Rojas');
    expect(nombreDeSesion(pedirCon(cookie))).toBe('Guillermo Rojas');
  });

  it('conserva tildes y eñes', () => {
    const { cookie } = emitirSesion('José Peña');
    expect(nombreDeSesion(pedirCon(cookie))).toBe('José Peña');
  });

  it('rechaza una cookie con el nombre alterado', () => {
    const { cookie } = emitirSesion('Guillermo Rojas');
    const valor = cookie.split(';')[0].split('=')[1];
    const [emitido, , firma] = valor.split('.');
    const otro = Buffer.from('Gerente General', 'utf8').toString('base64url');
    const falsa = `luxe_sesion=${emitido}.${otro}.${firma}`;
    const req = new Request('https://luxeessentialscr.com/x', { headers: { cookie: falsa } });
    expect(nombreDeSesion(req)).toBeNull();
    expect(sesionValida(req)).toBe(false);
  });

  // Las cookies del formato viejo (`<emitidoEn>.<firma>`) no traen vendedor.
  // Aceptarlas dejaría entrar con la clave compartida a quien tuviera una
  // guardada, que es justo el hueco que esta fase cierra.
  it('rechaza una cookie del formato anterior, de dos partes', () => {
    const req = new Request('https://luxeessentialscr.com/x', {
      headers: { cookie: 'luxe_sesion=1756000000000.deadbeef' },
    });
    expect(sesionValida(req)).toBe(false);
    expect(nombreDeSesion(req)).toBeNull();
  });

  it('no emite una sesión sin nombre', () => {
    expect(() => emitirSesion('')).toThrow();
    expect(() => emitirSesion('   ')).toThrow();
  });

  it('sigue entregando el token anti-CSRF de la sesión', () => {
    const { cookie, csrf } = emitirSesion('Guillermo Rojas');
    expect(csrfDeSesion(pedirCon(cookie))).toBe(csrf);
  });
});
```

Además: **revisar todas las llamadas a `emitirSesion()` que ya existan en
`tests/panel-sesion.test.ts` y `tests/api-cotizacion-sesion.test.ts` y pasarles un nombre**
(`emitirSesion('Guillermo Rojas')`). Sin eso fallan por firma, no por comportamiento.

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run tests/panel-sesion.test.ts`
Expected: FAIL — `nombreDeSesion` no está exportada.

- [ ] **Step 3: Modificar `lib/sesion.ts`**

El valor de la cookie pasa de `<emitidoEn>.<firma>` a `<emitidoEn>.<nombre>.<firma>`, con el
nombre en `base64url` (un nombre con tildes, espacios o un punto rompería el separador o el
propio formato de cookie). La firma cubre `<emitidoEn>.<nombre>`, así que cambiar el nombre
la invalida.

Reemplazar `emitirSesion` y `sesionValida` por:

```ts
// El nombre viaja dentro del valor firmado y no en una cookie aparte: una
// segunda cookie sin firmar sería editable por el cliente, y "quién armó esta
// cotización" pasaría a ser un dato que el propio cliente elige. Va en
// `base64url` porque un nombre real trae tildes, espacios y a veces un punto —
// y el punto es el separador de este formato.
function codificarNombre(nombre: string): string {
  return Buffer.from(nombre, 'utf8').toString('base64url');
}

function decodificarNombre(codificado: string): string | null {
  try {
    const nombre = Buffer.from(codificado, 'base64url').toString('utf8');
    // Un `base64url` inválido no lanza: Buffer descarta lo que no reconoce y
    // devuelve algo. Se comprueba el viaje de ida y vuelta para no aceptar
    // basura que decodifique a un nombre vacío o distinto.
    if (!nombre || codificarNombre(nombre) !== codificado) return null;
    return nombre;
  } catch {
    return null;
  }
}

export function emitirSesion(nombre: string): { cookie: string; csrf: string } {
  if (!secreto()) {
    throw new Error('LUXE_TALLER_CLAVE no está configurada: no se puede emitir una sesión.');
  }
  // Una sesión sin vendedor no puede existir: firmaría cotizaciones con nadie.
  if (typeof nombre !== 'string' || nombre.trim().length === 0) {
    throw new Error('No se puede emitir una sesión sin el nombre del vendedor.');
  }

  const emitidoEn = String(Date.now());
  const codificado = codificarNombre(nombre.trim());
  const contenido = `${emitidoEn}.${codificado}`;
  const firma = firmar(contenido);
  const valor = `${contenido}.${firma}`;
  const csrf = derivarCsrf(valor);

  const cookie = [
    `${NOMBRE_COOKIE}=${valor}`,
    'Path=/',
    `Max-Age=${MAX_EDAD_SEGUNDOS}`,
    'HttpOnly',
    'Secure',
    'SameSite=None',
    'Partitioned',
  ].join('; ');

  return { cookie, csrf };
}

// Devuelve el vendedor de la sesión, o null si no hay una válida. Es la función
// de verdad: `sesionValida` es su versión booleana. Las mismas comprobaciones
// de siempre —firma, caducidad real en el servidor, emisión no futura— más el
// formato de tres partes.
export function nombreDeSesion(request: Request): string | null {
  const esperado = secreto();
  if (!esperado) return null;

  const valor = obtenerCookie(request, NOMBRE_COOKIE);
  if (!valor) return null;

  // Tres partes exactas. Una cookie del formato anterior (dos partes) no trae
  // vendedor: aceptarla dejaría entrar a quien conserve una emitida con la
  // clave compartida, que es justo el hueco que esta fase cierra.
  const partes = valor.split('.');
  if (partes.length !== 3) return null;
  const [emitidoEnTexto, codificado, firma] = partes;
  if (!emitidoEnTexto || !codificado || !firma) return null;

  if (!igualesEnTiempoConstante(firma, firmar(`${emitidoEnTexto}.${codificado}`))) return null;

  const emitidoEn = Number(emitidoEnTexto);
  if (!Number.isFinite(emitidoEn)) return null;

  const ahora = Date.now();
  if (emitidoEn > ahora + TOLERANCIA_RELOJ_MS) return null;
  if (ahora - emitidoEn > MAX_EDAD_MS) return null;

  return decodificarNombre(codificado);
}

export function sesionValida(request: Request): boolean {
  return nombreDeSesion(request) !== null;
}
```

Actualizar el comentario de cabecera del archivo para que mencione que la cookie ahora
identifica a una persona, y no sólo que hubo una entrada válida.

- [ ] **Step 4: Correr la suite completa**

Run: `npm test`
Expected: verde. Si algún archivo llama `emitirSesion()` sin nombre, corregirlo pasando
`'Guillermo Rojas'`.

- [ ] **Step 5: Commit**

```bash
git add lib/sesion.ts tests/panel-sesion.test.ts tests/api-cotizacion-sesion.test.ts
git commit -m "feat(usuarios): la sesion identifica al vendedor"
```

---

### Task 4: `/entrar` autentica contra la tabla y se retira la clave compartida

**Files:**
- Modify: `app/api/cotizacion/entrar/route.ts`
- Modify: `lib/autenticacion-cotizador.ts`
- Test: `tests/api-cotizacion-sesion.test.ts` (existente — se amplía)

**Interfaces:**
- Consumes: `autenticarUsuario`, `ResultadoEntrada` de `@/lib/cotizador/usuarios`;
  `emitirSesion(nombre)`, `nombreDeSesion` de `@/lib/sesion`.
- Produces:
  - `autenticarPeticion(request, crudo, { requiereCsrf }): { ok: true; vendedor: string } | { ok: false; status: number; error: string }`
    — **cambia el tipo de retorno**: en el caso `ok` ahora trae el vendedor.
  - `claveValida` **se elimina** de `lib/autenticacion-cotizador.ts`. Nada más la importa
    después de esta tarea.
  - `POST /api/cotizacion/entrar` recibe `{ usuario, clave }` y responde `{ ok: true, csrf, vendedor }`.

- [ ] **Step 1: Escribir las pruebas que fallan**

Añadir a `tests/api-cotizacion-sesion.test.ts`:

```ts
// El endpoint de entrada ya no acepta la clave compartida: la cambia por la
// tabla de usuarios. Se moquea `@/lib/cotizador/usuarios` para probar la ruta
// sin base de datos — la lógica de intentos ya tiene sus propias pruebas.
vi.mock('@/lib/cotizador/usuarios', () => ({
  autenticarUsuario: vi.fn(),
}));

import { autenticarUsuario } from '@/lib/cotizador/usuarios';
import { POST as entrar } from '@/app/api/cotizacion/entrar/route';

function peticionEntrada(cuerpo: unknown) {
  return new Request('https://luxeessentialscr.com/api/cotizacion/entrar', {
    method: 'POST',
    body: JSON.stringify(cuerpo),
  });
}

describe('POST /api/cotizacion/entrar', () => {
  beforeEach(() => {
    vi.mocked(autenticarUsuario).mockReset();
    process.env.LUXE_TALLER_CLAVE = 'secreto-de-firma';
  });

  it('emite una sesión con el nombre del vendedor', async () => {
    vi.mocked(autenticarUsuario).mockResolvedValue({ ok: true, nombre: 'Guillermo Rojas' });
    const res = await entrar(peticionEntrada({ usuario: 'guillermo', clave: 'x' }));
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.vendedor).toBe('Guillermo Rojas');
    expect(typeof cuerpo.csrf).toBe('string');
    expect(res.headers.get('set-cookie')).toContain('luxe_sesion=');
  });

  it('rechaza credenciales incorrectas con 401', async () => {
    vi.mocked(autenticarUsuario).mockResolvedValue({ ok: false, motivo: 'credenciales' });
    const res = await entrar(peticionEntrada({ usuario: 'guillermo', clave: 'mala' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('distingue una cuenta bloqueada, con 429 y un mensaje propio', async () => {
    vi.mocked(autenticarUsuario).mockResolvedValue({ ok: false, motivo: 'bloqueado' });
    const res = await entrar(peticionEntrada({ usuario: 'guillermo', clave: 'x' }));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/bloquead/i);
  });

  // La clave compartida era la credencial de entrada hasta esta fase. Que siga
  // sirviendo dejaría abierto exactamente el hueco que la fase cierra.
  it('ya no acepta la clave compartida', async () => {
    vi.mocked(autenticarUsuario).mockResolvedValue({ ok: false, motivo: 'credenciales' });
    const res = await entrar(peticionEntrada({ clave: 'secreto-de-firma' }));
    expect(res.status).toBe(400);
    expect(vi.mocked(autenticarUsuario)).not.toHaveBeenCalled();
  });

  it('rechaza un cuerpo sin usuario con 400', async () => {
    const res = await entrar(peticionEntrada({ usuario: '', clave: 'x' }));
    expect(res.status).toBe(400);
  });

  it('devuelve 500, no 401, si la base falla', async () => {
    vi.mocked(autenticarUsuario).mockRejectedValue(new Error('conexión caída'));
    const res = await entrar(peticionEntrada({ usuario: 'guillermo', clave: 'x' }));
    expect(res.status).toBe(500);
  });
});

describe('autenticarPeticion', () => {
  it('devuelve el vendedor de la sesión', async () => {
    const { emitirSesion } = await import('@/lib/sesion');
    const { autenticarPeticion } = await import('@/lib/autenticacion-cotizador');
    const { cookie } = emitirSesion('Guillermo Rojas');
    const req = new Request('https://luxeessentialscr.com/api/cotizacion/listado', {
      headers: { cookie: cookie.split(';')[0] },
    });
    const r = autenticarPeticion(req, {}, { requiereCsrf: false });
    expect(r).toEqual({ ok: true, vendedor: 'Guillermo Rojas' });
  });

  it('ya no acepta la clave compartida en el cuerpo', async () => {
    const { autenticarPeticion } = await import('@/lib/autenticacion-cotizador');
    const req = new Request('https://luxeessentialscr.com/api/cotizacion/listado');
    const r = autenticarPeticion(req, { clave: 'secreto-de-firma' }, { requiereCsrf: false });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run tests/api-cotizacion-sesion.test.ts`
Expected: FAIL — `/entrar` sigue esperando sólo `clave`.

- [ ] **Step 3: Reescribir `app/api/cotizacion/entrar/route.ts`**

```ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { autenticarUsuario } from '@/lib/cotizador/usuarios';
import { emitirSesion } from '@/lib/sesion';
import { supabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';

// Único punto de entrada del panel embebido. Hasta la fase 2 cambiaba una clave
// compartida por una cookie; ahora cambia la credencial de una persona. La
// clave compartida (`LUXE_TALLER_CLAVE`) sigue existiendo, pero sólo como
// secreto de firma de esa cookie y como clave de `/q7m4`: ya no abre el panel.
const Entrada = z.object({
  usuario: z.string().trim().min(1, 'Falta el usuario.').max(64),
  clave: z.string().min(1, 'Falta la clave.').max(200),
});

export async function POST(request: Request) {
  let crudo: unknown;
  try {
    crudo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  const parseado = Entrada.safeParse(crudo);
  if (!parseado.success) {
    return NextResponse.json(
      { ok: false, error: 'Escribí tu usuario y tu clave.' },
      { status: 400 },
    );
  }

  let resultado;
  try {
    resultado = await autenticarUsuario(
      parseado.data.usuario,
      parseado.data.clave,
      supabaseAdmin(),
    );
  } catch (err) {
    // Un fallo de base es un 500, no un 401: decirle "clave incorrecta" a un
    // vendedor cuya credencial es correcta lo manda a buscar el problema donde
    // no está, y esconde una caída real.
    console.error(
      '[cotizador] No se pudo autenticar contra la tabla de usuarios.',
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json(
      { ok: false, error: 'No pudimos verificar tu acceso. Intentá de nuevo en un momento.' },
      { status: 500 },
    );
  }

  if (!resultado.ok) {
    console.error(
      '[cotizador] Entrada rechazada al panel.',
      'usuario:', parseado.data.usuario,
      'motivo:', resultado.motivo,
      request.headers.get('x-forwarded-for') ?? 'ip desconocida',
    );
    // El bloqueo se dice tal cual. Confirma que la cuenta existe, sí — pero el
    // nombre de usuario de un equipo de cinco personas no es el secreto, la
    // clave lo es; y un vendedor bloqueado que no puede distinguirlo de "clave
    // mala" seguiría probando hasta rendirse.
    if (resultado.motivo === 'bloqueado') {
      return NextResponse.json(
        { ok: false, error: 'Cuenta bloqueada por intentos fallidos. Probá en 15 minutos.' },
        { status: 429 },
      );
    }
    return NextResponse.json(
      { ok: false, error: 'Usuario o clave incorrectos.' },
      { status: 401 },
    );
  }

  const { cookie, csrf } = emitirSesion(resultado.nombre);
  const respuesta = NextResponse.json({ ok: true, csrf, vendedor: resultado.nombre });
  respuesta.headers.set('Set-Cookie', cookie);
  return respuesta;
}
```

- [ ] **Step 4: Modificar `lib/autenticacion-cotizador.ts`**

Eliminar `claveValida` y su reexport. `autenticarPeticion` queda:

```ts
import 'server-only';
import { nombreDeSesion, csrfValido } from '@/lib/sesion';

// Fase 3: la clave compartida en el cuerpo dejó de ser una credencial válida.
// Antes esta función aceptaba dos vías —clave o cookie— y la clave se conservó
// deliberadamente como respaldo de disponibilidad: si la cookie se caía dentro
// del iframe, el vendedor podía seguir escribiendo. Con credenciales por
// persona ese respaldo ya no puede existir: verificar un hash `scrypt` en cada
// petición costaría ~100 ms por llamada, y aceptar la clave compartida
// mantendría abierta la puerta que esta fase cierra. La cookie es ahora la
// única credencial, y el modo de fallo es mejor que el de antes: se falla al
// entrar, con un mensaje claro, en vez de dejar un panel que se lee entero y
// no escribe nada.
export type ResultadoAutenticacion =
  | { ok: true; vendedor: string }
  | { ok: false; status: number; error: string };

export function autenticarPeticion(
  request: Request,
  _crudo: unknown,
  opciones: { requiereCsrf: boolean },
): ResultadoAutenticacion {
  const vendedor = nombreDeSesion(request);
  if (!vendedor) {
    return { ok: false, status: 401, error: 'Tu sesión venció. Volvé a entrar.' };
  }

  // La cookie necesita `SameSite=None` para vivir dentro del iframe de
  // GoHighLevel, y eso hace que viaje sola en peticiones que origina cualquier
  // otro sitio que el vendedor visite. Las rutas que escriben exigen además el
  // token derivado, que sólo el propio panel puede leer y reenviar.
  if (opciones.requiereCsrf) {
    const csrfRecibido = request.headers.get('x-csrf-token') ?? undefined;
    if (!csrfValido(request, csrfRecibido)) {
      return { ok: false, status: 401, error: 'Token anti-CSRF inválido.' };
    }
  }

  return { ok: true, vendedor };
}
```

El parámetro `_crudo` se conserva para no tocar las once llamadas existentes; lleva guion
bajo porque ya no se usa.

- [ ] **Step 5: Correr la suite completa**

Run: `npm test`
Expected: fallos en las pruebas que autenticaban por clave en el cuerpo. **Convertirlas a
sesión**, no borrarlas: donde mandaban `{ clave: 'x', ... }`, ahora mandan el cuerpo sin
clave y adjuntan la cookie de `emitirSesion('Guillermo Rojas')` más la cabecera
`x-csrf-token` en las rutas que escriben. Es el trabajo grueso de esta tarea.

- [ ] **Step 6: Commit**

```bash
git add app/api/cotizacion/entrar/route.ts lib/autenticacion-cotizador.ts tests/
git commit -m "feat(usuarios): entrar con credencial propia y retirar la clave compartida"
```

---

### Task 5: La pantalla de entrada pide usuario y clave

**Files:**
- Modify: `app/cotizador/PantallaClave.tsx`
- Modify: `app/cotizador/Panel.tsx`
- Modify: `app/cotizador/VistaCrear.tsx`, `VistaListado.tsx`, `VistaMetricas.tsx`
- Modify: `app/api/cotizacion/catalogo/route.ts:62` — la sonda de sesión devuelve el vendedor
- Test: `tests/cotizador-ui.test.tsx`, `tests/panel-listado-ui.test.tsx`,
  `tests/api-cotizacion-catalogo.test.ts` (existentes)

**Interfaces:**
- Consumes: `POST /api/cotizacion/entrar` con `{ usuario, clave }` → `{ ok, csrf, vendedor }`.
- Produces: las tres vistas dejan de recibir la prop `clave`; el helper `conClave`
  desaparece de las tres.

- [ ] **Step 1: Escribir la prueba que falla**

Añadir a `tests/cotizador-ui.test.tsx`:

```tsx
it('pide usuario y clave, y manda los dos', async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true, status: 200,
    json: async () => ({ ok: true, csrf: 'tok', vendedor: 'Guillermo Rojas' }),
  });
  vi.stubGlobal('fetch', fetchMock);

  render(<PantallaClave alEntrar={vi.fn()} />);

  await userEvent.type(screen.getByLabelText(/usuario/i), 'guillermo');
  await userEvent.type(screen.getByLabelText(/clave/i), 'Turrialba-2026');
  await userEvent.click(screen.getByRole('button', { name: /entrar/i }));

  const cuerpo = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(cuerpo).toEqual({ usuario: 'guillermo', clave: 'Turrialba-2026' });
});

it('muestra el mensaje del servidor cuando la cuenta está bloqueada', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: false, status: 429,
    json: async () => ({ ok: false, error: 'Cuenta bloqueada por intentos fallidos. Probá en 15 minutos.' }),
  }));

  render(<PantallaClave alEntrar={vi.fn()} />);
  await userEvent.type(screen.getByLabelText(/usuario/i), 'guillermo');
  await userEvent.type(screen.getByLabelText(/clave/i), 'mala');
  await userEvent.click(screen.getByRole('button', { name: /entrar/i }));

  expect(await screen.findByText(/bloqueada/i)).toBeInTheDocument();
});
```

Ajustar los nombres de las props (`alEntrar`) a los que ya usa `PantallaClave.tsx`: leerlo
primero y **conservar su contrato**, cambiando sólo lo que esta tarea exige.

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run tests/cotizador-ui.test.tsx`
Expected: FAIL — no hay campo de usuario.

- [ ] **Step 3: Modificar `PantallaClave.tsx`**

Añadir un campo `usuario` antes del de clave, con `autoComplete="username"` (el de clave
lleva `autoComplete="current-password"`), mandar los dos en el cuerpo, y **mostrar el
`error` que devuelve el servidor** en vez de un texto fijo — es lo que distingue "clave
incorrecta" de "cuenta bloqueada". Etiquetas visibles asociadas con `htmlFor`/`id`: la suite
tiene `tests/a11y.test.tsx` y un campo sin etiqueta la rompe.

Texto del botón y del encabezado: conservar el que ya tenga, salvo que diga "clave" en
singular donde ahora hay dos campos.

- [ ] **Step 4: La sonda de sesión devuelve también el vendedor**

`app/cotizador/Panel.tsx` no puede leer la cookie (es `HttpOnly`), así que al recargar la
página sabe que hay sesión sólo porque `/api/cotizacion/catalogo` se la valida y le devuelve
el token anti-CSRF (`csrfDeSesion`, `app/api/cotizacion/catalogo/route.ts:62`). Sin tocar
esa ruta, tras un refresco el panel tendría sesión pero no sabría de quién: el nombre sólo
llega en la respuesta de `/entrar`, que ocurre una vez.

En `app/api/cotizacion/catalogo/route.ts`, junto al `csrf` que ya devuelve, añadir el
vendedor —tomado de la misma autenticación que la ruta ya hace— y en `Panel.tsx` guardarlo
al montar, no sólo al entrar.

Prueba, en `tests/api-cotizacion-catalogo.test.ts`:

```ts
it('devuelve el vendedor de la sesión junto al token', async () => {
  const { cookie } = emitirSesion('Guillermo Rojas');
  const res = await POST(new Request('https://luxeessentialscr.com/api/cotizacion/catalogo', {
    method: 'POST',
    headers: { cookie: cookie.split(';')[0] },
    body: JSON.stringify({}),
  }));
  expect((await res.json()).vendedor).toBe('Guillermo Rojas');
});
```

- [ ] **Step 5: Corregir el respaldo que ya no existe**

`Panel.tsx:175-232` (`establecerSesion`) verifica que la cookie haya cuajado de verdad
dentro del iframe, y **si no cuajó sólo escribe en la consola** y sigue adelante. Eso era
correcto mientras las rutas que escriben aceptaran la clave en el cuerpo: el vendedor
quedaba sin cookie pero podía seguir guardando. Después de la Tarea 4 ese respaldo no
existe, y dejar el comportamiento como está produce el peor modo de fallo posible — un
panel que se lee entero, no guarda nada, y no dice por qué.

Cambiarlo: si la verificación falla, el panel **no entra**. Muestra un error visible en la
pantalla de acceso, con el texto:

> No pudimos abrir tu sesión en este navegador. Si estás viendo el panel dentro de
> GoHighLevel, abrilo en una pestaña aparte.

Y reescribir el comentario de bloque de `establecerSesion` — hoy explica que "las tres
rutas que escriben también aceptan `clave` en el cuerpo", que a partir de la Tarea 4 es
falso. Un comentario que describe un respaldo inexistente es peor que ninguno.

Prueba, en `tests/cotizador-ui.test.tsx`:

```tsx
it('no entra si la cookie no queda establecida en el navegador', async () => {
  // /entrar responde 200, pero la sonda de verificación falla: es el caso del
  // iframe que bloquea la cookie de terceros.
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, csrf: 'tok', vendedor: 'Guillermo Rojas' }) })
    .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ ok: false }) });
  vi.stubGlobal('fetch', fetchMock);

  render(<Panel />);
  await userEvent.type(screen.getByLabelText(/usuario/i), 'guillermo');
  await userEvent.type(screen.getByLabelText(/clave/i), 'Turrialba-2026');
  await userEvent.click(screen.getByRole('button', { name: /entrar/i }));

  expect(await screen.findByText(/no pudimos abrir tu sesión/i)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /nueva cotización/i })).not.toBeInTheDocument();
});
```

Ajustar el nombre del botón del listado al que realmente exista en `Panel.tsx`.

- [ ] **Step 6: Retirar el hilo de `clave` de las vistas**

En `Panel.tsx`: dejar de guardar y de pasar `clave` a las tres vistas; conservar el
guardado del token CSRF tal como está. Guardar además el `vendedor` que devuelve `/entrar` y
mostrarlo en la cabecera del panel ("Sesión de Guillermo Rojas") — es lo que hace visible
con qué cuenta se está trabajando.

En `VistaCrear.tsx`, `VistaListado.tsx` y `VistaMetricas.tsx`: borrar el helper `conClave` y
la prop `clave`, y dejar los cuerpos sin ese campo (`JSON.stringify({})`,
`JSON.stringify({ id })`, etc.). No tocar la cabecera `x-csrf-token` de las rutas que
escriben.

- [ ] **Step 7: Correr la suite completa**

Run: `npm test`
Expected: verde. Las pruebas de UI que pasaban `clave="x"` como prop deben quedar sin ella.

- [ ] **Step 8: Commit**

```bash
git add app/cotizador app/api/cotizacion/catalogo/route.ts tests/
git commit -m "feat(usuarios): la pantalla de entrada pide usuario y clave"
```

---

### Task 6: Cada cotización queda firmada con el vendedor

**Files:**
- Modify: `app/api/cotizacion/route.ts`
- Modify: `app/api/cotizacion/duplicar/route.ts`
- Modify: `app/api/cotizacion/listado/route.ts:21-23`
- Modify: `app/cotizador/VistaListado.tsx`
- Test: `tests/api-cotizacion.test.ts`, `tests/panel-listado-ui.test.tsx` (existentes)

**Interfaces:**
- Consumes: `autenticarPeticion(...)` → `{ ok: true; vendedor: string }` (Tarea 4);
  columna `cotizaciones.vendedor` (Tarea 1).
- Produces: la fila del listado incluye `vendedor: string | null`.

- [ ] **Step 1: Escribir la prueba que falla**

Añadir a `tests/api-cotizacion.test.ts`, junto a las pruebas de creación existentes y
usando sus mismos dobles de Supabase:

```ts
it('guarda el vendedor de la sesión en la cotización', async () => {
  // ... el mismo montaje que la prueba de creación exitosa que ya existe,
  // autenticando con la cookie de emitirSesion('Guillermo Rojas')
  await POST(peticionValida());
  expect(insertado).toMatchObject({ vendedor: 'Guillermo Rojas' });
});
```

Y a `tests/panel-listado-ui.test.tsx`:

```tsx
it('muestra quién armó cada cotización', async () => {
  // ... con el mismo doble de fetch que usan las pruebas del listado,
  // devolviendo una fila con vendedor: 'Guillermo Rojas'
  expect(await screen.findByText('Guillermo Rojas')).toBeInTheDocument();
});
```

Leer las pruebas vecinas y reutilizar sus ayudas en vez de montar dobles nuevos.

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run tests/api-cotizacion.test.ts tests/panel-listado-ui.test.tsx`
Expected: FAIL — el insert no lleva `vendedor`.

- [ ] **Step 3: Estampar el vendedor**

En `app/api/cotizacion/route.ts`, capturar el resultado de la autenticación
(`const auth = autenticarPeticion(...)`, línea 47) y añadir al objeto del insert
(línea ~82):

```ts
      // Quién la armó. Se guarda el nombre y no el id del usuario a propósito:
      // dentro de un año esta fila tiene que seguir diciendo quién la hizo
      // aunque esa persona se haya dado de baja.
      vendedor: auth.vendedor,
```

En `app/api/cotizacion/duplicar/route.ts`, si la ruta inserta una fila nueva, estampar el
vendedor **de la sesión actual** y no el de la cotización original: la duplica quien la está
duplicando. Si sólo devuelve las líneas para rellenar el formulario, no hay nada que hacer —
verificarlo leyendo la ruta.

En `app/api/cotizacion/listado/route.ts:21-23`, añadir `vendedor` a `COLUMNAS`.

En `app/cotizador/VistaListado.tsx`, añadir `vendedor: string | null` a `FilaListado` y
mostrarlo en la fila, con un guion cuando sea `null` — las cotizaciones anteriores a esta
fase no lo tienen y no se inventa un nombre.

- [ ] **Step 4: Correr la suite completa**

Run: `npm test`
Expected: verde.

- [ ] **Step 5: Commit**

```bash
git add app/api/cotizacion app/cotizador/VistaListado.tsx tests/
git commit -m "feat(usuarios): cada cotizacion queda firmada con su vendedor"
```

---

### Task 7: El script de administración de usuarios

**Files:**
- Create: `scripts/usuarios.mjs`
- Modify: `package.json` (script `usuarios`)
- Modify: `.env.example`
- Modify: `docs/superpowers/specs/2026-08-28-usuarios-panel-design.md` (nota de despliegue)
- Test: `tests/usuarios-script.test.ts`

**Interfaces:**
- Consumes: `hashClave` de `lib/cotizador/credenciales.mjs` (ruta relativa
  `../lib/cotizador/credenciales.mjs`, porque un `.mjs` suelto no resuelve el alias `@/`).
- Produces: `npm run usuarios -- <orden>` con las órdenes `listar`, `alta`, `clave`,
  `desactivar`, `activar`, `desbloquear`.
- Exporta `construirSql(orden, argumentos)` para poder probar el armado de consultas sin
  base de datos.

- [ ] **Step 1: Escribir la prueba que falla**

Crear `tests/usuarios-script.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { construirSql } from '../scripts/usuarios.mjs';
import { verificarClave } from '@/lib/cotizador/credenciales.mjs';

describe('construirSql', () => {
  it('arma el alta con parámetros, nunca por interpolación', async () => {
    const { texto, valores } = await construirSql('alta', ['Guillermo', 'Guillermo Rojas', 'Turrialba-2026']);
    expect(texto).toContain('insert into public.usuarios_panel');
    // Ni el nombre ni la clave pueden aparecer en el texto de la consulta: si
    // aparecieran, una comilla en un apellido rompería el SQL —y el mismo
    // agujero serviría para inyectarlo.
    expect(texto).not.toContain('Guillermo');
    expect(texto).not.toContain('Turrialba-2026');
    expect(valores).toContain('guillermo');       // usuario normalizado
    expect(valores).toContain('Guillermo Rojas'); // nombre tal cual
  });

  it('el hash que guarda el alta verifica con la clave dada', async () => {
    const { valores } = await construirSql('alta', ['guillermo', 'Guillermo Rojas', 'Turrialba-2026']);
    const [, , hash, sal] = valores;
    expect(await verificarClave('Turrialba-2026', hash, sal)).toBe(true);
  });

  it('desactivar no borra la fila', async () => {
    const { texto } = await construirSql('desactivar', ['guillermo']);
    expect(texto).toContain('update');
    expect(texto).not.toMatch(/\bdelete\b/i);
  });

  it('desbloquear limpia el bloqueo y el contador', async () => {
    const { texto } = await construirSql('desbloquear', ['guillermo']);
    expect(texto).toContain('bloqueado_hasta = null');
    expect(texto).toContain('intentos = 0');
  });

  // La lista es para saber quién tiene acceso, no para exfiltrar hashes.
  it('listar no selecciona el hash ni la sal', async () => {
    const { texto } = await construirSql('listar', []);
    expect(texto).not.toContain('clave_hash');
    expect(texto).not.toContain('clave_sal');
  });

  it('rechaza una orden desconocida', async () => {
    await expect(construirSql('borrar-todo', [])).rejects.toThrow();
  });

  it('exige los argumentos de cada orden', async () => {
    await expect(construirSql('alta', ['guillermo'])).rejects.toThrow();
    await expect(construirSql('desactivar', [])).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run tests/usuarios-script.test.ts`
Expected: FAIL — no existe `scripts/usuarios.mjs`.

- [ ] **Step 3: Escribir `scripts/usuarios.mjs`**

Seguir el molde de `scripts/db.mjs`: `dotenv` con `.env.local`, `pg`, y la misma función
`connectionString()` (copiarla; `db.mjs` no la exporta y no vale la pena convertirlo en
módulo para esto). El archivo exporta `construirSql` y sólo corre la interfaz de consola
cuando se lo invoca directamente:

```js
import { pathToFileURL } from 'node:url';
import { hashClave } from '../lib/cotizador/credenciales.mjs';

// Los usuarios se administran por consola y no por una pantalla dentro del
// panel. Una pantalla de administración es más superficie de ataque, más código
// y más pruebas para algo que se usa tres veces al año: cuando entra alguien
// nuevo y cuando alguien se va.
export async function construirSql(orden, argumentos) {
  switch (orden) {
    case 'listar':
      return {
        texto:
          'select usuario, nombre, activo, intentos, bloqueado_hasta, ultimo_acceso, creado_at ' +
          'from public.usuarios_panel order by activo desc, usuario',
        valores: [],
      };
    case 'alta': {
      const [usuario, nombre, clave] = argumentos;
      if (!usuario || !nombre || !clave) {
        throw new Error('Uso: alta <usuario> "<nombre completo>" <clave>');
      }
      const { hash, sal } = await hashClave(clave);
      return {
        texto:
          'insert into public.usuarios_panel (usuario, nombre, clave_hash, clave_sal) ' +
          'values ($1, $2, $3, $4)',
        valores: [usuario.trim().toLowerCase(), nombre, hash, sal],
      };
    }
    // ... `clave`, `desactivar`, `activar`, `desbloquear` con el mismo patrón
    default:
      throw new Error(`Orden desconocida: ${orden}. Usá: listar, alta, clave, desactivar, activar, desbloquear.`);
  }
}
```

Reglas que el implementador debe respetar:

- **Todo valor viaja como parámetro (`$1`, `$2`…), nunca interpolado.** Un apellido con
  apóstrofo rompería la consulta, y el mismo agujero serviría para inyectar.
- `desactivar` y `activar` son `update ... set activo = ...`, nunca `delete`.
- `desbloquear` pone `bloqueado_hasta = null, intentos = 0`.
- `clave <usuario> <nueva>` deriva un hash nuevo y **también** limpia bloqueo e intentos:
  quien cambia la clave de alguien es porque esa persona no puede entrar.
- `listar` no selecciona `clave_hash` ni `clave_sal`.
- Al terminar, el script imprime cuántas filas afectó. `alta` sobre un usuario existente
  falla por el índice único: capturar el error de Postgres `23505` y decir
  "Ese usuario ya existe. Usá `clave` para cambiarle la contraseña."

- [ ] **Step 4: Correr y verificar que pasa**

Run: `npx vitest run tests/usuarios-script.test.ts`
Expected: PASS (7 pruebas).

- [ ] **Step 5: Añadir el script y documentar el entorno**

En `package.json`, junto a `db:migrate`:

```json
    "usuarios": "node scripts/usuarios.mjs"
```

En `.env.example`, añadir el horario del pie (lo usa la Tarea 8) debajo de las tres que ya
están:

```
LUXE_CONTACTO_HORARIO=
```

En la sección "Migración desde la clave compartida" del spec, añadir el procedimiento exacto:

```markdown
Antes de desplegar, con la migración ya aplicada:

    npm run db:migrate
    npm run usuarios -- alta guillermo "Guillermo Rojas" '<clave>'
    npm run usuarios -- listar

Si esto no se hace, nadie entra al panel: la clave compartida ya no sirve.
```

- [ ] **Step 6: Verificar que el proyecto compila**

Run: `npm run build`
Expected: build correcto. Esto es lo que confirma que Next.js resuelve el import de
`lib/cotizador/credenciales.mjs` desde código TypeScript — el único riesgo real de la
decisión de escribir ese módulo en JavaScript. Si falla la resolución, **no cambiar de
enfoque por cuenta propia**: reportarlo, porque la alternativa (duplicar el hash) tiene
consecuencias que están discutidas en el spec.

- [ ] **Step 7: Commit**

```bash
git add scripts/usuarios.mjs tests/usuarios-script.test.ts package.json .env.example docs/superpowers/specs/2026-08-28-usuarios-panel-design.md
git commit -m "feat(usuarios): script de administracion por consola"
```

---

### Task 8: Los datos de contacto de la empresa en el pie del PDF

**Files:**
- Modify: `lib/cotizador/documento.tsx:113-121`
- Test: `tests/panel-documento.test.ts:75-120` (existente)

**Interfaces:**
- Consumes: nada de tareas anteriores.
- Produces: el pie del PDF admite una cuarta variable, `LUXE_CONTACTO_HORARIO`.

El pie ya existe y ya está probado: `lineaContacto()` arma la línea con lo que haya en
`LUXE_CONTACTO_TELEFONO`, `LUXE_CONTACTO_CORREO` y `LUXE_CONTACTO_SITIO`, y omite el pie
entero si no hay ninguna. **Lo que falta son los valores**, más el horario.

Los valores salen del pie del sitio (`content/copy.ts:225-240`), que es la fuente de verdad
de los datos públicos de Luxe:

- `LUXE_CONTACTO_TELEFONO=+506 6140 2511`
- `LUXE_CONTACTO_CORREO=info@luxeessentialscr.com`
- `LUXE_CONTACTO_SITIO=luxeessentialscr.com`
- `LUXE_CONTACTO_HORARIO=Lunes a viernes, 8:00 a 17:00`

**El pie lleva los datos de la empresa y no los del vendedor.** Decisión del cliente: el
hotel ve a Luxe como empresa, y la atribución por persona es interna (vive en el listado del
panel, Tarea 6).

- [ ] **Step 1: Escribir la prueba que falla**

Añadir a `tests/panel-documento.test.ts`, dentro del bloque que ya maneja `VARS_CONTACTO`
(y **añadiendo `LUXE_CONTACTO_HORARIO` a ese arreglo**, para que la limpieza entre pruebas
la cubra):

```ts
it('incluye el horario de atención cuando está configurado', async () => {
  process.env.LUXE_CONTACTO_TELEFONO = '+506 2222-3333';
  process.env.LUXE_CONTACTO_HORARIO = 'Lunes a viernes, 8:00 a 17:00';
  const texto = await textoDelPdf(datosDeEjemplo());
  expect(texto).toContain('Lunes a viernes, 8:00 a 17:00');
});

it('omite el pie entero si no hay ningún dato de contacto', async () => {
  const texto = await textoDelPdf(datosDeEjemplo());
  expect(texto).not.toContain('¿Consultas sobre esta cotización?');
});
```

Reutilizar la ayuda de extracción de texto que ya usa ese archivo (`pdf-parse`), y respetar
su `// @vitest-environment node`.

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run tests/panel-documento.test.ts`
Expected: FAIL — el horario no aparece en el PDF.

- [ ] **Step 3: Añadir el horario a `lineaContacto()`**

En `lib/cotizador/documento.tsx:113-121`, añadir la variable al arreglo, **después** del
sitio, para que la línea lea: teléfono · correo · sitio · horario.

```ts
  const partes = [
    process.env.LUXE_CONTACTO_TELEFONO,
    process.env.LUXE_CONTACTO_CORREO,
    process.env.LUXE_CONTACTO_SITIO,
    // El horario va al final: a un hotel que recibe la cotización un sábado le
    // ahorra una llamada al vacío.
    process.env.LUXE_CONTACTO_HORARIO,
  ].filter((v): v is string => Boolean(v && v.trim().length > 0));
```

- [ ] **Step 4: Correr la suite completa**

Run: `npm test`
Expected: verde.

- [ ] **Step 5: Escribir los valores reales en `.env.local`**

Añadir las cuatro variables con los valores de arriba. **`.env.local` no se versiona** —
anotarlo en el reporte para que se copien también a las variables de entorno de Vercel.

- [ ] **Step 6: Commit**

```bash
git add lib/cotizador/documento.tsx tests/panel-documento.test.ts
git commit -m "feat(cotizador): horario de atencion en el pie del documento"
```

---

## Verificación final

- [ ] `npm test` — la suite completa en verde (681 pruebas antes de esta fase, más las ~30
      que añaden estas ocho tareas).
- [ ] `npm run build` — compila.
- [ ] `npm run db:migrate` — `0012` aplicada.
- [ ] `npm run usuarios -- alta` seguido de `npm run usuarios -- listar` — el usuario aparece.
- [ ] Entrar al panel con ese usuario, crear una cotización, y confirmar que el listado
      muestra su nombre en la fila.
- [ ] Confirmar que `/q7m4` sigue entrando con `LUXE_TALLER_CLAVE`, intacto.
