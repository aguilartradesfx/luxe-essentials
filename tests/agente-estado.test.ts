import { describe, it, expect, vi } from 'vitest';
import { fusionarDatos, tomarMensaje, leerOCrear, guardar, DATOS_VACIOS } from '@/lib/agente/estado';

describe('fusionarDatos', () => {
  it('rellena lo que faltaba', () => {
    const r = fusionarDatos(DATOS_VACIOS, { nombre: 'Ana Pérez' });
    expect(r.nombre).toBe('Ana Pérez');
  });

  // El modelo devuelve el objeto completo con nulls en lo que no supo. Si un
  // null pisara un dato ya capturado, el agente perdería el correo del cliente
  // en el turno siguiente y lo volvería a pedir.
  it('un null nuevo nunca borra un dato que ya teníamos', () => {
    const previos = { ...DATOS_VACIOS, email: 'ana@empresa.com' };
    const r = fusionarDatos(previos, { email: null, nombre: 'Ana' });
    expect(r.email).toBe('ana@empresa.com');
    expect(r.nombre).toBe('Ana');
  });

  it('una cadena vacía tampoco borra', () => {
    const previos = { ...DATOS_VACIOS, telefono: '+502 5555 5555' };
    expect(fusionarDatos(previos, { telefono: '   ' }).telefono).toBe('+502 5555 5555');
  });

  it('un valor nuevo sí corrige uno anterior', () => {
    const previos = { ...DATOS_VACIOS, ubicacion: 'Guatemala' };
    expect(fusionarDatos(previos, { ubicacion: 'San Salvador' }).ubicacion).toBe('San Salvador');
  });
});

// El candado de la guarda 3. Se prueba contra un doble del cliente de Supabase
// que registra el filtro `or` construido, porque ese filtro es justamente la
// parte fácil de escribir mal.
function dbFalso(filasDevueltas: unknown[], error: unknown = null) {
  const registro: { or: string[]; update?: Record<string, unknown> } = { or: [] };
  const db = {
    from: () => ({
      update: (campos: Record<string, unknown>) => {
        registro.update = campos;
        // El candado encadena DOS `.or()`, así que el eslabón se devuelve a sí
        // mismo hasta que llega el `.select()`.
        const eslabon: Record<string, unknown> = {
          or: (filtro: string) => {
            registro.or.push(filtro);
            return eslabon;
          },
          select: async () => ({ data: filasDevueltas, error }),
        };
        return { eq: () => eslabon };
      },
    }),
  };
  return { db, registro };
}

describe('tomarMensaje', () => {
  it('devuelve true cuando gana la carrera', async () => {
    const { db } = dbFalso([{ contact_id: 'c1' }]);
    expect(await tomarMensaje('c1', 'm-99', db as never)).toBe(true);
  });

  // Reintento de GHL o el cliente mandando tres mensajes seguidos: sólo uno
  // debe responder. Si esto devuelve true dos veces, el cliente recibe dos
  // respuestas del bot.
  it('devuelve false cuando otro proceso ya tomó ese mensaje', async () => {
    const { db } = dbFalso([]);
    expect(await tomarMensaje('c1', 'm-99', db as never)).toBe(false);
  });

  // `neq` a secas no matchea filas con NULL, porque en SQL `NULL <> 'x'` es
  // NULL, no true. Una fila recién creada nunca podría reclamarse.
  it('el filtro contempla la fila nueva con ultimo_mensaje_id en NULL', async () => {
    const { db, registro } = dbFalso([{ contact_id: 'c1' }]);
    await tomarMensaje('c1', 'm-99', db as never);
    const filtros = registro.or.join(' | ');
    expect(filtros).toContain('ultimo_mensaje_id.is.null');
    expect(filtros).toContain('ultimo_mensaje_id.neq.m-99');
  });

  // Sin este segundo filtro, un cliente que manda dos mensajes seguidos genera
  // dos webhooks con ids distintos que reclaman cada uno el suyo y corren en
  // paralelo: dos respuestas y un id de enviado perdido.
  it('serializa el contacto además de deduplicar el mensaje', async () => {
    const { db, registro } = dbFalso([{ contact_id: 'c1' }]);
    await tomarMensaje('c1', 'm-99', db as never);
    expect(registro.or).toHaveLength(2);
    const filtros = registro.or.join(' | ');
    expect(filtros).toContain('procesando_hasta.is.null');
    expect(filtros).toContain('procesando_hasta.lt.');
  });

  it('estampa un arriendo con vencimiento en el futuro', async () => {
    const { db, registro } = dbFalso([{ contact_id: 'c1' }]);
    await tomarMensaje('c1', 'm-99', db as never);
    const hasta = Date.parse(registro.update?.procesando_hasta as string);
    expect(hasta).toBeGreaterThan(Date.now());
  });

  it('rechaza un id con caracteres que romperían el filtro, en vez de inyectarlo', async () => {
    const { db } = dbFalso([{ contact_id: 'c1' }]);
    await expect(tomarMensaje('c1', 'm,99)', db as never)).rejects.toThrow();
  });

  // Un fallo de base y un duplicado legítimo producen el mismo `data` vacío.
  // Si esto devolviera false, el agente se saltaría en silencio a un cliente
  // real y en el log parecería un reintento normal de GHL.
  it('lanza si la base falla, en vez de devolver false', async () => {
    const { db } = dbFalso([], { message: 'connection reset' });
    await expect(tomarMensaje('c1', 'm-99', db as never)).rejects.toThrow(/connection reset/);
  });
});

// Doble del cliente para las rutas de lectura y alta.
function dbLectura(fila: unknown, error: unknown = null, errorAlta: unknown = null) {
  const registro: { upsert?: unknown; opciones?: unknown } = {};
  const db = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: fila, error }) }) }),
      upsert: async (nueva: unknown, opciones: unknown) => {
        registro.upsert = nueva;
        registro.opciones = opciones;
        return { error: errorAlta };
      },
    }),
  };
  return { db, registro };
}

// Refleja la tabla real: `select('*')` devuelve TODAS las columnas, así que el
// fixture tiene que traerlas todas o la prueba de paridad de claves compara la
// rama nueva contra una fila incompleta y falla por un motivo falso.
const FILA_COMPLETA = {
  contact_id: 'c1', conversation_id: null, canal: null, estado: 'activo',
  turnos: 0, datos: {}, ultimo_mensaje_id: null, procesando_hasta: null,
  enviados: [], notificado_at: null,
};

describe('leerOCrear', () => {
  it('devuelve la fila existente con los datos completados', async () => {
    const { db } = dbLectura({ ...FILA_COMPLETA, turnos: 2, datos: { nombre: 'Ana Pérez' } });
    const fila = await leerOCrear('c1', db as never);
    expect(fila.turnos).toBe(2);
    expect(fila.datos).toEqual({ ...DATOS_VACIOS, nombre: 'Ana Pérez' });
  });

  it('da de alta el contacto la primera vez que lo ve', async () => {
    const { db, registro } = dbLectura(null);
    const fila = await leerOCrear('c1', db as never);
    expect(fila.estado).toBe('activo');
    expect(fila.turnos).toBe(0);
    expect(registro.upsert).toMatchObject({ contact_id: 'c1' });
  });

  // Un upsert normal PISA la fila si otra invocación la creó entre nuestro
  // select y este insert, y la pisaría con estado 'activo' y enviados vacío.
  // Con dos webhooks simultáneos sobre un contacto que un asesor acaba de
  // tomar, eso resucitaría un contacto recién marcado 'humano'.
  it('no pisa la fila si otra invocación ganó la creación', async () => {
    const { db, registro } = dbLectura(null);
    await leerOCrear('c1', db as never);
    expect(registro.opciones).toMatchObject({ ignoreDuplicates: true });
  });

  // Si las dos ramas devolvieran formas distintas, los consumidores fallarían
  // de maneras difíciles de rastrear: sólo con contactos nuevos, o sólo con
  // los ya vistos.
  it('las dos ramas devuelven exactamente las mismas claves', async () => {
    const existente = await leerOCrear('c1', dbLectura(FILA_COMPLETA).db as never);
    const nueva = await leerOCrear('c1', dbLectura(null).db as never);
    expect(Object.keys(nueva).sort()).toEqual(Object.keys(existente).sort());
  });

  // El caso grave: Supabase devuelve data null tanto si el contacto no existe
  // como si la consulta falló. Tratar el fallo como contacto nuevo resucitaría
  // a uno marcado 'humano' con los turnos a cero, y el agente volvería a hablar
  // encima del asesor.
  it('lanza si la lectura falla, en vez de fingir un contacto nuevo', async () => {
    const { db } = dbLectura(null, { message: 'timeout' });
    await expect(leerOCrear('c1', db as never)).rejects.toThrow(/timeout/);
  });

  it('lanza si el alta falla', async () => {
    const { db } = dbLectura(null, null, { message: 'conflicto' });
    await expect(leerOCrear('c1', db as never)).rejects.toThrow(/conflicto/);
  });
});

function dbGuardar(error: unknown = null) {
  const registro: { update?: Record<string, unknown> } = {};
  const db = {
    from: () => ({
      update: (campos: Record<string, unknown>) => {
        registro.update = campos;
        return { eq: async () => ({ error }) };
      },
    }),
  };
  return { db, registro };
}

describe('guardar', () => {
  it('escribe los cambios y sella updated_at', async () => {
    const { db, registro } = dbGuardar();
    await guardar('c1', { turnos: 3 }, db as never);
    expect(registro.update).toMatchObject({ turnos: 3 });
    expect(typeof registro.update?.updated_at).toBe('string');
  });

  // No lanza a propósito: al cliente ya se le respondió y fallar el turno no
  // desharía el envío. Pero tiene que verse, porque perder esta escritura
  // pierde el id que alimenta la guarda del humano.
  it('devuelve undefined cuando la escritura sale bien', async () => {
    const { db } = dbGuardar();
    await expect(guardar('c1', { turnos: 3 }, db as never)).resolves.toBeUndefined();
  });

  // No lanza —al cliente ya se le respondió— pero sí devuelve el error, porque
  // hay una llamada (el latch de 'humano') donde perder la escritura significa
  // que el agente puede volver a hablarle encima a un asesor.
  it('no lanza si la escritura falla, pero devuelve el error y lo registra', async () => {
    const espia = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db } = dbGuardar({ message: 'disco lleno' });
    await expect(guardar('c1', { turnos: 3 }, db as never)).resolves.toBe('disco lleno');
    expect(espia).toHaveBeenCalled();
    espia.mockRestore();
  });
});
