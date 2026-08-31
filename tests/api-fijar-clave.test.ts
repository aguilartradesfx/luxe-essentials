import { describe, it, expect, vi, beforeEach } from 'vitest';
import { huellaDe } from '@/lib/cotizador/invitaciones';

const CLAVE_BUENA = 'clave-larga-de-prueba';

// Doble mínimo de la parte de PostgREST que usa la ruta: una lectura por
// `invitacion_hash` (nunca por el enlace crudo) y una escritura por `id`.
// Mismo patrón de `filtros`/`escrituras` que tests/api-panel.test.ts y
// tests/usuarios-autenticacion.test.ts: se registra cada par
// `[columna, valor]` de un `.eq()` y cada objeto que llega a un `.update()`,
// para poder afirmar sobre la consulta en sí y no solo sobre el resultado.
type Filtro = [string, string];

let fila: Record<string, unknown> | null;
let errorLectura: { message: string } | null;
let errorEscritura: { message: string } | null;
let filtros: Filtro[];
let escrituras: Record<string, unknown>[];

function filaInvitacionValida(extra: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    correo: 'guillermo@luxeessentialscr.com',
    nombre: 'Guillermo Rojas',
    rol: 'vendedor',
    activo: true,
    clave_hash: null,
    clave_sal: null,
    invitacion_hash: huellaDe('abc'),
    invitacion_expira: new Date(Date.now() + 3_600_000).toISOString(),
    intentos: 3,
    bloqueado_hasta: null,
    ...extra,
  };
}

function construirLectura(): any {
  const nodo: any = {
    eq: (columna: string, valor: string) => {
      filtros.push([columna, String(valor)]);
      return nodo;
    },
    maybeSingle: async () => ({ data: fila, error: errorLectura }),
  };
  return nodo;
}

function construirEscritura(cambios: Record<string, unknown>): any {
  escrituras.push(cambios);
  return {
    eq: async () => ({ error: errorEscritura }),
  };
}

vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => construirLectura(),
      update: (cambios: Record<string, unknown>) => construirEscritura(cambios),
    }),
  }),
}));

const { POST } = await import('@/app/api/cotizacion/fijar-clave/route');

function peticion(cuerpo: unknown) {
  return new Request('https://luxeessentialscr.com/api/cotizacion/fijar-clave', {
    method: 'POST',
    body: JSON.stringify(cuerpo),
  });
}

describe('POST /api/cotizacion/fijar-clave', () => {
  beforeEach(() => {
    process.env.LUXE_SESION_SECRETO = 'secreto-de-firma-de-prueba';
    fila = filaInvitacionValida();
    errorLectura = null;
    errorEscritura = null;
    filtros = [];
    escrituras = [];
  });

  it('fija la clave y abre la sesión de una vez', async () => {
    const res = await POST(peticion({ enlace: 'abc', clave: CLAVE_BUENA }));
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.vendedor).toBe('Guillermo Rojas');
    expect(cuerpo.rol).toBe('vendedor');
    expect(typeof cuerpo.csrf).toBe('string');
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
    expect(
      await verificarClave(CLAVE_BUENA, escrituras[0].clave_hash as string, escrituras[0].clave_sal as string),
    ).toBe(true);
  });

  it('rechaza un enlace inexistente sin decir por qué', async () => {
    fila = null;
    const res = await POST(peticion({ enlace: 'no-existe', clave: CLAVE_BUENA }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/venci|no es v[áa]lido/i);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('rechaza un enlace vencido, con el mismo 400 y el mismo texto que uno inexistente', async () => {
    fila = filaInvitacionValida({ invitacion_expira: new Date(Date.now() - 3_600_000).toISOString() });
    const res = await POST(peticion({ enlace: 'abc', clave: CLAVE_BUENA }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/venci|no es v[áa]lido/i);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  // Tercer caso de rechazo del brief: la cuenta existe y el enlace no venció,
  // pero está desactivada. Tiene que devolver exactamente el mismo 400 y el
  // mismo texto que los otros dos — si se distinguiera, alguien podría usar
  // la respuesta para averiguar qué correos están invitados.
  it('rechaza una cuenta desactivada, con el mismo 400 y el mismo texto', async () => {
    fila = filaInvitacionValida({ activo: false });
    const res = await POST(peticion({ enlace: 'abc', clave: CLAVE_BUENA }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/venci|no es v[áa]lido/i);
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

  // Un fallo de base es un 500, no un 400: confundirlo con "enlace inválido"
  // esconde una caída real detrás de un mensaje que no tiene nada que ver.
  it('un fallo de lectura de la base es 500, no 400', async () => {
    errorLectura = { message: 'conexión caída' };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await POST(peticion({ enlace: 'abc', clave: CLAVE_BUENA }));
    expect(res.status).toBe(500);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('un fallo de escritura de la base es 500, no 400', async () => {
    errorEscritura = { message: 'no se pudo escribir' };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await POST(peticion({ enlace: 'abc', clave: CLAVE_BUENA }));
    expect(res.status).toBe(500);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
