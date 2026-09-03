import { describe, it, expect, vi, beforeEach } from 'vitest';
import { calcular } from '@/lib/cotizador/calcular';
import { CATALOGO } from '@/lib/cotizador/catalogo';

// Las tres rutas de este archivo (/pendientes, /aprobar, /rechazar)
// terminan, en el camino feliz de /aprobar, disparando la misma cadena
// pesada que app/api/cotizacion/route.ts -- se mockea todo lo de red por el
// mismo motivo que tests/api-cotizacion.test.ts y tests/aprobacion.test.ts.
vi.mock('@/lib/cotizador/ghl', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/cotizador/ghl')>();
  return {
    ...real,
    crearEstimate: vi.fn().mockResolvedValue({ ok: true, estimateId: 'est-1', contactId: 'contacto-ghl-1' }),
  };
});
vi.mock('@/lib/agente/acciones', () => ({
  agregarNota: vi.fn().mockResolvedValue(undefined),
  dispararWorkflow: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/cotizador/documento', () => ({
  renderizarCotizacion: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.7 falso')),
}));
vi.mock('@/lib/cotizador/almacen', () => ({
  guardarPdf: vi.fn().mockResolvedValue({ ok: true, ruta: '2026/COT-1-abc.pdf' }),
  enlaceFirmado: vi.fn().mockResolvedValue({ ok: true, url: 'https://firmada' }),
}));
vi.mock('@/lib/cotizador/correo', () => ({
  enviarCotizacion: vi.fn().mockResolvedValue({ ok: true, resendId: 're_1' }),
}));
// El contenido de los correos ya está probado en tests/correo-aprobacion.test.ts,
// y la orquestación de aprobar/rechazar en tests/aprobacion.test.ts -- acá
// sólo importa CUÁNDO se llama, no el HTML.
vi.mock('@/lib/cotizador/correo-aprobacion', () => ({
  enviarSolicitudAprobacion: vi.fn().mockResolvedValue({ ok: true, resendId: 're_sol' }),
  enviarResolucionAprobacion: vi.fn().mockResolvedValue({ ok: true, resendId: 're_res' }),
}));

type Filtro = ['eq', string, unknown] | ['in', string, readonly string[]];
type FilaCot = Record<string, unknown>;
type FilaUsuario = { id: string; nombre: string; correo: string; rol: 'vendedor' | 'superadmin'; activo: boolean };

let cotizaciones: FilaCot[];
let usuarios: FilaUsuario[];

function coincideFiltro(fila: FilaCot, f: Filtro): boolean {
  if (f[0] === 'eq') return fila[f[1]] === f[2];
  return (f[2] as readonly string[]).includes(fila[f[1]] as string);
}
function coincideTodos(fila: FilaCot, filtros: Filtro[]): boolean {
  return filtros.every((f) => coincideFiltro(fila, f));
}

function nodoSelect(tabla: FilaCot[]): any {
  const filtros: Filtro[] = [];
  let orden: { columna: string; ascending: boolean } | null = null;
  const nodo: any = {
    eq(c: string, v: unknown) {
      filtros.push(['eq', c, v]);
      return nodo;
    },
    order(columna: string, opciones?: { ascending?: boolean }) {
      orden = { columna, ascending: opciones?.ascending ?? true };
      return nodo;
    },
    maybeSingle: async () => {
      const m = tabla.filter((f) => coincideTodos(f, filtros));
      return { data: m[0] ? { ...m[0] } : null, error: null };
    },
    then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
      let m = tabla.filter((f) => coincideTodos(f, filtros));
      if (orden) {
        const { columna, ascending } = orden;
        m = [...m].sort((a, b) => {
          const av = String(a[columna]);
          const bv = String(b[columna]);
          return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      return Promise.resolve({ data: m.map((f) => ({ ...f })), error: null }).then(resolve, reject);
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
    in(c: string, v: readonly string[]) {
      filtros.push(['in', c, v]);
      return nodo;
    },
    select: async () => {
      const m = cotizaciones.filter((f) => coincideTodos(f, filtros));
      for (const f of m) Object.assign(f, cambios);
      return { data: m.map((f) => ({ ...f })), error: null };
    },
    then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
      (async () => {
        const m = cotizaciones.filter((f) => coincideTodos(f, filtros));
        for (const f of m) Object.assign(f, cambios);
        return { error: null };
      })().then(resolve, reject),
  };
  return nodo;
}

vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: () => ({
    from: (tabla: string) => {
      if (tabla === 'usuarios_panel') {
        return { select: () => nodoSelect(usuarios as unknown as FilaCot[]) };
      }
      return {
        select: () => nodoSelect(cotizaciones),
        update: (cambios: Record<string, unknown>) => nodoUpdateCot(cambios),
      };
    },
  }),
}));

const { POST: postPendientes } = await import('@/app/api/cotizacion/pendientes/route');
const { POST: postAprobar } = await import('@/app/api/cotizacion/aprobar/route');
const { POST: postRechazar } = await import('@/app/api/cotizacion/rechazar/route');
const { emitirSesion } = await import('@/lib/sesion');
const { crearEstimate } = await import('@/lib/cotizador/ghl');

function peticion(cuerpo: unknown, cabeceras: Record<string, string> = {}) {
  return new Request('https://luxeessentialscr.com/api/cotizacion', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cabeceras },
    body: JSON.stringify(cuerpo),
  });
}

// Sesión firmada de verdad -- la promesa central de este flujo es que
// `autorizarSuperadmin` relee la fila del EQUIPO y nunca confía en el rol
// de la cookie (ver lib/cotizador/equipo.ts). Las pruebas de "un vendedor
// no puede aprobar/rechazar/listar" arman una cookie VÁLIDA (firmada, con
// su CSRF correcto) y sólo hacen diferir la FILA de la base -- si la
// cookie fuera inválida, la ruta rechazaría por eso primero y la prueba no
// probaría nada (mismo criterio que tests/equipo-api.test.ts).
const ID_SUPERADMIN = 'aaaaaaaa-0000-4000-8000-000000000001';
const ID_VENDEDOR = 'aaaaaaaa-0000-4000-8000-000000000002';
// El id de la cotización pendiente por defecto. `z.uuid()` en /aprobar y
// /rechazar exige esta forma -- un id de mentira tipo 'cot-1' pasaría por
// la ruta de "Cuerpo inválido" (400) antes de llegar a nada de lo que estas
// pruebas quieren ejercitar.
const UUID_COT1 = 'aaaaaaaa-2222-4000-8000-000000000001';

function sesionSuperadmin(cookieRol: 'vendedor' | 'superadmin' = 'superadmin') {
  const { cookie, csrf } = emitirSesion('Ana Solano', cookieRol, ID_SUPERADMIN);
  return { cookie: cookie.split(';')[0], csrf };
}
function sesionVendedor(cookieRol: 'vendedor' | 'superadmin' = 'vendedor') {
  const { cookie, csrf } = emitirSesion('Guillermo Rojas', cookieRol, ID_VENDEDOR);
  return { cookie: cookie.split(';')[0], csrf };
}

const ENTRADAS_BASE = [{ skuId: 'set-600-king', cantidad: 16 }];
function cotizacionConDescuento(pct: number) {
  return calcular(ENTRADAS_BASE, CATALOGO, { descuentoPersonalizado: { general: pct } });
}

function filaPendienteBase(extra: Partial<FilaCot> = {}): FilaCot {
  const cot = cotizacionConDescuento(20);
  return {
    id: UUID_COT1,
    estado: 'esperando_aprobacion',
    numero: 'COT-2026-0001',
    created_at: '2026-08-20T10:00:00.000Z',
    cliente: { nombre: 'Ana Pérez', empresa: 'Hotel Papagayo', email: 'ana@hotel.com' },
    lineas: cot.lineas,
    totales: {
      subtotal: cot.subtotal,
      ahorro: cot.ahorro,
      tasaIva: cot.tasaIva,
      iva: cot.iva,
      total: cot.total,
      bordadoEspecial: cot.bordadoEspecial,
    },
    descuento_personalizado: { general: 20 },
    solicitado_por: 'Guillermo Rojas',
    vendedor: 'Guillermo Rojas',
    contact_id: 'contacto-viejo',
    reemplaza_a: null,
    ...extra,
  };
}

beforeEach(() => {
  process.env.LUXE_SESION_SECRETO = 'secreta';
  cotizaciones = [filaPendienteBase()];
  usuarios = [
    { id: ID_SUPERADMIN, nombre: 'Ana Solano', correo: 'ana@luxeessentialscr.com', rol: 'superadmin', activo: true },
    { id: ID_VENDEDOR, nombre: 'Guillermo Rojas', correo: 'guillermo@luxeessentialscr.com', rol: 'vendedor', activo: true },
  ];
  vi.mocked(crearEstimate).mockClear();
  vi.mocked(crearEstimate).mockResolvedValue({ ok: true, estimateId: 'est-1', contactId: 'contacto-ghl-1' });
});

describe('POST /api/cotizacion/pendientes', () => {
  it('rechaza sin sesión (401)', async () => {
    const res = await postPendientes(peticion({}));
    expect(res.status).toBe(401);
  });

  it('rechaza (403) una sesión VÁLIDA cuyo rol en la base es "vendedor" -- aunque la cookie diga "superadmin"', async () => {
    // La cookie miente ("superadmin"), la base dice la verdad
    // ("vendedor") -- `autorizarSuperadmin` tiene que confiar en la base.
    const { cookie, csrf } = sesionVendedor('superadmin');
    const res = await postPendientes(peticion({}, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(403);
  });

  it('permite (200) a un superadmin de verdad, y sólo trae lo pendiente', async () => {
    cotizaciones.push(filaPendienteBase({ id: 'cot-2', estado: 'enviada' }));
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postPendientes(peticion({}, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.ok).toBe(true);
    expect(cuerpo.cotizaciones).toHaveLength(1);
    expect(cuerpo.cotizaciones[0].id).toBe(UUID_COT1);
  });

  it('no exige el token anti-CSRF (ruta de sólo lectura)', async () => {
    const { cookie } = sesionSuperadmin();
    const res = await postPendientes(peticion({}, { cookie }));
    expect(res.status).toBe(200);
  });
});

describe('POST /api/cotizacion/aprobar', () => {
  it('rechaza sin sesión (401)', async () => {
    const res = await postAprobar(peticion({ id: UUID_COT1 }));
    expect(res.status).toBe(401);
  });

  it('rechaza (401) una sesión válida sin el token anti-CSRF', async () => {
    const { cookie } = sesionSuperadmin();
    const res = await postAprobar(peticion({ id: UUID_COT1 }, { cookie }));
    expect(res.status).toBe(401);
  });

  it('rechaza (403) una sesión VÁLIDA cuyo rol en la base es "vendedor"', async () => {
    const { cookie, csrf } = sesionVendedor('superadmin');
    const res = await postAprobar(peticion({ id: UUID_COT1 }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(403);
    // Ni siquiera se llegó a mirar la cotización.
    expect(cotizaciones[0].estado).toBe('esperando_aprobacion');
    expect(crearEstimate).not.toHaveBeenCalled();
  });

  it('400 si el id no es un uuid válido', async () => {
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postAprobar(peticion({ id: 'no-es-un-uuid' }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(400);
  });

  it('404 si la cotización no existe', async () => {
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postAprobar(
      peticion({ id: 'aaaaaaaa-1111-4000-8000-000000000099' }, { cookie, 'x-csrf-token': csrf }),
    );
    expect(res.status).toBe(404);
  });

  it('409 si la cotización ya no está esperando aprobación', async () => {
    cotizaciones[0].estado = 'rechazada';
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postAprobar(peticion({ id: UUID_COT1 }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(409);
  });

  it('200: un superadmin de verdad aprueba tal cual, la fila queda enviada', async () => {
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postAprobar(peticion({ id: UUID_COT1 }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo).toMatchObject({ ok: true, numero: 'COT-2026-0001', estado: 'enviada', cambioPorcentaje: false });
    expect(cotizaciones[0].estado).toBe('enviada');
    expect(cotizaciones[0].aprobado_por).toBe('Ana Solano');
  });

  it('200: aprueba con un porcentaje distinto -- cambioPorcentaje en true y descuento_aprobado actualizado', async () => {
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postAprobar(
      peticion({ id: UUID_COT1, descuentoPersonalizado: { general: 12 } }, { cookie, 'x-csrf-token': csrf }),
    );
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.cambioPorcentaje).toBe(true);
    expect(cotizaciones[0].descuento_aprobado).toEqual({ general: 12 });
    expect(cotizaciones[0].descuento_personalizado).toEqual({ general: 20 });
  });

  it('400 si el descuento personalizado del cuerpo trae "general" y "familias" a la vez', async () => {
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postAprobar(
      peticion(
        { id: UUID_COT1, descuentoPersonalizado: { general: 12, familias: { toallas: 5 } } },
        { cookie, 'x-csrf-token': csrf },
      ),
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/cotizacion/rechazar', () => {
  it('rechaza sin sesión (401)', async () => {
    const res = await postRechazar(peticion({ id: UUID_COT1, motivo: 'no' }));
    expect(res.status).toBe(401);
  });

  it('rechaza (401) una sesión válida sin el token anti-CSRF', async () => {
    const { cookie } = sesionSuperadmin();
    const res = await postRechazar(peticion({ id: UUID_COT1, motivo: 'no' }, { cookie }));
    expect(res.status).toBe(401);
  });

  it('rechaza (403) una sesión VÁLIDA cuyo rol en la base es "vendedor"', async () => {
    const { cookie, csrf } = sesionVendedor('superadmin');
    const res = await postRechazar(peticion({ id: UUID_COT1, motivo: 'no' }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(403);
    expect(cotizaciones[0].estado).toBe('esperando_aprobacion');
  });

  it('400 si falta el motivo', async () => {
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postRechazar(peticion({ id: UUID_COT1 }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(400);
  });

  it('400 si el motivo es una cadena vacía', async () => {
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postRechazar(peticion({ id: UUID_COT1, motivo: '   ' }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(400);
  });

  it('404 si la cotización no existe', async () => {
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postRechazar(
      peticion({ id: 'aaaaaaaa-1111-4000-8000-000000000099', motivo: 'no' }, { cookie, 'x-csrf-token': csrf }),
    );
    expect(res.status).toBe(404);
  });

  it('409 si la cotización ya no está esperando aprobación', async () => {
    cotizaciones[0].estado = 'enviada';
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postRechazar(peticion({ id: UUID_COT1, motivo: 'no' }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(409);
  });

  it('200: un superadmin de verdad rechaza con motivo, la fila queda "rechazada"', async () => {
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postRechazar(
      peticion({ id: UUID_COT1, motivo: 'Margen insuficiente' }, { cookie, 'x-csrf-token': csrf }),
    );
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo).toMatchObject({ ok: true, numero: 'COT-2026-0001' });
    expect(cotizaciones[0].estado).toBe('rechazada');
    expect(cotizaciones[0].motivo_rechazo).toBe('Margen insuficiente');
    expect(cotizaciones[0].aprobado_por).toBe('Ana Solano');
    // Rechazar nunca dispara la cadena de envío.
    expect(crearEstimate).not.toHaveBeenCalled();
  });
});
