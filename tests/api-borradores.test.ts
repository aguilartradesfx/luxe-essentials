import { describe, it, expect, vi, beforeEach } from 'vitest';

const filas = [
  {
    id: 'cot-1',
    created_at: '2026-08-26T10:00:00Z',
    contact_id: 'c1',
    cliente: { nombre: 'Ana Pérez', email: 'ana@hotel.com', producto: 'uniformes', cantidadTexto: '300 piezas' },
  },
];

const filtros: [string, string][] = [];

vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: () => ({
    from: () => {
      const encadenable: Record<string, unknown> = {
        eq: (columna: string, valor: string) => {
          filtros.push([columna, valor]);
          return encadenable;
        },
        order: () => encadenable,
        limit: async () => ({ data: filas, error: null }),
      };
      return { select: () => encadenable };
    },
  }),
}));

const { POST } = await import('@/app/api/cotizacion/borradores/route');
const { emitirSesion } = await import('@/lib/sesion');

function peticion(cuerpo: unknown, cabeceras: Record<string, string> = {}) {
  return new Request('http://localhost/api/cotizacion/borradores', {
    method: 'POST',
    headers: cabeceras,
    body: JSON.stringify(cuerpo),
  });
}

// Fase 3: la clave compartida ya no autentica; esta ruta es de solo lectura y
// no exige CSRF, así que basta con la cookie de sesión.
function peticionAutenticada(cuerpo: unknown) {
  const { cookie } = emitirSesion('Guillermo Rojas', 'vendedor', 'aaaaaaaa-0000-4000-8000-000000000001');
  return peticion(cuerpo, { cookie: cookie.split(';')[0] });
}

describe('POST /api/cotizacion/borradores', () => {
  beforeEach(() => {
    process.env.LUXE_SESION_SECRETO = 'secreta';
    // `filtros` vive fuera del módulo mockeado (es del propio archivo de
    // prueba), así que sin este reset se va acumulando entre pruebas: la de
    // "devuelve los borradores pendientes" ya deja dos entradas antes de que
    // corra esta, y la aserción de abajo dejaría de reflejar una sola
    // consulta. Corrección respecto del código del brief, que no lo reseteaba.
    filtros.length = 0;
  });

  it('rechaza sin sesión', async () => {
    const res = await POST(peticion({}));
    expect(res.status).toBe(401);
  });

  it('devuelve los borradores pendientes', async () => {
    const res = await POST(peticionAutenticada({}));
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.borradores).toHaveLength(1);
    expect(cuerpo.borradores[0].cliente.cantidadTexto).toBe('300 piezas');
  });

  it('rechaza un cuerpo que no es JSON', async () => {
    const res = await POST(
      new Request('http://localhost/api/cotizacion/borradores', { method: 'POST', body: 'x' }),
    );
    expect(res.status).toBe(400);
  });

  it('filtra por estado borrador y por origen agente', async () => {
    // Sin el filtro de origen, una cotización humana en vuelo hacia GoHighLevel
    // aparecería en la cola del agente.
    await POST(peticionAutenticada({}));
    expect(filtros).toEqual([
      ['estado', 'borrador'],
      ['origen', 'agente'],
    ]);
  });
});
