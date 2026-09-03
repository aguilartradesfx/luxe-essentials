import { describe, it, expect, vi, beforeEach } from 'vitest';
import { calcular } from '@/lib/cotizador/calcular';
import { CATALOGO } from '@/lib/cotizador/catalogo';

// Mismo criterio que tests/api-cotizacion.test.ts: se mockea sólo
// `crearEstimate` -- el resto de lib/cotizador/ghl.ts (notaDeCotizacion,
// constantes) queda real vía `importOriginal`.
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
// Este archivo prueba la ORQUESTACIÓN (qué se llama, con qué datos, cuándo
// se escribe qué) -- el CONTENIDO de los dos correos ya tiene su propia
// cobertura en tests/correo-aprobacion.test.ts. Mockear el módulo entero
// evita duplicar esa cobertura acá, mismo criterio que
// tests/equipo-api.test.ts con `@/lib/cotizador/correo-invitacion`.
vi.mock('@/lib/cotizador/correo-aprobacion', () => ({
  enviarSolicitudAprobacion: vi.fn().mockResolvedValue({ ok: true, resendId: 're_sol' }),
  enviarResolucionAprobacion: vi.fn().mockResolvedValue({ ok: true, resendId: 're_res' }),
}));

type Filtro = ['eq', string, unknown] | ['in', string, readonly string[]];

type FilaCot = {
  id: string;
  estado: string;
  numero: string;
  created_at: string;
  cliente: { nombre: string; empresa?: string; email: string };
  lineas: Array<Record<string, unknown>>;
  totales: { subtotal: number; ahorro: number; tasaIva: number; iva: number; total: number; bordadoEspecial: boolean };
  descuento_personalizado?: unknown;
  descuento_aprobado?: unknown;
  solicitado_por: string | null;
  vendedor?: string | null;
  aprobado_por?: string | null;
  resuelto_at?: string | null;
  motivo_rechazo?: string | null;
  contact_id: string | null;
  reemplaza_a: string | null;
  reemplaza_a_numero?: string | null;
  reemplazada_por?: string | null;
  reemplazada_por_numero?: string | null;
  pdf_ruta?: string | null;
  correo_error?: string | null;
  ghl_error?: string | null;
  ghl_estimate_id?: string | null;
};

type FilaUsuario = { id: string; nombre: string; correo: string; rol: 'vendedor' | 'superadmin'; activo: boolean };

let cotizaciones: FilaCot[];
let usuarios: FilaUsuario[];

function coincideFiltro(fila: Record<string, unknown>, f: Filtro): boolean {
  if (f[0] === 'eq') return fila[f[1]] === f[2];
  return (f[2] as readonly string[]).includes(fila[f[1]] as string);
}
function coincideTodos(fila: Record<string, unknown>, filtros: Filtro[]): boolean {
  return filtros.every((f) => coincideFiltro(fila, f));
}

function nodoSelect(tabla: FilaCot[] | FilaUsuario[]): any {
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
      const m = (tabla as Array<Record<string, unknown>>).filter((f) => coincideTodos(f, filtros));
      return { data: m[0] ? { ...m[0] } : null, error: null };
    },
    then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
      let m = (tabla as Array<Record<string, unknown>>).filter((f) => coincideTodos(f, filtros));
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

// Todos los filtros que llegaron a CUALQUIER `update` sobre 'cotizaciones',
// en orden -- mismo propósito que `filtrosUpdate` en
// tests/api-cotizacion.test.ts: sin esto, borrar el
// `.eq('estado', ESTADO_PENDIENTE)` del compare-and-swap de `aprobar`/
// `rechazar` deja esta suite en verde igual (el resto de las pruebas de
// estado incorrecto ya cortan ANTES, en la relectura inicial de `aprobar` --
// un doble de un solo hilo no puede demostrar la carrera de dos superadmin
// aprobando a la vez, así que lo único que queda para anclar que el filtro
// SIGUE ahí es comprobar que se lo pasó).
let filtrosUpdateCot: Filtro[] = [];

function nodoUpdateCot(cambios: Record<string, unknown>): any {
  const filtros: Filtro[] = [];
  const nodo: any = {
    eq(c: string, v: unknown) {
      filtros.push(['eq', c, v]);
      filtrosUpdateCot.push(['eq', c, v]);
      return nodo;
    },
    in(c: string, v: readonly string[]) {
      filtros.push(['in', c, v]);
      filtrosUpdateCot.push(['in', c, v]);
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
        return { select: () => nodoSelect(usuarios) };
      }
      return {
        select: () => nodoSelect(cotizaciones),
        update: (cambios: Record<string, unknown>) => nodoUpdateCot(cambios),
      };
    },
  }),
}));

const { listarPendientes, aprobar, rechazar, descuentosIguales, avisarSolicitudAprobacion } = await import(
  '@/lib/cotizador/aprobacion'
);
const { crearEstimate } = await import('@/lib/cotizador/ghl');
const { enviarCotizacion } = await import('@/lib/cotizador/correo');
const { guardarPdf } = await import('@/lib/cotizador/almacen');
const { enviarSolicitudAprobacion: mockSolicitud, enviarResolucionAprobacion: mockResolucion } = await import(
  '@/lib/cotizador/correo-aprobacion'
);
const { supabaseAdmin } = await import('@/lib/supabase/server');

const deps = { apiKey: 'llave', remitente: 'Luxe Essentials <cotizaciones@luxe.cr>' };
const ENTRADAS_BASE = [{ skuId: 'set-600-king', cantidad: 16 }];

function cotizacionConDescuento(pct: number) {
  return calcular(ENTRADAS_BASE, CATALOGO, { descuentoPersonalizado: { general: pct } });
}

function filaPendienteBase(extra: Partial<FilaCot> = {}): FilaCot {
  const cot = cotizacionConDescuento(20);
  return {
    id: 'cot-1',
    estado: 'esperando_aprobacion',
    numero: 'COT-2026-0001',
    created_at: '2026-08-20T10:00:00.000Z',
    cliente: { nombre: 'Ana Pérez', empresa: 'Hotel Papagayo', email: 'ana@hotel.com' },
    lineas: cot.lineas as unknown as Array<Record<string, unknown>>,
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
  filtrosUpdateCot = [];
  cotizaciones = [filaPendienteBase()];
  usuarios = [
    { id: 'u-1', nombre: 'Ana Solano', correo: 'ana@luxeessentialscr.com', rol: 'superadmin', activo: true },
    { id: 'u-2', nombre: 'Beto Vindas', correo: 'beto@luxeessentialscr.com', rol: 'superadmin', activo: true },
    { id: 'u-3', nombre: 'Superadmin Baja', correo: 'baja@luxeessentialscr.com', rol: 'superadmin', activo: false },
    { id: 'u-4', nombre: 'Guillermo Rojas', correo: 'guillermo@luxeessentialscr.com', rol: 'vendedor', activo: true },
  ];
  vi.mocked(crearEstimate).mockClear();
  vi.mocked(crearEstimate).mockResolvedValue({ ok: true, estimateId: 'est-1', contactId: 'contacto-ghl-1' });
  vi.mocked(enviarCotizacion).mockClear();
  vi.mocked(enviarCotizacion).mockResolvedValue({ ok: true, resendId: 're_1' });
  vi.mocked(guardarPdf).mockClear();
  vi.mocked(guardarPdf).mockResolvedValue({ ok: true, ruta: '2026/COT-1-abc.pdf' });
  vi.mocked(mockSolicitud).mockClear();
  vi.mocked(mockSolicitud).mockResolvedValue({ ok: true, resendId: 're_sol' });
  vi.mocked(mockResolucion).mockClear();
  vi.mocked(mockResolucion).mockResolvedValue({ ok: true, resendId: 're_res' });
});

describe('descuentosIguales', () => {
  it('dos generales con el mismo número son iguales', () => {
    expect(descuentosIguales({ general: 20 }, { general: 20 })).toBe(true);
  });
  it('dos generales con distinto número NO son iguales', () => {
    expect(descuentosIguales({ general: 20 }, { general: 12 })).toBe(false);
  });
  it('general vs familias NUNCA son iguales, aunque coincida algún número', () => {
    expect(descuentosIguales({ general: 20 }, { familias: { toallas: 20 } })).toBe(false);
  });
  it('mismas familias con los mismos porcentajes son iguales, sin importar el orden de las claves', () => {
    expect(
      descuentosIguales({ familias: { toallas: 10, bata: 5 } }, { familias: { bata: 5, toallas: 10 } }),
    ).toBe(true);
  });
  it('mismas claves con un porcentaje distinto NO son iguales', () => {
    expect(
      descuentosIguales({ familias: { toallas: 10, bata: 5 } }, { familias: { bata: 5, toallas: 11 } }),
    ).toBe(false);
  });
  it('distinta cantidad de familias NO son iguales, aunque las que coinciden calcen', () => {
    expect(
      descuentosIguales({ familias: { toallas: 10 } }, { familias: { toallas: 10, bata: 5 } }),
    ).toBe(false);
  });
});

describe('listarPendientes', () => {
  it('trae sólo las filas en "esperando_aprobacion"', async () => {
    cotizaciones.push(filaPendienteBase({ id: 'cot-2', estado: 'enviada' }));
    cotizaciones.push(filaPendienteBase({ id: 'cot-3', estado: 'rechazada' }));
    const r = await listarPendientes(supabaseAdmin());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.cotizaciones).toHaveLength(1);
      expect(r.cotizaciones[0].id).toBe('cot-1');
    }
  });

  it('ordena la más vieja primero (cuánto lleva esperando)', async () => {
    cotizaciones = [
      filaPendienteBase({ id: 'nueva', created_at: '2026-08-25T00:00:00.000Z' }),
      filaPendienteBase({ id: 'vieja', created_at: '2026-08-10T00:00:00.000Z' }),
    ];
    const r = await listarPendientes(supabaseAdmin());
    if (r.ok) {
      expect(r.cotizaciones.map((c) => c.id)).toEqual(['vieja', 'nueva']);
    }
  });
});

describe('aprobar', () => {
  it('rechaza (no_encontrado) un id que no existe', async () => {
    const r = await aprobar(supabaseAdmin(), deps, { id: 'fantasma', aprobador: 'Ana Solano' });
    expect(r).toEqual({ ok: false, motivo: 'no_encontrado' });
  });

  it('no alcanza con confiar en el navegador: rechaza (no_pendiente) una fila que ya no está esperando', async () => {
    cotizaciones[0].estado = 'rechazada';
    const r = await aprobar(supabaseAdmin(), deps, { id: 'cot-1', aprobador: 'Ana Solano' });
    expect(r.ok).toBe(false);
    if (!r.ok && r.motivo === 'no_pendiente') expect(r.estadoActual).not.toBe('esperando_aprobacion');
    // Nada de la cadena de envío corrió.
    expect(crearEstimate).not.toHaveBeenCalled();
  });

  it('aprobada tal cual: deja la fila en "enviada", con aprobado_por y descuento_aprobado igual al pedido', async () => {
    const r = await aprobar(supabaseAdmin(), deps, { id: 'cot-1', aprobador: 'Ana Solano' });
    expect(r).toMatchObject({ ok: true, numero: 'COT-2026-0001', estadoFinal: 'enviada', cambioPorcentaje: false });
    const fila = cotizaciones[0];
    expect(fila.estado).toBe('enviada');
    expect(fila.aprobado_por).toBe('Ana Solano');
    expect(fila.resuelto_at).toBeTruthy();
    expect(fila.descuento_aprobado).toEqual({ general: 20 });
  });

  // El caso central del diseño: cambiar el porcentaje antes de aprobar.
  it('aprobada con un porcentaje distinto: recalcula con el nuevo % y lo guarda en descuento_aprobado, sin tocar descuento_personalizado (lo pedido)', async () => {
    const r = await aprobar(supabaseAdmin(), deps, {
      id: 'cot-1',
      aprobador: 'Ana Solano',
      nuevoDescuento: { general: 12 },
    });
    expect(r).toMatchObject({ ok: true, cambioPorcentaje: true });
    const fila = cotizaciones[0];
    expect(fila.descuento_personalizado).toEqual({ general: 20 }); // lo pedido, intacto
    expect(fila.descuento_aprobado).toEqual({ general: 12 }); // lo concedido

    // La cotización que de verdad salió al hotel usa el 12%, no el 20%
    // pedido -- se comprueba mirando el total que le llegó a crearEstimate.
    const esperado12 = cotizacionConDescuento(12);
    const [params] = vi.mocked(crearEstimate).mock.calls[0];
    expect(params.cotizacion.total).toBe(esperado12.total);
    expect(params.cotizacion.total).not.toBe(cotizacionConDescuento(20).total);
  });

  it('manda el aviso de resolución con cambioPorcentaje=true y los dos descuentos cuando el % cambió', async () => {
    await aprobar(supabaseAdmin(), deps, { id: 'cot-1', aprobador: 'Ana Solano', nuevoDescuento: { general: 12 } });
    expect(mockResolucion).toHaveBeenCalledWith(
      expect.objectContaining({
        para: 'guillermo@luxeessentialscr.com',
        resultado: 'aprobada',
        descuentoPedido: { general: 20 },
        descuentoAprobado: { general: 12 },
        cambioPorcentaje: true,
        resueltoPor: 'Ana Solano',
      }),
      deps,
    );
  });

  it('manda el aviso de resolución con cambioPorcentaje=false cuando se aprobó tal cual', async () => {
    await aprobar(supabaseAdmin(), deps, { id: 'cot-1', aprobador: 'Ana Solano' });
    expect(mockResolucion).toHaveBeenCalledWith(
      expect.objectContaining({ cambioPorcentaje: false, descuentoAprobado: { general: 20 } }),
      deps,
    );
  });

  it('si no se encuentra el correo de quien pidió la cotización, el aviso no sale pero la aprobación igual queda "ok"', async () => {
    cotizaciones[0].solicitado_por = 'Nadie En El Equipo';
    const r = await aprobar(supabaseAdmin(), deps, { id: 'cot-1', aprobador: 'Ana Solano' });
    expect(r).toMatchObject({ ok: true, avisoEnviado: false });
    expect(mockResolucion).not.toHaveBeenCalled();
    // Pero la cotización SÍ salió al cliente -- el aviso interno fallando
    // no debe tumbar el envío real.
    expect(cotizaciones[0].estado).toBe('enviada');
  });

  it('estadoFinal es "error" y avisoEnviado sigue funcionando cuando el correo al cliente falla', async () => {
    vi.mocked(enviarCotizacion).mockResolvedValueOnce({ ok: false, error: 'dominio no verificado' });
    const r = await aprobar(supabaseAdmin(), deps, { id: 'cot-1', aprobador: 'Ana Solano' });
    expect(r).toMatchObject({ ok: true, estadoFinal: 'error' });
    expect(cotizaciones[0].estado).toBe('error');
    expect(cotizaciones[0].correo_error).toBe('dominio no verificado');
  });

  // No hay forma de simular en JavaScript de un solo hilo la carrera real
  // que este filtro cierra (dos superadmin aprobando la misma fila casi al
  // mismo tiempo) -- mismo límite reconocido, por el mismo motivo, en
  // tests/equipo-api.test.ts para la rpc de cambiar estado. Lo que SÍ se
  // puede anclar sobre código de producción es que el filtro se sigue
  // pasando: si algún refactor lo borra, la reclamación pasaría a aplicar
  // sin condición de estado, reabriendo exactamente esa carrera.
  it('reclama la fila con un compare-and-swap: el update de la reclamación filtra por id Y por estado', async () => {
    await aprobar(supabaseAdmin(), deps, { id: 'cot-1', aprobador: 'Ana Solano' });
    expect(filtrosUpdateCot).toContainEqual(['eq', 'id', 'cot-1']);
    expect(filtrosUpdateCot).toContainEqual(['eq', 'estado', 'esperando_aprobacion']);
  });

  it('usa el contact_id ya guardado en la fila como contactId de entrada', async () => {
    await aprobar(supabaseAdmin(), deps, { id: 'cot-1', aprobador: 'Ana Solano' });
    const [params] = vi.mocked(crearEstimate).mock.calls[0];
    expect(params.contactId).toBe('contacto-viejo');
  });

  it('"Modificar": marca la cotización vieja como reemplazada cuando el envío sale bien', async () => {
    cotizaciones.push({
      ...filaPendienteBase({ id: 'vieja', estado: 'enviada', numero: 'COT-2026-0007' }),
    });
    cotizaciones[0].reemplaza_a = 'vieja';
    await aprobar(supabaseAdmin(), deps, { id: 'cot-1', aprobador: 'Ana Solano' });
    const vieja = cotizaciones.find((f) => f.id === 'vieja')!;
    expect(vieja.estado).toBe('reemplazada');
    expect(vieja.reemplazada_por).toBe('cot-1');
  });

  it('"Modificar": si el correo de la nueva falla, la vieja NO se marca reemplazada', async () => {
    cotizaciones.push({
      ...filaPendienteBase({ id: 'vieja', estado: 'enviada', numero: 'COT-2026-0007' }),
    });
    cotizaciones[0].reemplaza_a = 'vieja';
    vi.mocked(enviarCotizacion).mockResolvedValueOnce({ ok: false, error: 'Resend 500' });
    await aprobar(supabaseAdmin(), deps, { id: 'cot-1', aprobador: 'Ana Solano' });
    const vieja = cotizaciones.find((f) => f.id === 'vieja')!;
    expect(vieja.estado).toBe('enviada');
  });
});

describe('rechazar', () => {
  it('rechaza (no_encontrado) un id que no existe', async () => {
    const r = await rechazar(supabaseAdmin(), deps, { id: 'fantasma', aprobador: 'Ana Solano', motivo: 'no' });
    expect(r).toEqual({ ok: false, motivo: 'no_encontrado' });
  });

  it('no alcanza con confiar en el navegador: rechaza (no_pendiente) una fila que ya no está esperando, sin escribir nada', async () => {
    cotizaciones[0].estado = 'enviada';
    const r = await rechazar(supabaseAdmin(), deps, { id: 'cot-1', aprobador: 'Ana Solano', motivo: 'tarde' });
    expect(r.ok).toBe(false);
    expect(cotizaciones[0].motivo_rechazo).toBeUndefined();
    expect(mockResolucion).not.toHaveBeenCalled();
  });

  it('marca la fila "rechazada" con aprobado_por, resuelto_at y motivo_rechazo', async () => {
    const r = await rechazar(supabaseAdmin(), deps, {
      id: 'cot-1',
      aprobador: 'Ana Solano',
      motivo: 'Margen insuficiente',
    });
    expect(r).toEqual({ ok: true, numero: 'COT-2026-0001', avisoEnviado: true });
    const fila = cotizaciones[0];
    expect(fila.estado).toBe('rechazada');
    expect(fila.aprobado_por).toBe('Ana Solano');
    expect(fila.resuelto_at).toBeTruthy();
    expect(fila.motivo_rechazo).toBe('Margen insuficiente');
  });

  it('el update que rechaza es un compare-and-swap: filtra por id Y por estado esperando_aprobacion', async () => {
    await rechazar(supabaseAdmin(), deps, { id: 'cot-1', aprobador: 'Ana Solano', motivo: 'no' });
    expect(filtrosUpdateCot).toContainEqual(['eq', 'id', 'cot-1']);
    expect(filtrosUpdateCot).toContainEqual(['eq', 'estado', 'esperando_aprobacion']);
  });

  it('rechazar nunca dispara la cadena de envío (ni GoHighLevel ni el correo al cliente)', async () => {
    await rechazar(supabaseAdmin(), deps, { id: 'cot-1', aprobador: 'Ana Solano', motivo: 'no' });
    expect(crearEstimate).not.toHaveBeenCalled();
    expect(enviarCotizacion).not.toHaveBeenCalled();
  });

  it('manda el aviso de resolución con el motivo y resultado "rechazada"', async () => {
    await rechazar(supabaseAdmin(), deps, { id: 'cot-1', aprobador: 'Ana Solano', motivo: 'Margen insuficiente' });
    expect(mockResolucion).toHaveBeenCalledWith(
      expect.objectContaining({
        para: 'guillermo@luxeessentialscr.com',
        resultado: 'rechazada',
        motivoRechazo: 'Margen insuficiente',
        resueltoPor: 'Ana Solano',
      }),
      deps,
    );
  });

  it('no rompe si no se encuentra el correo del vendedor: la operación igual queda "ok"', async () => {
    cotizaciones[0].solicitado_por = 'Nadie En El Equipo';
    const r = await rechazar(supabaseAdmin(), deps, { id: 'cot-1', aprobador: 'Ana Solano', motivo: 'no' });
    expect(r).toMatchObject({ ok: true, avisoEnviado: false });
    expect(cotizaciones[0].estado).toBe('rechazada');
  });
});

describe('avisarSolicitudAprobacion', () => {
  it('manda a los superadmin ACTIVOS, nunca a uno desactivado ni a un vendedor', async () => {
    await avisarSolicitudAprobacion(supabaseAdmin(), deps, {
      numero: 'COT-2026-0001',
      cliente: { nombre: 'Ana', email: 'a@a.com' },
      total: 1000,
      descuentoPedido: { general: 20 },
      solicitadoPor: 'Guillermo Rojas',
    });
    expect(mockSolicitud).toHaveBeenCalledWith(
      expect.objectContaining({
        para: expect.arrayContaining(['ana@luxeessentialscr.com', 'beto@luxeessentialscr.com']),
      }),
      deps,
    );
    const [params] = vi.mocked(mockSolicitud).mock.calls[0];
    expect(params.para).not.toContain('baja@luxeessentialscr.com');
    expect(params.para).not.toContain('guillermo@luxeessentialscr.com');
  });

  it('si no hay ningún superadmin activo, no llama a Resend y devuelve un error', async () => {
    usuarios = usuarios.map((u) => ({ ...u, activo: u.rol === 'superadmin' ? false : u.activo }));
    const r = await avisarSolicitudAprobacion(supabaseAdmin(), deps, {
      numero: 'COT-2026-0001',
      cliente: { nombre: 'Ana', email: 'a@a.com' },
      total: 1000,
      descuentoPedido: { general: 20 },
      solicitadoPor: 'Guillermo Rojas',
    });
    expect(r.ok).toBe(false);
    expect(mockSolicitud).not.toHaveBeenCalled();
  });
});
