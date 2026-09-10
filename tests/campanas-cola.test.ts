// tests/campanas-cola.test.ts
//
// La cola del envío programado (lib/campanas/cola.ts): lo que
// `estadoColaProgramada` deriva -- nunca lo que hay guardado como filas,
// porque no existe ninguna fila de "cola" -- del orden de zonas, de lo ya
// enviado y de los contactos de HOY en el CRM.
//
// Dos bloques:
//   1. `esDiaHabil`/`fechaEstimadaFin`: funciones puras, sin base ni red.
//   2. `estadoColaProgramada`: con un doble de Supabase DE SÓLO LECTURA
//      (ninguna tabla del doble tiene `insert`/`update`/`upsert`, y `rpc`
//      revienta si se llama) -- si algún día este módulo intentara
//      escribir algo, cualquiera de estas pruebas lo detecta al toque, sin
//      necesidad de una aserción aparte "no escribió nada".
import { describe, it, expect, vi } from 'vitest';
import { esDiaHabil, fechaEstimadaFin, estadoColaProgramada } from '@/lib/campanas/cola';
import { ORDEN_ZONAS_PROGRAMADO } from '@/lib/campanas/programado';

// =======================================================================
// 1) Funciones puras.
describe('esDiaHabil', () => {
  it.each([
    ['2026-09-07', true], // lunes
    ['2026-09-08', true], // martes
    ['2026-09-09', true], // miércoles
    ['2026-09-10', true], // jueves
    ['2026-09-11', true], // viernes
    ['2026-09-12', false], // sábado
    ['2026-09-13', false], // domingo
  ])('%s -> %s', (fecha, esperado) => {
    expect(esDiaHabil(new Date(`${fecha}T00:00:00.000Z`))).toBe(esperado);
  });
});

describe('fechaEstimadaFin', () => {
  const miercoles = () => new Date('2026-09-09T00:00:00.000Z');

  it('sin pendientes, no hay fecha que estimar', () => {
    expect(fechaEstimadaFin(0, 1, miercoles(), 0)).toBeNull();
    expect(fechaEstimadaFin(-5, 1, miercoles(), 0)).toBeNull();
  });

  it('si lo que falta cabe en el cupo de HOY, termina hoy mismo', () => {
    // Día 6+ (tope 100), nada reservado todavía, 50 pendientes: caben.
    expect(fechaEstimadaFin(50, 6, miercoles(), 0)).toBe('2026-09-09');
  });

  // Mata el mutante que cambia el `<=` de la comprobación de "cabe hoy" por
  // `<`: con EXACTAMENTE el cupo disponible, tiene que terminar hoy, no
  // mañana.
  it('si lo que falta es EXACTO al cupo disponible de hoy, también termina hoy', () => {
    expect(fechaEstimadaFin(25, 1, miercoles(), 0)).toBe('2026-09-09');
  });

  it('descuenta lo ya reservado hoy antes de ver qué le queda al día', () => {
    // Tope 25 (día 1), ya se reservaron 25 -- no queda nada de hoy.
    expect(fechaEstimadaFin(1, 1, miercoles(), 25)).toBe('2026-09-10'); // jueves
  });

  it('si no alcanza el cupo de hoy, sigue al siguiente día hábil con SU tope de rampa', () => {
    // Día 6 (tope 100), 150 pendientes: hoy se van 100, mañana (día 7,
    // tope 100) le sobran 50 -- termina mañana.
    expect(fechaEstimadaFin(150, 6, miercoles(), 0)).toBe('2026-09-10');
  });

  it('salta el fin de semana -- viernes con sobrante pasa al lunes, no al sábado', () => {
    const viernes = new Date('2026-09-11T00:00:00.000Z');
    // Tope 100 hoy (viernes), 150 pendientes: sobran 50 para el "día
    // siguiente" de la rampa, que cae en lunes.
    expect(fechaEstimadaFin(150, 6, viernes, 0)).toBe('2026-09-14'); // lunes
  });

  it('si HOY es fin de semana, el día de rampa no avanza -- sólo se salta al lunes', () => {
    const sabado = new Date('2026-09-12T00:00:00.000Z');
    // Día 6 (tope 100) sigue siendo el día del lunes -- 50 caben ahí.
    expect(fechaEstimadaFin(50, 6, sabado, 0)).toBe('2026-09-14'); // lunes
  });

  // La rampa completa, de punta a punta -- clava una fecha exacta, no un
  // rango, para que un mutante que cambie cualquiera de los cinco números
  // de la rampa (25/25/50/50/75) se note acá. Empieza un miércoles con el
  // cupo de hoy entero disponible:
  //   día1(mié09) 25, día2(jue10) 25, día3(vie11) 50, día4(lun14) 50,
  //   día5(mar15) 75 -- total exacto 225 -- termina el martes 15.
  it('consume la rampa entera y clava la fecha exacta en el borde de los cinco tramos', () => {
    expect(fechaEstimadaFin(225, 1, miercoles(), 0)).toBe('2026-09-15');
  });

  // Un pendiente de más empuja al sexto día hábil (tope ya en 100) -- el
  // miércoles siguiente.
  it('un pendiente de más que el borde de la rampa empuja al siguiente día (tope 100)', () => {
    expect(fechaEstimadaFin(226, 1, miercoles(), 0)).toBe('2026-09-16');
  });
});

// =======================================================================
// 2) `estadoColaProgramada` -- de punta a punta, contra un doble en
// memoria de Supabase y GHL.
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

// Doble DE SÓLO LECTURA a propósito -- ninguna tabla sabe `insert`/
// `update`/`upsert`, y `rpc` revienta si alguien la llama. Este módulo
// nunca debería necesitar ninguna de las dos.
function crearDbSoloLectura(
  seed: {
    campanas?: Fila[];
    campanas_envios?: Fila[];
    bajas_correo?: Fila[];
    campanas_envio_diario?: Fila[];
  } = {},
) {
  const estado: Record<string, Fila[]> = {
    campanas: seed.campanas ?? [],
    campanas_envios: seed.campanas_envios ?? [],
    bajas_correo: seed.bajas_correo ?? [],
    campanas_envio_diario: seed.campanas_envio_diario ?? [],
  };
  return {
    from: (tabla: string) => {
      const filas = estado[tabla];
      if (!filas) throw new Error(`tabla no mockeada en esta prueba: ${tabla}`);
      return { select: (...args: any[]) => nodoLectura(filas).select(...args) };
    },
    rpc: vi.fn(() => {
      throw new Error('estadoColaProgramada es de sólo lectura -- no debería llamar a ningún rpc.');
    }),
    estado,
  };
}

function fetchGhl(porZona: Record<string, Array<{ id: string; firstName?: string; email?: string }>>) {
  return vi.fn(async (_url: any, init: any) => {
    const cuerpo = JSON.parse((init?.body as string) ?? '{}');
    const zona = cuerpo.filters?.[0]?.value as string;
    const contactos = porZona[zona] ?? [];
    return { ok: true, status: 200, text: async () => JSON.stringify({ contacts: contactos }) } as unknown as Response;
  });
}

const depsBase = { apiKey: 'llave-ghl', locationId: 'loc-1' };
const [ZONA_1, ZONA_2, ZONA_3] = ORDEN_ZONAS_PROGRAMADO; // Guanacaste Interior, Caribe, Heredia / Norte GAM

const ahoraMiercoles = () => new Date('2026-09-09T15:00:00.000Z');

describe('estadoColaProgramada', () => {
  it('las trece zonas, en el orden real de envío, con orden 1..13', async () => {
    const db = crearDbSoloLectura();
    const fetchImpl = fetchGhl({});
    const r = await estadoColaProgramada(db as any, { ...depsBase, fetchImpl }, ahoraMiercoles);
    expect(r.zonas).toHaveLength(13);
    expect(r.zonas.map((z) => z.zona)).toEqual([...ORDEN_ZONAS_PROGRAMADO]);
    expect(r.zonas.map((z) => z.orden)).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
  });

  // LA TRAMPA DE LAS DIRECCIONES ÚNICAS: la misma dirección aparece en dos
  // zonas -- sumar cada zona por separado daría 4 (2+2), no 3.
  it('una direccion que aparece en dos zonas se cuenta UNA sola vez, en la primera zona del orden', async () => {
    const db = crearDbSoloLectura();
    const fetchImpl = fetchGhl({
      [ZONA_1]: [
        { id: 'g-1', firstName: 'Hotel A', email: 'a@hotel.cr' },
        { id: 'g-2', firstName: 'Hotel B', email: 'b@hotel.cr' },
      ],
      [ZONA_2]: [
        { id: 'g-3', firstName: 'Hotel B (otra sede)', email: 'b@hotel.cr' }, // repetida
        { id: 'g-4', firstName: 'Hotel C', email: 'c@hotel.cr' },
      ],
    });
    const r = await estadoColaProgramada(db as any, { ...depsBase, fetchImpl }, ahoraMiercoles);

    const filaZona1 = r.zonas.find((z) => z.zona === ZONA_1)!;
    const filaZona2 = r.zonas.find((z) => z.zona === ZONA_2)!;
    expect(filaZona1.direccionesTotal).toBe(2); // a, b
    expect(filaZona2.direccionesTotal).toBe(1); // sólo c -- b ya se la llevó la zona 1
    expect(r.totalDirecciones).toBe(3); // a, b, c -- nunca 4
    expect(r.totalPendientes).toBe(3);
  });

  it('una direccion repetida DENTRO de la misma zona tampoco se cuenta dos veces', async () => {
    const db = crearDbSoloLectura();
    const fetchImpl = fetchGhl({
      [ZONA_1]: [
        { id: 'g-1', firstName: 'Hotel A', email: 'a@hotel.cr' },
        { id: 'g-2', firstName: 'Hotel A (sucursal)', email: 'a@hotel.cr' },
      ],
    });
    const r = await estadoColaProgramada(db as any, { ...depsBase, fetchImpl }, ahoraMiercoles);
    expect(r.zonas.find((z) => z.zona === ZONA_1)!.direccionesTotal).toBe(1);
  });

  it('una direccion que YA recibio el inicial (en cualquier campaña, de cualquier zona) no vuelve a contarse como pendiente', async () => {
    const db = crearDbSoloLectura({
      campanas: [{ id: 'c-manual', zona: 'GAM Oeste', plantilla: 'inicial', programada: false }],
      campanas_envios: [{ id: 'e-1', campana_id: 'c-manual', correo: 'ya-recibido@hotel.cr', estado: 'enviado' }],
    });
    const fetchImpl = fetchGhl({
      [ZONA_1]: [{ id: 'g-1', firstName: 'Ya recibido', email: 'ya-recibido@hotel.cr' }],
    });
    const r = await estadoColaProgramada(db as any, { ...depsBase, fetchImpl }, ahoraMiercoles);
    expect(r.zonas.find((z) => z.zona === ZONA_1)!.direccionesTotal).toBe(0);
    expect(r.totalDirecciones).toBe(0);
  });

  it('una direccion de baja no se cuenta -- ni en la zona ni en el total', async () => {
    const db = crearDbSoloLectura({ bajas_correo: [{ correo: 'baja@hotel.cr' }] });
    const fetchImpl = fetchGhl({
      [ZONA_1]: [
        { id: 'g-1', firstName: 'De baja', email: 'baja@hotel.cr' },
        { id: 'g-2', firstName: 'Activo', email: 'activo@hotel.cr' },
      ],
    });
    const r = await estadoColaProgramada(db as any, { ...depsBase, fetchImpl }, ahoraMiercoles);
    expect(r.zonas.find((z) => z.zona === ZONA_1)!.direccionesTotal).toBe(1);
    expect(r.totalDirecciones).toBe(1);
  });

  it('estado de zona: terminada (pendientes 0), en_curso (pendientes > 0) y espera (sin campaña)', async () => {
    const db = crearDbSoloLectura({
      campanas: [
        { id: 'c-terminada', zona: ZONA_1, plantilla: 'inicial', programada: true },
        { id: 'c-en-curso', zona: ZONA_2, plantilla: 'inicial', programada: true },
      ],
      campanas_envios: [
        { id: 'e-1', campana_id: 'c-terminada', correo: 'a1@hotel.cr', estado: 'enviado' },
        { id: 'e-2', campana_id: 'c-terminada', correo: 'a2@hotel.cr', estado: 'enviado' },
        { id: 'e-3', campana_id: 'c-terminada', correo: 'a3@hotel.cr', estado: 'error' },
        { id: 'e-4', campana_id: 'c-en-curso', correo: 'b1@hotel.cr', estado: 'enviado' },
        { id: 'e-5', campana_id: 'c-en-curso', correo: 'b2@hotel.cr', estado: 'enviado' },
        { id: 'e-6', campana_id: 'c-en-curso', correo: 'b3@hotel.cr', estado: 'error' },
        { id: 'e-7', campana_id: 'c-en-curso', correo: 'b4@hotel.cr', estado: 'pendiente' },
        { id: 'e-8', campana_id: 'c-en-curso', correo: 'b5@hotel.cr', estado: 'pendiente' },
      ],
    });
    const fetchImpl = fetchGhl({
      [ZONA_3]: [{ id: 'g-1', firstName: 'Nueva', email: 'c1@hotel.cr' }],
    });
    const r = await estadoColaProgramada(db as any, { ...depsBase, fetchImpl }, ahoraMiercoles);

    const zona1 = r.zonas.find((z) => z.zona === ZONA_1)!;
    expect(zona1.estado).toBe('terminada');
    expect(zona1).toMatchObject({ direccionesTotal: 3, direccionesEnviadas: 2, direccionesFallidas: 1, direccionesPendientes: 0 });

    const zona2 = r.zonas.find((z) => z.zona === ZONA_2)!;
    expect(zona2.estado).toBe('en_curso');
    expect(zona2).toMatchObject({ direccionesTotal: 5, direccionesEnviadas: 2, direccionesFallidas: 1, direccionesPendientes: 2 });

    const zona3 = r.zonas.find((z) => z.zona === ZONA_3)!;
    expect(zona3.estado).toBe('espera');
    expect(zona3.campanaId).toBeNull();
    expect(zona3.direccionesTotal).toBe(1);

    expect(r.totalDirecciones).toBe(9); // 3 + 5 + 1
    expect(r.totalEnviadas).toBe(4); // 2 + 2
    expect(r.totalFallidas).toBe(2); // 1 + 1
    expect(r.totalPendientes).toBe(3); // 0 + 2 + 1
  });

  // La simplificación deliberada documentada en lib/campanas/cola.ts: los
  // PENDIENTES (todavía no 'enviado') de la zona en curso también quedan
  // reservados para las zonas futuras -- nunca se ofrece la misma
  // dirección dos veces en esta vista, aunque el sistema real sólo excluye
  // por 'enviado'.
  it('una direccion pendiente de la zona EN CURSO no se vuelve a ofrecer en una zona futura', async () => {
    const db = crearDbSoloLectura({
      campanas: [{ id: 'c-en-curso', zona: ZONA_1, plantilla: 'inicial', programada: true }],
      campanas_envios: [
        { id: 'e-1', campana_id: 'c-en-curso', correo: 'pendiente@hotel.cr', estado: 'pendiente' },
      ],
    });
    const fetchImpl = fetchGhl({
      [ZONA_2]: [
        { id: 'g-1', firstName: 'Repetida', email: 'pendiente@hotel.cr' }, // la misma de la zona en curso
        { id: 'g-2', firstName: 'Nueva', email: 'nueva@hotel.cr' },
      ],
    });
    const r = await estadoColaProgramada(db as any, { ...depsBase, fetchImpl }, ahoraMiercoles);
    const zona2 = r.zonas.find((z) => z.zona === ZONA_2)!;
    expect(zona2.direccionesTotal).toBe(1); // sólo "nueva" -- "pendiente" ya está reservada
  });

  it('el cupo de hoy: dia/tope calculados con la rampa, no a ojo, y "reservado" leido de la fila de hoy (0 si no corrio)', async () => {
    const db = crearDbSoloLectura();
    const fetchImpl = fetchGhl({});
    const r = await estadoColaProgramada(db as any, { ...depsBase, fetchImpl }, ahoraMiercoles);
    // Sin ninguna fila previa en campanas_envio_diario: día 1, tope 25,
    // nada reservado todavía hoy.
    expect(r.cupoHoy).toEqual({ dia: 1, tope: 25, reservado: 0, disponible: 25, diaHabilHoy: true });
  });

  it('el cupo de hoy refleja lo ya reservado si el cron ya corrio hoy', async () => {
    const db = crearDbSoloLectura({
      campanas_envio_diario: [
        { fecha: '2026-09-01', tope: 25, enviados: 25 },
        { fecha: '2026-09-09', tope: 25, enviados: 10 }, // hoy
      ],
    });
    const fetchImpl = fetchGhl({});
    const r = await estadoColaProgramada(db as any, { ...depsBase, fetchImpl }, ahoraMiercoles);
    expect(r.cupoHoy).toEqual({ dia: 2, tope: 25, reservado: 10, disponible: 15, diaHabilHoy: true });
  });

  it('el cupo de hoy avisa diaHabilHoy:false si hoy es fin de semana', async () => {
    const db = crearDbSoloLectura();
    const fetchImpl = fetchGhl({});
    const sabado = () => new Date('2026-09-12T15:00:00.000Z');
    const r = await estadoColaProgramada(db as any, { ...depsBase, fetchImpl }, sabado);
    expect(r.cupoHoy.diaHabilHoy).toBe(false);
  });

  it('fechaEstimadaFin viaja consistente con el total pendiente y el cupo de hoy calculados', async () => {
    const db = crearDbSoloLectura();
    const fetchImpl = fetchGhl({
      [ZONA_1]: [{ id: 'g-1', firstName: 'Hotel A', email: 'a@hotel.cr' }],
    });
    const r = await estadoColaProgramada(db as any, { ...depsBase, fetchImpl }, ahoraMiercoles);
    expect(r.totalPendientes).toBe(1);
    // Día 1, tope 25, nada reservado: 1 pendiente cabe hoy mismo.
    expect(r.fechaEstimadaFin).toBe('2026-09-09');
  });

  it('sin nada pendiente, fechaEstimadaFin es null', async () => {
    const campanas = ORDEN_ZONAS_PROGRAMADO.map((zona, i) => ({ id: `c-${i}`, zona, plantilla: 'inicial', programada: true }));
    const campanas_envios = campanas.map((c) => ({ id: `e-${c.id}`, campana_id: c.id, correo: `${c.id}@x.cr`, estado: 'enviado' }));
    const db = crearDbSoloLectura({ campanas, campanas_envios });
    const fetchImpl = fetchGhl({});
    const r = await estadoColaProgramada(db as any, { ...depsBase, fetchImpl }, ahoraMiercoles);
    expect(r.totalPendientes).toBe(0);
    expect(r.fechaEstimadaFin).toBeNull();
  });

  it('si UNA zona no se puede consultar contra GHL, la función entera falla (nunca un total a medias)', async () => {
    const db = crearDbSoloLectura();
    const fetchImpl = vi.fn(async (_url: any, init: any) => {
      const cuerpo = JSON.parse((init?.body as string) ?? '{}');
      if (cuerpo.filters?.[0]?.value === ZONA_2) {
        return { ok: false, status: 500, text: async () => 'boom' } as unknown as Response;
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ contacts: [] }) } as unknown as Response;
    });
    await expect(estadoColaProgramada(db as any, { ...depsBase, fetchImpl }, ahoraMiercoles)).rejects.toThrow();
  });
});
