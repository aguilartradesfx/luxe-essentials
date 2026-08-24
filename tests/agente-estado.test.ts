import { describe, it, expect, vi } from 'vitest';
import { fusionarDatos, tomarMensaje, DATOS_VACIOS } from '@/lib/agente/estado';

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
function dbFalso(filasDevueltas: unknown[]) {
  const registro: { or?: string; update?: unknown } = {};
  const db = {
    from: () => ({
      update: (campos: unknown) => {
        registro.update = campos;
        return {
          eq: () => ({
            or: (filtro: string) => {
              registro.or = filtro;
              return { select: async () => ({ data: filasDevueltas, error: null }) };
            },
          }),
        };
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
    expect(registro.or).toContain('ultimo_mensaje_id.is.null');
    expect(registro.or).toContain('ultimo_mensaje_id.neq.m-99');
  });

  it('rechaza un id con caracteres que romperían el filtro, en vez de inyectarlo', async () => {
    const { db } = dbFalso([{ contact_id: 'c1' }]);
    await expect(tomarMensaje('c1', 'm,99)', db as never)).rejects.toThrow();
  });
});
