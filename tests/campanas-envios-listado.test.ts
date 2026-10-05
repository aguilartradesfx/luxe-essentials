import { describe, it, expect } from 'vitest';
import { listarEnvios, esCursor, patronContiene, type Cursor } from '@/lib/campanas/envios-listado';
import { crearDb, envio, uuid, type Datos, type Envio } from './helpers/db-envios';

// Los envíos uno por uno: filtros, búsqueda y paginado. Cada prueba de
// filtro comprueba QUÉ QUEDÓ FUERA, no sólo qué entró -- un filtro que no
// filtra también devuelve las filas esperadas.

const C_NORTE = uuid(9001);
const C_CARIBE = uuid(9002);
const C_NORTE_2 = uuid(9003);

function base(): Datos {
  return {
    campanas: [
      { id: C_NORTE, zona: 'Zona Norte', plantilla: 'inicial', creado_at: '2026-09-01T10:00:00+00:00' },
      { id: C_NORTE_2, zona: 'Zona Norte', plantilla: 'seguimiento_1', creado_at: '2026-09-10T10:00:00+00:00' },
      { id: C_CARIBE, zona: 'Caribe', plantilla: 'inicial', creado_at: '2026-09-05T10:00:00+00:00' },
    ],
    envios: [],
  };
}

const ids = (r: { envios: { id: string }[] }) => r.envios.map((e) => e.id).sort();
const idsDe = (...fs: Envio[]) => fs.map((f) => f.id).sort();

describe('listarEnvios -- filtros', () => {
  it('sin filtros trae enviados y fallidos, y NO los pendientes', async () => {
    const d = base();
    const a = envio({ campana_id: C_NORTE });
    const b = envio({ campana_id: C_NORTE, estado: 'error', error: 'x' });
    const p = envio({ campana_id: C_NORTE, estado: 'pendiente', actualizado_at: null });
    d.envios.push(a, b, p);
    const r = await listarEnvios(crearDb(d), {}, null);
    expect(ids(r)).toEqual(idsDe(a, b));
    expect(r.total).toBe(2);
  });

  it('por zona: sólo esa zona, y deja fuera las otras', async () => {
    const d = base();
    const n1 = envio({ campana_id: C_NORTE });
    const n2 = envio({ campana_id: C_NORTE_2 });
    const c1 = envio({ campana_id: C_CARIBE });
    d.envios.push(n1, n2, c1);
    const r = await listarEnvios(crearDb(d), { zona: 'Zona Norte' }, null);
    expect(ids(r)).toEqual(idsDe(n1, n2));
    expect(r.envios.every((e) => e.zona === 'Zona Norte')).toBe(true);
    expect(r.envios.map((e) => e.id)).not.toContain(c1.id);
    expect(r.total).toBe(2);
  });

  it('por campaña: sólo esa, aunque otra campaña sea de la misma zona', async () => {
    const d = base();
    const n1 = envio({ campana_id: C_NORTE });
    const n2 = envio({ campana_id: C_NORTE_2 });
    d.envios.push(n1, n2, envio({ campana_id: C_CARIBE }));
    const r = await listarEnvios(crearDb(d), { campanaId: C_NORTE_2 }, null);
    expect(ids(r)).toEqual(idsDe(n2));
    expect(r.total).toBe(1);
  });

  it('por estado: cada uno trae exactamente los suyos', async () => {
    const d = base();
    const sinNull = envio({ campana_id: C_NORTE, entrega_estado: null });
    const sinEnviado = envio({ campana_id: C_NORTE, entrega_estado: 'enviado' });
    const retrasado = envio({ campana_id: C_NORTE, entrega_estado: 'retrasado' });
    const entregado = envio({ campana_id: C_NORTE, entrega_estado: 'entregado' });
    const rebotado = envio({ campana_id: C_NORTE, entrega_estado: 'rebotado' });
    const fallido = envio({ campana_id: C_NORTE, entrega_estado: 'fallido' });
    const queja = envio({ campana_id: C_NORTE, entrega_estado: 'queja' });
    const noSalio = envio({ campana_id: C_NORTE, estado: 'error', error: 'dirección inválida' });
    d.envios.push(sinNull, sinEnviado, retrasado, entregado, rebotado, fallido, queja, noSalio);
    const db = crearDb(d);
    const esperado: Record<string, Envio[]> = {
      sin_confirmar: [sinNull, sinEnviado],
      retrasado: [retrasado],
      entregado: [entregado],
      rebotado: [rebotado],
      fallido: [fallido],
      queja: [queja],
      no_salio: [noSalio],
    };
    for (const [estado, filas] of Object.entries(esperado)) {
      const r = await listarEnvios(db, { estado: estado as any }, null);
      expect(ids(r), estado).toEqual(idsDe(...filas));
      expect(r.total, estado).toBe(filas.length);
      expect(r.envios.every((e) => e.estado === estado), estado).toBe(true);
    }
  });

  it('un correo con queja después de entregado figura como queja, no como entregado', async () => {
    const d = base();
    const q = envio({ campana_id: C_NORTE, entrega_estado: 'queja', entregado_at: '2026-09-20T16:00:00+00:00' } as any);
    d.envios.push(q);
    expect((await listarEnvios(crearDb(d), { estado: 'entregado' }, null)).total).toBe(0);
    expect((await listarEnvios(crearDb(d), { estado: 'queja' }, null)).total).toBe(1);
  });

  it('combinados: zona + estado + búsqueda se aplican a la vez (AND, no OR)', async () => {
    const d = base();
    const bueno = envio({ campana_id: C_NORTE, entrega_estado: 'rebotado', nombre_crm: 'Hotel Arenal SA' });
    const otraZona = envio({ campana_id: C_CARIBE, entrega_estado: 'rebotado', nombre_crm: 'Hotel Limon SA' });
    const otroEstado = envio({ campana_id: C_NORTE, entrega_estado: 'entregado', nombre_crm: 'Hotel Fortuna SA' });
    const otraEmpresa = envio({ campana_id: C_NORTE, entrega_estado: 'rebotado', nombre_crm: 'Ferreteria Sol' });
    d.envios.push(bueno, otraZona, otroEstado, otraEmpresa);
    const r = await listarEnvios(crearDb(d), { zona: 'Zona Norte', estado: 'rebotado', busqueda: 'hotel' }, null);
    expect(ids(r)).toEqual(idsDe(bueno));
    expect(r.total).toBe(1);
  });

  it('estado «sin confirmar» combinado con búsqueda: los dos or() se aplican como AND', async () => {
    const d = base();
    const a = envio({ campana_id: C_NORTE, correo: 'ana@hotel.cr' });
    const b = envio({ campana_id: C_NORTE, correo: 'beto@otro.cr' });
    const c = envio({ campana_id: C_NORTE, correo: 'carla@hotel.cr', entrega_estado: 'entregado' });
    d.envios.push(a, b, c);
    const r = await listarEnvios(crearDb(d), { estado: 'sin_confirmar', busqueda: 'hotel' }, null);
    expect(ids(r)).toEqual(idsDe(a));
  });
});

describe('listarEnvios -- búsqueda', () => {
  it('busca por correo, sin importar mayúsculas', async () => {
    const d = base();
    const a = envio({ campana_id: C_NORTE, correo: 'Ventas@Hotelarenal.cr' });
    const b = envio({ campana_id: C_NORTE, correo: 'otro@x.cr' });
    d.envios.push(a, b);
    const r = await listarEnvios(crearDb(d), { busqueda: 'HOTELARENAL' }, null);
    expect(ids(r)).toEqual(idsDe(a));
  });

  it('busca por empresa (nombre del CRM)', async () => {
    const d = base();
    const a = envio({ campana_id: C_NORTE, nombre_crm: 'Textiles La Fortuna' });
    const b = envio({ campana_id: C_NORTE, nombre_crm: 'Otra cosa' });
    d.envios.push(a, b);
    const r = await listarEnvios(crearDb(d), { busqueda: 'fortuna' }, null);
    expect(ids(r)).toEqual(idsDe(a));
  });

  it('el guion bajo y el porcentaje se buscan literales, no como comodín', async () => {
    const d = base();
    const guion = envio({ campana_id: C_NORTE, correo: 'jendry_77@hotmail.com' });
    const otro = envio({ campana_id: C_NORTE, correo: 'jendryx77@hotmail.com' });
    const pct = envio({ campana_id: C_NORTE, nombre_crm: 'Oferta 100% Textil' });
    d.envios.push(guion, otro, pct);
    const db = crearDb(d);
    expect(ids(await listarEnvios(db, { busqueda: 'jendry_77' }, null))).toEqual(idsDe(guion));
    expect(ids(await listarEnvios(db, { busqueda: '%' }, null))).toEqual(idsDe(pct));
  });

  it('comas, paréntesis y comillas del texto no rompen el filtro ni lo inyectan', async () => {
    const d = base();
    const a = envio({ campana_id: C_NORTE, nombre_crm: 'Foo, S.A. (Heredia)' });
    const b = envio({ campana_id: C_NORTE, nombre_crm: 'Bar "El Grande"' });
    const c = envio({ campana_id: C_NORTE, nombre_crm: 'Nada que ver' });
    d.envios.push(a, b, c);
    const db = crearDb(d);
    expect(ids(await listarEnvios(db, { busqueda: 'Foo, S.A. (Heredia)' }, null))).toEqual(idsDe(a));
    expect(ids(await listarEnvios(db, { busqueda: '"El Grande"' }, null))).toEqual(idsDe(b));
    // Un intento de colar otra condición no devuelve todo.
    const r = await listarEnvios(db, { busqueda: 'x%",id.neq.0,correo.ilike."*' }, null);
    expect(r.total).toBe(0);
  });

  it('el asterisco del texto no es comodín', async () => {
    const d = base();
    d.envios.push(envio({ campana_id: C_NORTE, correo: 'a@x.cr' }), envio({ campana_id: C_NORTE, correo: 'b@x.cr' }));
    const r = await listarEnvios(crearDb(d), { busqueda: 'a*b' }, null);
    expect(r.total).toBe(0);
    expect(patronContiene('a*b')).toBe('*ab*');
  });

  it('una búsqueda sólo de espacios no filtra nada', async () => {
    const d = base();
    d.envios.push(envio({ campana_id: C_NORTE }), envio({ campana_id: C_NORTE }));
    expect((await listarEnvios(crearDb(d), { busqueda: '   ' }, null)).total).toBe(2);
  });
});

describe('listarEnvios -- paginado por cursor', () => {
  // 130 envíos con marcas de tiempo REPETIDAS (una tanda entera se cierra con
  // el mismo `now()`): grupos de 7 con la misma hora. Un cursor que sólo
  // mire la hora perdería o repetiría filas en cada frontera.
  function muchos(n: number): Datos {
    const d = base();
    for (let i = 0; i < n; i++) {
      const grupo = Math.floor(i / 7);
      const seg = String(grupo % 60).padStart(2, '0');
      const min = String(Math.floor(grupo / 60)).padStart(2, '0');
      d.envios.push(
        envio({
          campana_id: i % 3 === 0 ? C_CARIBE : C_NORTE,
          actualizado_at: `2026-09-20T15:${min}:${seg}.500000+00:00`,
          entrega_estado: i % 4 === 0 ? 'rebotado' : null,
        }),
      );
    }
    return d;
  }

  async function recorrer(db: any, filtros: any, tamano: number) {
    const vistos: string[] = [];
    const totales = new Set<number>();
    let cursor: Cursor | null = null;
    let paginas = 0;
    do {
      const r: Awaited<ReturnType<typeof listarEnvios>> = await listarEnvios(db, filtros, cursor, tamano);
      expect(r.envios.length).toBeLessThanOrEqual(tamano);
      vistos.push(...r.envios.map((e) => e.id));
      totales.add(r.total);
      cursor = r.siguiente;
      paginas++;
      expect(paginas).toBeLessThan(200);
    } while (cursor);
    return { vistos, totales, paginas };
  }

  it('recorrer todas las páginas trae cada fila exactamente una vez, en orden', async () => {
    const d = muchos(130);
    const { vistos, totales, paginas } = await recorrer(crearDb(d), {}, 10);
    expect(vistos).toHaveLength(130);
    expect(new Set(vistos).size).toBe(130);
    expect(new Set(vistos)).toEqual(new Set(d.envios.map((e) => e.id)));
    expect(paginas).toBe(13);
    expect([...totales]).toEqual([130]);
    // Orden: más reciente primero, desempate por id descendente.
    const porId = new Map(d.envios.map((e) => [e.id, e]));
    for (let i = 1; i < vistos.length; i++) {
      const a = porId.get(vistos[i - 1])!;
      const b = porId.get(vistos[i])!;
      const ok = a.actualizado_at! > b.actualizado_at! || (a.actualizado_at === b.actualizado_at && a.id > b.id);
      expect(ok).toBe(true);
    }
  });

  it('con un filtro puesto, el paginado recorre exactamente lo filtrado', async () => {
    const d = muchos(130);
    const esperados = d.envios.filter((e) => e.entrega_estado === 'rebotado' && e.campana_id === C_NORTE);
    const { vistos, totales } = await recorrer(crearDb(d), { estado: 'rebotado', zona: 'Zona Norte' }, 4);
    expect(vistos).toHaveLength(esperados.length);
    expect(new Set(vistos)).toEqual(new Set(esperados.map((e) => e.id)));
    expect([...totales]).toEqual([esperados.length]);
    expect(esperados.length).toBeGreaterThan(8);
  });

  it('cuando el total es múltiplo de la página, la última no trae siguiente ni hay una página vacía', async () => {
    const d = muchos(30);
    const { vistos, paginas } = await recorrer(crearDb(d), {}, 10);
    expect(paginas).toBe(3);
    expect(vistos).toHaveLength(30);
  });

  it('si salen correos nuevos mientras se pagina, no se repite ni se pierde ninguno de los ya existentes', async () => {
    const d = muchos(40);
    const db = crearDb(d);
    const original = new Set(d.envios.map((e) => e.id));
    const p1 = await listarEnvios(db, {}, null, 10);
    // Una tanda nueva, más reciente que todo lo anterior.
    for (let i = 0; i < 15; i++) {
      d.envios.push(envio({ campana_id: C_NORTE, actualizado_at: `2026-09-25T10:00:0${i % 10}.000000+00:00` }));
    }
    const vistos = p1.envios.map((e) => e.id);
    let cursor = p1.siguiente;
    while (cursor) {
      const r = await listarEnvios(db, {}, cursor, 10);
      vistos.push(...r.envios.map((e) => e.id));
      cursor = r.siguiente;
    }
    expect(vistos).toHaveLength(40);
    expect(new Set(vistos)).toEqual(original);
  });

  it('una página trae el cursor de la siguiente sólo si hay más', async () => {
    const d = muchos(5);
    const db = crearDb(d);
    expect((await listarEnvios(db, {}, null, 5)).siguiente).toBeNull();
    expect((await listarEnvios(db, {}, null, 4)).siguiente).not.toBeNull();
  });
});

describe('listarEnvios -- el resto de la respuesta', () => {
  it('trae empresa, zona, plantilla y el detalle según el estado', async () => {
    const d = base();
    const rebote = envio({
      campana_id: C_NORTE,
      correo: 'r@x.cr',
      nombre_crm: 'Hotel Arenal',
      entrega_estado: 'rebotado',
      entrega_detalle: 'hard/general: buzón lleno',
    });
    const noSalio = envio({ campana_id: C_CARIBE, estado: 'error', error: 'tiene tilde' });
    d.envios.push(rebote, noSalio);
    const r = await listarEnvios(crearDb(d), {}, null);
    const a = r.envios.find((e) => e.id === rebote.id)!;
    expect(a).toMatchObject({ empresa: 'Hotel Arenal', zona: 'Zona Norte', plantilla: 'inicial', estado: 'rebotado', detalle: 'hard/general: buzón lleno' });
    const b = r.envios.find((e) => e.id === noSalio.id)!;
    expect(b).toMatchObject({ estado: 'no_salio', detalle: 'tiene tilde', zona: 'Caribe' });
  });

  it('las opciones de filtro traen las zonas sin repetir, ordenadas, y las campañas', async () => {
    const r = await listarEnvios(crearDb(base()), {}, null);
    expect(r.opciones.zonas).toEqual(['Caribe', 'Zona Norte']);
    expect(r.opciones.campanas.map((c) => c.id).sort()).toEqual([C_NORTE, C_NORTE_2, C_CARIBE].sort());
  });

  it('hayConfirmaciones es falso mientras ningún correo tenga evento de entrega, y verdadero apenas uno lo tiene', async () => {
    const d = base();
    d.envios.push(envio({ campana_id: C_NORTE }), envio({ campana_id: C_NORTE }));
    expect((await listarEnvios(crearDb(d), {}, null)).hayConfirmaciones).toBe(false);
    d.envios.push(envio({ campana_id: C_NORTE, entrega_estado: 'entregado' }));
    expect((await listarEnvios(crearDb(d), {}, null)).hayConfirmaciones).toBe(true);
  });

  it('propaga un error de la base como excepción', async () => {
    const db: any = {
      from: () => {
        const n: any = { select: () => n, in: () => n, eq: () => n, or: () => n, order: () => n, limit: () => n };
        n.then = (res: any) => res({ data: null, count: null, error: { message: 'boom' } });
        return n;
      },
    };
    await expect(listarEnvios(db, {}, null)).rejects.toThrow(/boom/);
  });
});

describe('esCursor', () => {
  const ok = { at: '2026-10-02T15:28:31.714+00:00', id: uuid(1) };
  it('acepta uno bien formado', () => expect(esCursor(ok)).toBe(true));
  it('rechaza lo que no es hora o no es uuid (no se cuela nada al filtro)', () => {
    expect(esCursor({ ...ok, at: '2026-10-02' })).toBe(false);
    expect(esCursor({ ...ok, at: '2026-10-02T15:28:31Z",id.neq.0,a.eq."' })).toBe(false);
    expect(esCursor({ ...ok, id: 'x") or (1=1' })).toBe(false);
    expect(esCursor(null)).toBe(false);
    expect(esCursor({ at: ok.at })).toBe(false);
  });
});
