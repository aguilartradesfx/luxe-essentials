import { describe, it, expect, vi, beforeEach } from 'vitest';
import { calcular } from '@/lib/cotizador/calcular';
import { CATALOGO } from '@/lib/cotizador/catalogo';

// Fase 5 (descuento con aprobación): "cancelar" es lo único que el vendedor
// puede hacer con su propia solicitud mientras espera. Mismo mecanismo de
// prueba (sin red) que tests/api-cotizacion-aprobacion.test.ts, pero sin los
// mocks de GoHighLevel/PDF/correo -- /cancelar nunca los toca.

type Filtro = ['eq', string, unknown];
type FilaCot = Record<string, unknown>;

let cotizaciones: FilaCot[];

function coincideFiltro(fila: FilaCot, f: Filtro): boolean {
  return fila[f[1]] === f[2];
}
function coincideTodos(fila: FilaCot, filtros: Filtro[]): boolean {
  return filtros.every((f) => coincideFiltro(fila, f));
}

function nodoSelect(tabla: FilaCot[]): any {
  const filtros: Filtro[] = [];
  const nodo: any = {
    eq(c: string, v: unknown) {
      filtros.push(['eq', c, v]);
      return nodo;
    },
    maybeSingle: async () => {
      const m = tabla.filter((f) => coincideTodos(f, filtros));
      return { data: m[0] ? { ...m[0] } : null, error: null };
    },
  };
  return nodo;
}

function nodoUpdateCot(cambios: Record<string, unknown>): any {
  const filtros: Filtro[] = [];
  const nodo: any = {
    eq(c: string, v: unknown) {
      filtros.push(['eq', c, v]);
      return nodo;
    },
    select: async () => {
      const m = cotizaciones.filter((f) => coincideTodos(f, filtros));
      for (const f of m) Object.assign(f, cambios);
      return { data: m.map((f) => ({ ...f })), error: null };
    },
  };
  return nodo;
}

vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => nodoSelect(cotizaciones),
      update: (cambios: Record<string, unknown>) => nodoUpdateCot(cambios),
    }),
  }),
}));

const { POST: postCancelar } = await import('@/app/api/cotizacion/cancelar/route');
const { emitirSesion } = await import('@/lib/sesion');

function peticion(cuerpo: unknown, cabeceras: Record<string, string> = {}) {
  return new Request('https://luxeessentialscr.com/api/cotizacion/cancelar', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cabeceras },
    body: JSON.stringify(cuerpo),
  });
}

const ID_VENDEDOR = 'aaaaaaaa-0000-4000-8000-000000000002';
const UUID_COT1 = 'aaaaaaaa-2222-4000-8000-000000000001';

function sesionVendedor() {
  const { cookie, csrf } = emitirSesion('Guillermo Rojas', 'vendedor', ID_VENDEDOR);
  return { cookie: cookie.split(';')[0], csrf };
}

function filaPendienteBase(extra: Partial<FilaCot> = {}): FilaCot {
  const cot = calcular([{ skuId: 'set-600-king', cantidad: 16 }], CATALOGO, {
    descuentoPersonalizado: { general: 20 },
  });
  return {
    id: UUID_COT1,
    estado: 'esperando_aprobacion',
    numero: 'COT-2026-0001',
    cliente: { nombre: 'Ana Pérez', empresa: 'Hotel Papagayo', email: 'ana@hotel.com' },
    lineas: cot.lineas,
    totales: { total: cot.total },
    descuento_personalizado: { general: 20 },
    solicitado_por: 'Guillermo Rojas',
    ...extra,
  };
}

beforeEach(() => {
  process.env.LUXE_SESION_SECRETO = 'secreta';
  cotizaciones = [filaPendienteBase()];
});

describe('POST /api/cotizacion/cancelar', () => {
  it('rechaza sin sesión (401)', async () => {
    const res = await postCancelar(peticion({ id: UUID_COT1 }));
    expect(res.status).toBe(401);
  });

  it('rechaza (401) una sesión válida sin el token anti-CSRF', async () => {
    const { cookie } = sesionVendedor();
    const res = await postCancelar(peticion({ id: UUID_COT1 }, { cookie }));
    expect(res.status).toBe(401);
  });

  it('400 si el id no es un uuid válido', async () => {
    const { cookie, csrf } = sesionVendedor();
    const res = await postCancelar(peticion({ id: 'no-es-un-uuid' }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(400);
  });

  it('404 si la cotización no existe', async () => {
    const { cookie, csrf } = sesionVendedor();
    const res = await postCancelar(
      peticion({ id: 'aaaaaaaa-1111-4000-8000-000000000099' }, { cookie, 'x-csrf-token': csrf }),
    );
    expect(res.status).toBe(404);
  });

  it('409 si la cotización ya no está esperando aprobación', async () => {
    cotizaciones[0].estado = 'enviada';
    const { cookie, csrf } = sesionVendedor();
    const res = await postCancelar(peticion({ id: UUID_COT1 }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(409);
  });

  // A diferencia de /aprobar y /rechazar, cualquier vendedor autenticado
  // puede cancelar -- no hace falta ser superadmin. Esta prueba usa una
  // cookie de rol 'vendedor' (no 'superadmin') a propósito: si algún día
  // alguien agrega por error un chequeo de superadmin acá, esta prueba lo
  // detecta con un 403 en vez de 200.
  it('200: un vendedor de a pie puede cancelar, la fila queda "borrador"', async () => {
    const { cookie, csrf } = sesionVendedor();
    const res = await postCancelar(peticion({ id: UUID_COT1 }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo).toEqual({ ok: true });
    expect(cotizaciones[0].estado).toBe('borrador');
  });
});
