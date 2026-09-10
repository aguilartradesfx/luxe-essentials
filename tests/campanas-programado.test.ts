// tests/campanas-programado.test.ts
//
// El envío programado de la bandeja de campañas (lib/campanas/programado.ts):
// el cron diario que reemplaza el bucle del navegador. Cubre las cinco
// garantías del encargo, cada una con su propia sección:
//   1. La rampa (25/25/50/50/75/100/100...) -- `topeParaDia`.
//   2. El tope de 100 nunca se pasa.
//   3. Nadie recibe el correo inicial dos veces.
//   4. Un reintento del cron el mismo día no duplica el cupo.
//   5. El interruptor de apagado.
//
// NUNCA se llama a Resend ni a GoHighLevel de verdad: `fetchImpl` va
// siempre inyectado, apuntando a dobles en memoria.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ORDEN_ZONAS_PROGRAMADO,
  MARCADOR_CAMPANA_PROGRAMADA,
  topeParaDia,
  diaDeRampa,
  reservarCupoDiario,
  estaPausado,
  estadoProgramado,
  establecerPausado,
  resolverObjetivo,
  ejecutarEnvioProgramado,
} from '@/lib/campanas/programado';
import { ZONAS_COMERCIALES } from '@/lib/campanas/contactos';
import { TAMANO_TANDA } from '@/lib/campanas/envio';

// =======================================================================
// Un doble en memoria de Supabase que entiende las pocas formas de consulta
// que este módulo (y los que llama: crearCampana, enviarTanda,
// progresoCampana, filtrarPermitidosParaCampana) necesitan: select/eq/in/lt
// encadenados, maybeSingle, insert/upsert/update, y las tres rpc en juego.
// Un solo doble genérico, compartido por todas las pruebas de este
// archivo, en vez de uno ad hoc por prueba -- acá se paga esa complejidad
// UNA vez porque `resolverObjetivo`/`ejecutarEnvioProgramado` combinan
// cinco tablas distintas en una sola llamada.
type Fila = Record<string, any>;

function coincide(fila: Fila, filtros: Array<['eq' | 'in' | 'lt', string, unknown]>): boolean {
  return filtros.every(([tipo, campo, valor]) => {
    if (tipo === 'eq') return fila[campo] === valor;
    if (tipo === 'in') return (valor as unknown[]).includes(fila[campo]);
    return fila[campo] < (valor as any); // 'lt'
  });
}

function proyectar(fila: Fila, columnas: string[] | null): Fila {
  if (!columnas) return { ...fila };
  return Object.fromEntries(columnas.map((c) => [c, fila[c]]));
}

function nodoLectura(filas: Fila[]) {
  const filtros: Array<['eq' | 'in' | 'lt', string, unknown]> = [];
  let columnas: string[] | null = null;
  let conteoHead = false;

  function resolver() {
    const encontradas = filas.filter((f) => coincide(f, filtros));
    if (conteoHead) return { count: encontradas.length, data: null, error: null };
    return { data: encontradas.map((f) => proyectar(f, columnas)), error: null };
  }

  const nodo: any = {
    select(campos?: string, opciones?: { count?: string; head?: boolean }) {
      columnas = campos ? campos.split(',').map((c) => c.trim()) : null;
      conteoHead = Boolean(opciones?.head);
      return nodo;
    },
    eq(campo: string, valor: unknown) {
      filtros.push(['eq', campo, valor]);
      return nodo;
    },
    in(campo: string, valores: unknown[]) {
      filtros.push(['in', campo, valores]);
      return nodo;
    },
    lt(campo: string, valor: unknown) {
      filtros.push(['lt', campo, valor]);
      return nodo;
    },
    maybeSingle: async () => {
      const r = resolver();
      const lista = (r.data ?? []) as Fila[];
      return { data: lista[0] ?? null, error: null };
    },
    then: (resolve: any, reject: any) => Promise.resolve(resolver()).then(resolve, reject),
  };
  return nodo;
}

function crearDbFake(seed: {
  campanas?: Fila[];
  campanas_envios?: Fila[];
  bajas_correo?: Fila[];
  campanas_programado_config?: Fila[];
  campanas_envio_diario?: Fila[];
} = {}) {
  const estado: Record<string, Fila[]> = {
    campanas: seed.campanas ?? [],
    campanas_envios: seed.campanas_envios ?? [],
    bajas_correo: seed.bajas_correo ?? [],
    campanas_programado_config: seed.campanas_programado_config ?? [],
    campanas_envio_diario: seed.campanas_envio_diario ?? [],
  };
  const contadores: Record<string, number> = {};
  function siguienteId(tabla: string) {
    contadores[tabla] = (contadores[tabla] ?? 0) + 1;
    return `${tabla}-${contadores[tabla]}`;
  }

  // Mismos `default` que la migración 0019 (`campanas_envios.estado`) --
  // sin esto, una fila creada por `upsert` (crearCampana) no tendría
  // `estado` y `campanas_reclamar_pendientes` (más abajo) nunca la
  // encontraría, porque filtra por `estado === 'pendiente'` literal.
  const DEFAULTS: Record<string, Fila> = {
    campanas_envios: { estado: 'pendiente', resend_id: null, error: null, actualizado_at: null },
  };

  function tabla(nombre: string) {
    const filas = estado[nombre];
    if (!filas) throw new Error(`tabla no mockeada en esta prueba: ${nombre}`);
    return {
      select: (...args: any[]) => nodoLectura(filas).select(...args),
      insert: (payload: Fila | Fila[]) => {
        const nuevos = (Array.isArray(payload) ? payload : [payload]).map((f) => ({
          ...DEFAULTS[nombre],
          id: siguienteId(nombre),
          ...f,
        }));
        filas.push(...nuevos);
        return {
          select: (campos?: string) => {
            const columnas = campos ? campos.split(',').map((c) => c.trim()) : null;
            const proyectadas = nuevos.map((f) => proyectar(f, columnas));
            return {
              single: async () => ({ data: proyectadas[0] ?? null, error: null }),
              then: (resolve: any) => Promise.resolve({ data: proyectadas, error: null }).then(resolve),
            };
          },
        };
      },
      upsert: (payload: Fila[], opciones: { onConflict?: string; ignoreDuplicates?: boolean } = {}) => {
        const claveDe = (f: Fila) =>
          (opciones.onConflict ?? '').split(',').map((c) => f[c.trim()]).join('|');
        const existentes = new Set(filas.map(claveDe));
        const insertadas: Fila[] = [];
        for (const f of payload) {
          const k = claveDe(f);
          if (opciones.ignoreDuplicates && (existentes.has(k) || insertadas.some((i) => claveDe(i) === k))) continue;
          const nueva = { ...DEFAULTS[nombre], id: siguienteId(nombre), ...f };
          filas.push(nueva);
          insertadas.push(nueva);
        }
        return {
          select: (campos?: string) => {
            const columnas = campos ? campos.split(',').map((c) => c.trim()) : null;
            const proyectadas = insertadas.map((f) => proyectar(f, columnas));
            return { then: (resolve: any) => Promise.resolve({ data: proyectadas, error: null }).then(resolve) };
          },
        };
      },
      update: (cambios: Fila) => ({
        eq: async (campo: string, valor: unknown) => {
          for (const f of filas) if (f[campo] === valor) Object.assign(f, cambios);
          return { data: null, error: null };
        },
      }),
    };
  }

  const rpc = vi.fn(async (nombre: string, args: Record<string, unknown>) => {
    if (nombre === 'campanas_reservar_cupo_diario') {
      const p_fecha = args.p_fecha as string;
      const p_tope = args.p_tope as number;
      const p_solicitado = args.p_solicitado as number;
      if (p_solicitado <= 0) return { data: 0, error: null };
      let fila = estado.campanas_envio_diario.find((f) => f.fecha === p_fecha);
      if (!fila) {
        fila = { fecha: p_fecha, tope: Math.max(0, p_tope), enviados: 0 };
        estado.campanas_envio_diario.push(fila);
      }
      const reserva = Math.max(0, Math.min(p_solicitado, fila.tope - fila.enviados));
      fila.enviados += reserva;
      return { data: reserva, error: null };
    }
    if (nombre === 'campanas_reclamar_pendientes') {
      const limite = args.p_limite as number;
      const pendientes = estado.campanas_envios.filter(
        (e) => e.campana_id === args.p_campana_id && e.estado === 'pendiente',
      );
      const reclamadas = pendientes.slice(0, limite);
      for (const f of reclamadas) f.actualizado_at = new Date().toISOString();
      return { data: reclamadas, error: null };
    }
    if (nombre === 'campanas_cerrar_tanda') {
      const resultados = args.p_resultados as Array<{
        id: string;
        estado: string;
        resend_id: string | null;
        error: string | null;
        actualizado_at: string;
      }>;
      for (const r of resultados) {
        const fila = estado.campanas_envios.find((e) => e.id === r.id);
        if (fila) Object.assign(fila, { estado: r.estado, resend_id: r.resend_id, error: r.error, actualizado_at: r.actualizado_at });
      }
      return { data: resultados.length, error: null };
    }
    throw new Error(`rpc no soportada en esta prueba: ${nombre}`);
  });

  return { from: (t: string) => tabla(t), rpc, estado };
}

function respuestaResend(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as unknown as Response;
}

// Un solo `fetchImpl` que responde tanto a GHL (`contactosPorZona`) como a
// Resend (`enviarTanda`) -- exactamente como en producción es el MISMO
// `fetch` global el que hace las dos cosas. Discrimina por URL.
function fetchImplCombinado(porZona: Record<string, Array<{ id: string; firstName: string; email: string }>>) {
  return vi.fn(async (url: any, init: any) => {
    const urlStr = String(url);
    if (urlStr.includes('resend.com')) {
      const payload = JSON.parse((init?.body as string) ?? '[]') as unknown[];
      return respuestaResend({ data: payload.map((_, i) => ({ id: `resend-${i}-${Math.random()}` })) });
    }
    const cuerpo = JSON.parse((init?.body as string) ?? '{}');
    const zona = cuerpo.filters?.[0]?.value as string;
    const contactos = porZona[zona] ?? [];
    return { ok: true, status: 200, text: async () => JSON.stringify({ contacts: contactos }) } as unknown as Response;
  });
}

function contacto(n: number, email: string | null = null) {
  return { id: `ghl-${n}`, firstName: `Hotel ${n}`, email: email ?? `hotel${n}@correo.cr` };
}

const depsBase = {
  resendApiKey: 'llave-resend',
  remitente: 'Luxe <campanas@send.luxeessentialscr.com>',
  apiKey: 'llave-ghl',
  locationId: 'loc-1',
};

beforeEach(() => {
  process.env.LUXE_BAJA_SECRETO = 'secreta-baja';
});

// =======================================================================
// 0) Orden de zonas.
describe('ORDEN_ZONAS_PROGRAMADO', () => {
  it('tiene exactamente las trece zonas de ZONAS_COMERCIALES, sin repetir ni faltar ninguna', () => {
    expect(new Set(ORDEN_ZONAS_PROGRAMADO)).toEqual(new Set(ZONAS_COMERCIALES));
    expect(ORDEN_ZONAS_PROGRAMADO.length).toBe(ZONAS_COMERCIALES.length);
  });

  it('va de la más chica a la más grande (direcciones únicas medidas contra el CRM), con Revisión manual al final', () => {
    expect([...ORDEN_ZONAS_PROGRAMADO]).toEqual([
      'Guanacaste Interior',
      'Caribe',
      'Heredia / Norte GAM',
      'Península Nicoya',
      'Zona Norte',
      'GAM Centro',
      'Pacífico Central',
      'Alajuela / Occidente',
      'GAM Este / Cartago',
      'Pacífico Sur',
      'Guanacaste Costa',
      'GAM Oeste',
      'Revisión manual',
    ]);
    expect(ORDEN_ZONAS_PROGRAMADO[ORDEN_ZONAS_PROGRAMADO.length - 1]).toBe('Revisión manual');
  });
});

// =======================================================================
// 1) La rampa -- garantía 1, y la mitad de la 2 (el tope de 100).
describe('topeParaDia', () => {
  it.each([
    [1, 25],
    [2, 25],
    [3, 50],
    [4, 50],
    [5, 75],
    [6, 100],
    [7, 100],
    [30, 100],
    [1000, 100],
  ])('día %i -> tope %i', (dia, esperado) => {
    expect(topeParaDia(dia)).toBe(esperado);
  });

  // Defensivo: un día 0 o negativo (no debería ocurrir -- `diaDeRampa`
  // siempre devuelve >= 1) se trata como día 1, nunca revienta ni da un
  // tope mayor por accidente.
  it('un día 0 o negativo se acota a día 1 (tope 25)', () => {
    expect(topeParaDia(0)).toBe(25);
    expect(topeParaDia(-5)).toBe(25);
  });

  // El tope de 100 es DURO -- ningún día, por grande que sea, da más.
  it('nunca devuelve más de 100', () => {
    for (const dia of [6, 10, 50, 365, 10000]) {
      expect(topeParaDia(dia)).toBeLessThanOrEqual(100);
    }
  });
});

describe('diaDeRampa', () => {
  it('sin ninguna fila previa, es el día 1', async () => {
    const db = crearDbFake();
    await expect(diaDeRampa(db as any, '2026-09-09')).resolves.toBe(1);
  });

  it('con N fechas previas a hoy, es el día N+1', async () => {
    const db = crearDbFake({
      campanas_envio_diario: [
        { fecha: '2026-09-01', tope: 25, enviados: 25 },
        { fecha: '2026-09-02', tope: 25, enviados: 10 },
        { fecha: '2026-09-03', tope: 50, enviados: 0 },
      ],
    });
    await expect(diaDeRampa(db as any, '2026-09-04')).resolves.toBe(4);
  });

  // Sólo cuenta lo ESTRICTAMENTE anterior a hoy -- una fila de HOY mismo
  // (un reintento que ya creó la fila) no suma un día extra.
  it('no cuenta la fila de HOY -- sólo días previos', async () => {
    const db = crearDbFake({ campanas_envio_diario: [{ fecha: '2026-09-09', tope: 25, enviados: 5 }] });
    await expect(diaDeRampa(db as any, '2026-09-09')).resolves.toBe(1);
  });
});

describe('reservarCupoDiario', () => {
  it('reserva el tope del día correspondiente', async () => {
    const db = crearDbFake();
    await expect(reservarCupoDiario(db as any, '2026-09-09', 100)).resolves.toBe(25); // día 1
  });

  it('solicitado <= 0 devuelve 0 sin llamar al rpc', async () => {
    const db = crearDbFake();
    await expect(reservarCupoDiario(db as any, '2026-09-09', 0)).resolves.toBe(0);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  // Garantía 4 -- el corazón de "un reintento no duplica el cupo": DOS
  // llamadas independientes (simulando dos invocaciones del cron el mismo
  // día) comparten el MISMO estado -- la segunda ve lo que ya reservó la
  // primera, nunca parte de cero.
  it('dos llamadas el mismo día comparten el cupo -- la segunda ve lo que ya reservó la primera', async () => {
    const db = crearDbFake({ campanas_envio_diario: [{ fecha: '2026-09-09', tope: 100, enviados: 0 }] }); // día 6+
    const primera = await reservarCupoDiario(db as any, '2026-09-09', 60);
    const segunda = await reservarCupoDiario(db as any, '2026-09-09', 60);
    expect(primera).toBe(60);
    expect(segunda).toBe(40); // sólo quedaban 40 de los 100.
    expect(primera + segunda).toBeLessThanOrEqual(100);
  });

  // Mismo escenario, pero con la rampa en 25 (día 1): la SUMA de dos
  // llamadas nunca pasa de 25, sin importar cuánto pidan juntas.
  it('el tope del día nunca se pasa aunque dos llamadas pidan de más', async () => {
    const db = crearDbFake();
    const primera = await reservarCupoDiario(db as any, '2026-09-09', 20);
    const segunda = await reservarCupoDiario(db as any, '2026-09-09', 20);
    expect(primera).toBe(20);
    expect(segunda).toBe(5); // sólo quedaban 5 de los 25 del día 1.
    expect(primera + segunda).toBe(25);
  });

  it('cada fecha tiene su propio cupo -- lo gastado un día no resta al siguiente', async () => {
    const db = crearDbFake({ campanas_envio_diario: [{ fecha: '2026-09-09', tope: 25, enviados: 25 }] });
    // Hoy (09) ya no queda nada...
    await expect(reservarCupoDiario(db as any, '2026-09-09', 10)).resolves.toBe(0);
    // ...pero MAÑANA es un día nuevo con su propio tope (día 2 -> 25).
    await expect(reservarCupoDiario(db as any, '2026-09-10', 10)).resolves.toBe(10);
  });
});

// =======================================================================
// 5) El interruptor.
describe('estaPausado / estadoProgramado / establecerPausado', () => {
  it('estaPausado: false cuando la fila dice pausado:false', async () => {
    const db = crearDbFake({ campanas_programado_config: [{ id: 1, pausado: false, pausado_por: null, pausado_at: null }] });
    await expect(estaPausado(db as any)).resolves.toBe(false);
  });

  it('estaPausado: true cuando la fila dice pausado:true', async () => {
    const db = crearDbFake({ campanas_programado_config: [{ id: 1, pausado: true, pausado_por: 'Ana', pausado_at: 'x' }] });
    await expect(estaPausado(db as any)).resolves.toBe(true);
  });

  // Falla cerrado -- garantía 5: sin la fila (no debería pasar tras la
  // migración, pero por las dudas), se trata como PAUSADO, nunca activo.
  it('estaPausado: true (falla cerrado) si la fila no existe', async () => {
    const db = crearDbFake({ campanas_programado_config: [] });
    await expect(estaPausado(db as any)).resolves.toBe(true);
  });

  it('estadoProgramado devuelve pausadoPor/pausadoAt cuando está pausado', async () => {
    const db = crearDbFake({
      campanas_programado_config: [{ id: 1, pausado: true, pausado_por: 'Beto', pausado_at: '2026-09-01T00:00:00.000Z' }],
    });
    await expect(estadoProgramado(db as any)).resolves.toEqual({
      pausado: true,
      pausadoPor: 'Beto',
      pausadoAt: '2026-09-01T00:00:00.000Z',
    });
  });

  it('establecerPausado escribe pausado, pausado_por y pausado_at', async () => {
    const db = crearDbFake({ campanas_programado_config: [{ id: 1, pausado: false, pausado_por: null, pausado_at: null }] });
    const ahora = () => new Date('2026-09-09T15:00:00.000Z');
    await establecerPausado(db as any, true, 'Ana Solano', ahora);
    expect(db.estado.campanas_programado_config[0]).toEqual({
      id: 1,
      pausado: true,
      pausado_por: 'Ana Solano',
      pausado_at: '2026-09-09T15:00:00.000Z',
    });
  });
});

// =======================================================================
// 3) "Nadie recibe el correo inicial dos veces" + orden de zonas.
describe('resolverObjetivo', () => {
  it('sin ninguna campaña programada, arma la PRIMERA zona del orden (la más chica)', async () => {
    const db = crearDbFake();
    const fetchImpl = fetchImplCombinado({
      [ORDEN_ZONAS_PROGRAMADO[0]]: [contacto(1), contacto(2)],
    });
    const r = await resolverObjetivo(db as any, { ...depsBase, fetchImpl });
    expect(r).toMatchObject({ tipo: 'zona', zona: ORDEN_ZONAS_PROGRAMADO[0], pendientes: 2, campanaNueva: true });
    if (r.tipo === 'zona') {
      const fila = db.estado.campanas.find((c) => c.id === r.campanaId);
      expect(fila).toMatchObject({ zona: ORDEN_ZONAS_PROGRAMADO[0], plantilla: 'inicial', programada: true, creado_por: MARCADOR_CAMPANA_PROGRAMADA });
    }
  });

  it('si la zona actual ya tiene campaña con pendientes, la devuelve SIN volver a tocar GHL', async () => {
    const zona = ORDEN_ZONAS_PROGRAMADO[0];
    const db = crearDbFake({
      campanas: [{ id: 'c-1', zona, plantilla: 'inicial', programada: true }],
      campanas_envios: [
        { id: 'e-1', campana_id: 'c-1', correo: 'a@hotel.cr', estado: 'pendiente', nombre_crm: 'A' },
        { id: 'e-2', campana_id: 'c-1', correo: 'b@hotel.cr', estado: 'enviado', nombre_crm: 'B' },
      ],
    });
    const fetchImpl = vi.fn();
    const r = await resolverObjetivo(db as any, { ...depsBase, fetchImpl });
    expect(r).toEqual({ tipo: 'zona', zona, campanaId: 'c-1', pendientes: 1, campanaNueva: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('si la primera zona ya terminó, pasa a la SEGUNDA en la misma corrida', async () => {
    const [primera, segunda] = ORDEN_ZONAS_PROGRAMADO;
    const db = crearDbFake({
      campanas: [{ id: 'c-1', zona: primera, plantilla: 'inicial', programada: true }],
      campanas_envios: [{ id: 'e-1', campana_id: 'c-1', correo: 'a@hotel.cr', estado: 'enviado', nombre_crm: 'A' }],
    });
    const fetchImpl = fetchImplCombinado({ [segunda]: [contacto(1)] });
    const r = await resolverObjetivo(db as any, { ...depsBase, fetchImpl });
    expect(r).toMatchObject({ tipo: 'zona', zona: segunda, campanaNueva: true });
  });

  // La garantía central del punto 5 del encargo: un correo que ya recibió
  // el inicial (en OTRA campaña 'inicial', armada a mano o por el cron) no
  // vuelve a entrar en la campaña de una zona nueva.
  it('nadie recibe el inicial dos veces: un correo ya enviado en otra zona no entra en la nueva', async () => {
    const [primera, segunda] = ORDEN_ZONAS_PROGRAMADO;
    const db = crearDbFake({
      // Campaña 'inicial' MANUAL (programada:false) de una zona -- el
      // filtro es GLOBAL, no sólo contra campañas del cron.
      campanas: [{ id: 'c-manual', zona: primera, plantilla: 'inicial', programada: false }],
      campanas_envios: [
        { id: 'e-1', campana_id: 'c-manual', correo: 'repetido@hotel.cr', estado: 'enviado', nombre_crm: 'Repetido' },
      ],
    });
    // La zona[0] (Guanacaste Interior) todavía no tiene NINGUNA campaña
    // 'programada' -- resolverObjetivo intenta armarla, pero su único
    // contacto es el correo ya enviado -> nadie elegible -> pasa a la
    // segunda zona.
    const fetchImpl = fetchImplCombinado({
      [primera]: [{ id: 'ghl-1', firstName: 'Repetido', email: 'repetido@hotel.cr' }],
      [segunda]: [contacto(9)],
    });
    const r = await resolverObjetivo(db as any, { ...depsBase, fetchImpl });
    expect(r).toMatchObject({ tipo: 'zona', zona: segunda });
    // Y no se creó ninguna campaña programada para la primera zona.
    expect(db.estado.campanas.some((c) => c.zona === primera && c.programada)).toBe(false);
  });

  it('si todos los contactos de una zona están de baja, pasa a la siguiente', async () => {
    const [primera, segunda] = ORDEN_ZONAS_PROGRAMADO;
    const db = crearDbFake({ bajas_correo: [{ correo: 'baja@hotel.cr' }] });
    const fetchImpl = fetchImplCombinado({
      [primera]: [{ id: 'ghl-1', firstName: 'De baja', email: 'baja@hotel.cr' }],
      [segunda]: [contacto(9)],
    });
    const r = await resolverObjetivo(db as any, { ...depsBase, fetchImpl });
    expect(r).toMatchObject({ tipo: 'zona', zona: segunda });
  });

  it('si TODAS las zonas ya tienen su campaña terminada, sin_pendientes -- sin tocar GHL', async () => {
    const campanas = ORDEN_ZONAS_PROGRAMADO.map((zona, i) => ({
      id: `c-${i}`,
      zona,
      plantilla: 'inicial',
      programada: true,
    }));
    const campanas_envios = campanas.map((c) => ({
      id: `e-${c.id}`,
      campana_id: c.id,
      correo: `${c.id}@hotel.cr`,
      estado: 'enviado',
      nombre_crm: 'X',
    }));
    const db = crearDbFake({ campanas, campanas_envios });
    const fetchImpl = vi.fn();
    const r = await resolverObjetivo(db as any, { ...depsBase, fetchImpl });
    expect(r).toEqual({ tipo: 'sin_pendientes' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// =======================================================================
// El disparo del día completo -- integra las cinco garantías.
describe('ejecutarEnvioProgramado', () => {
  const zonaUno = ORDEN_ZONAS_PROGRAMADO[0];

  it('pausado: no toca GHL, no reserva cupo, no llama a Resend', async () => {
    const db = crearDbFake({ campanas_programado_config: [{ id: 1, pausado: true, pausado_por: 'x', pausado_at: 'x' }] });
    const fetchImpl = vi.fn();
    const r = await ejecutarEnvioProgramado(db as any, { ...depsBase, fetchImpl });
    expect(r).toEqual({ ok: true, accion: 'pausado' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(db.estado.campanas_envio_diario).toHaveLength(0);
  });

  it('sin pendientes en ninguna zona: sin_pendientes, sin reservar cupo', async () => {
    const campanas = ORDEN_ZONAS_PROGRAMADO.map((zona, i) => ({ id: `c-${i}`, zona, plantilla: 'inicial', programada: true }));
    const campanas_envios = campanas.map((c) => ({ id: `e-${c.id}`, campana_id: c.id, correo: `${c.id}@x.cr`, estado: 'enviado', nombre_crm: 'X' }));
    const db = crearDbFake({
      campanas_programado_config: [{ id: 1, pausado: false, pausado_por: null, pausado_at: null }],
      campanas,
      campanas_envios,
    });
    const fetchImpl = vi.fn();
    const r = await ejecutarEnvioProgramado(db as any, { ...depsBase, fetchImpl });
    expect(r).toEqual({ ok: true, accion: 'sin_pendientes' });
    expect(db.estado.campanas_envio_diario).toHaveLength(0);
  });

  it('camino feliz: crea la campaña, reserva el cupo del día 1 (25) y manda una tanda de 25 aunque haya más pendientes', async () => {
    const db = crearDbFake({ campanas_programado_config: [{ id: 1, pausado: false, pausado_por: null, pausado_at: null }] });
    const contactos = Array.from({ length: 30 }, (_, i) => contacto(i));
    const fetchImpl = fetchImplCombinado({ [zonaUno]: contactos });
    const ahora = () => new Date('2026-09-09T15:00:00.000Z');

    const r = await ejecutarEnvioProgramado(db as any, { ...depsBase, fetchImpl }, ahora);

    expect(r).toMatchObject({ ok: true, accion: 'enviado', zona: zonaUno, campanaNueva: true, cupoReservado: 25, procesados: 25, enviados: 25, fallidos: 0 });
    // El cupo del día quedó anotado en la base -- no en memoria.
    expect(db.estado.campanas_envio_diario).toEqual([{ fecha: '2026-09-09', tope: 25, enviados: 25 }]);
    // 30 destinatarios en la campaña, sólo 25 ya 'enviado' -- 5 siguen
    // 'pendiente' para mañana.
    if (r.ok && r.accion === 'enviado') {
      const filasDeLaCampana = db.estado.campanas_envios.filter((e) => e.campana_id === r.campanaId);
      expect(filasDeLaCampana).toHaveLength(30);
      expect(filasDeLaCampana.filter((f) => f.estado === 'enviado')).toHaveLength(25);
      expect(filasDeLaCampana.filter((f) => f.estado === 'pendiente')).toHaveLength(5);
    }
  });

  it('cupo agotado: si el día ya gastó su tope, no llama a Resend y avisa cupo_agotado', async () => {
    const db = crearDbFake({
      campanas_programado_config: [{ id: 1, pausado: false, pausado_por: null, pausado_at: null }],
      campanas: [
        {
          id: 'c-1',
          zona: zonaUno,
          plantilla: 'inicial',
          programada: true,
          asunto: 'Asunto de prueba',
          html: 'Hola{{nombre}}, de {{empresa}}: {{unsubscribe_url}}',
          preview_text: null,
          cancelada_at: null,
        },
      ],
      campanas_envios: [{ id: 'e-1', campana_id: 'c-1', correo: 'a@hotel.cr', estado: 'pendiente', nombre_crm: 'A' }],
      campanas_envio_diario: [{ fecha: '2026-09-09', tope: 25, enviados: 25 }],
    });
    const fetchImpl = vi.fn();
    const ahora = () => new Date('2026-09-09T15:00:00.000Z');

    const r = await ejecutarEnvioProgramado(db as any, { ...depsBase, fetchImpl }, ahora);

    expect(r).toEqual({ ok: true, accion: 'cupo_agotado', zona: zonaUno });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // Garantía 4, de punta a punta: DOS disparos el mismo día (un reintento
  // de Vercel) nunca mandan, juntos, más que el tope del día -- aunque la
  // zona tenga pendientes de sobra para las dos corridas.
  it('un reintento el mismo día no manda una segunda tanda más allá del cupo diario', async () => {
    // Día 6+ (tope 100): se siembran 8 filas previas (días 1 a 8, aunque no
    // importa el detalle -- sólo la CANTIDAD) para que "hoy" sea día 9.
    const diasPrevios = Array.from({ length: 8 }, (_, i) => ({ fecha: `2026-08-${i + 1}`.padStart(10, '0'), tope: 100, enviados: 100 }));
    const db = crearDbFake({
      campanas_programado_config: [{ id: 1, pausado: false, pausado_por: null, pausado_at: null }],
      campanas: [
        {
          id: 'c-1',
          zona: zonaUno,
          plantilla: 'inicial',
          programada: true,
          asunto: 'Asunto de prueba',
          html: 'Hola{{nombre}}, de {{empresa}}: {{unsubscribe_url}}',
          preview_text: null,
          cancelada_at: null,
        },
      ],
      campanas_envios: Array.from({ length: 150 }, (_, i) => ({
        id: `e-${i}`,
        campana_id: 'c-1',
        correo: `h${i}@hotel.cr`,
        estado: 'pendiente',
        nombre_crm: `Hotel ${i}`,
      })),
      campanas_envio_diario: diasPrevios,
    });
    const ahora = () => new Date('2026-09-09T15:00:00.000Z');
    const fetchImpl = fetchImplCombinado({});

    const primera = await ejecutarEnvioProgramado(db as any, { ...depsBase, fetchImpl }, ahora);
    expect(primera).toMatchObject({ ok: true, accion: 'enviado', cupoReservado: 100, procesados: 100 });

    const segunda = await ejecutarEnvioProgramado(db as any, { ...depsBase, fetchImpl }, ahora);
    // El segundo disparo del MISMO día no manda nada más -- el cupo de hoy
    // ya se gastó entero en el primero, aunque queden 50 pendientes.
    expect(segunda).toEqual({ ok: true, accion: 'cupo_agotado', zona: zonaUno });

    const llamadasAResend = fetchImpl.mock.calls.filter((llamada: any[]) => String(llamada[0]).includes('resend.com'));
    expect(llamadasAResend).toHaveLength(1);
    expect(db.estado.campanas_envios.filter((e) => e.estado === 'enviado')).toHaveLength(100);
  });

  // Garantía 2, aun con una zona enorme y la rampa ya en el techo: nunca
  // se pide (ni se manda) más de TAMANO_TANDA (100) en una sola corrida.
  it('con la rampa en 100 y cientos de pendientes, nunca pide (ni manda) más de TAMANO_TANDA', async () => {
    const db = crearDbFake({
      campanas_programado_config: [{ id: 1, pausado: false, pausado_por: null, pausado_at: null }],
      campanas: [
        {
          id: 'c-1',
          zona: zonaUno,
          plantilla: 'inicial',
          programada: true,
          asunto: 'Asunto de prueba',
          html: 'Hola{{nombre}}, de {{empresa}}: {{unsubscribe_url}}',
          preview_text: null,
          cancelada_at: null,
        },
      ],
      campanas_envios: Array.from({ length: 500 }, (_, i) => ({
        id: `e-${i}`,
        campana_id: 'c-1',
        correo: `h${i}@hotel.cr`,
        estado: 'pendiente',
        nombre_crm: `Hotel ${i}`,
      })),
      campanas_envio_diario: [{ fecha: '2026-09-09', tope: 100, enviados: 0 }],
    });
    const fetchImpl = fetchImplCombinado({});
    const ahora = () => new Date('2026-09-09T15:00:00.000Z');

    const r = await ejecutarEnvioProgramado(db as any, { ...depsBase, fetchImpl }, ahora);
    expect(r).toMatchObject({ ok: true, accion: 'enviado', cupoReservado: TAMANO_TANDA, procesados: TAMANO_TANDA });
    const cuerpoResend = fetchImpl.mock.calls.find((llamada: any[]) => String(llamada[0]).includes('resend.com'))![1].body;
    expect(JSON.parse(cuerpoResend)).toHaveLength(TAMANO_TANDA);
  });

  // La rampa completa, de punta a punta, disparo a disparo -- ida real por
  // `ejecutarEnvioProgramado`, no sólo por `topeParaDia` aislado.
  it('la rampa sube 25, 25, 50, 50, 75, 100, 100 a lo largo de siete disparos', async () => {
    const db = crearDbFake({
      campanas_programado_config: [{ id: 1, pausado: false, pausado_por: null, pausado_at: null }],
      campanas: [
        {
          id: 'c-1',
          zona: zonaUno,
          plantilla: 'inicial',
          programada: true,
          asunto: 'Asunto de prueba',
          html: 'Hola{{nombre}}, de {{empresa}}: {{unsubscribe_url}}',
          preview_text: null,
          cancelada_at: null,
        },
      ],
      // De sobra para los siete días (25+25+50+50+75+100+100 = 425).
      campanas_envios: Array.from({ length: 1000 }, (_, i) => ({
        id: `e-${i}`,
        campana_id: 'c-1',
        correo: `h${i}@hotel.cr`,
        estado: 'pendiente',
        nombre_crm: `Hotel ${i}`,
      })),
    });
    const fetchImpl = fetchImplCombinado({});
    const esperados = [25, 25, 50, 50, 75, 100, 100];
    for (let dia = 1; dia <= 7; dia++) {
      const ahora = () => new Date(`2026-09-${String(dia).padStart(2, '0')}T15:00:00.000Z`);
      const r = await ejecutarEnvioProgramado(db as any, { ...depsBase, fetchImpl }, ahora);
      expect(r).toMatchObject({ ok: true, accion: 'enviado', cupoReservado: esperados[dia - 1] });
    }
  });

  it('si ejecutarEnvioProgramado no puede leer el interruptor, ok:false (nunca manda por descuido)', async () => {
    const db = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'db caida' } }) }) }) }),
      rpc: vi.fn(),
    };
    const fetchImpl = vi.fn();
    const r = await ejecutarEnvioProgramado(db as any, { ...depsBase, fetchImpl });
    expect(r.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
