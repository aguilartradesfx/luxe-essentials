import { describe, it, expect, vi } from 'vitest';
import { dentroDelLimite, ipDeLaPeticion, VENTANA_SEGUNDOS, TOPE_POR_VENTANA } from '@/lib/lead-limite-tasa';

// Doble fiel de `lead_limite_tasa_incrementar`
// (supabase/migrations/0025_lead_limite_tasa.sql): mismo criterio que
// tests/usuarios-autenticacion.test.ts con `usuarios_panel_intento_fallido`
// -- una reimplementación en JavaScript de la aritmética de la ventana
// deslizante, para poder afirmar sobre el contrato (qué se llama, con qué
// argumentos, qué decide) sin una base real. No prueba el SQL en sí.
function dbFalso() {
  const filas = new Map<string, { ventanaInicio: number; conteo: number }>();
  const llamadas: Array<{ nombre: string; argumentos: Record<string, unknown> }> = [];
  return {
    llamadas,
    filas,
    rpc: async (nombre: string, argumentos: Record<string, unknown>) => {
      llamadas.push({ nombre, argumentos });
      const ip = String(argumentos.p_ip);
      const ahora = new Date(String(argumentos.p_ahora)).getTime();
      const ventanaMs = Number(argumentos.p_ventana_segundos) * 1000;
      const tope = Number(argumentos.p_tope);

      const fila = filas.get(ip);
      let conteo: number;
      if (!fila || fila.ventanaInicio <= ahora - ventanaMs) {
        conteo = 1;
        filas.set(ip, { ventanaInicio: ahora, conteo });
      } else {
        conteo = fila.conteo + 1;
        filas.set(ip, { ventanaInicio: fila.ventanaInicio, conteo });
      }
      return { data: conteo <= tope, error: null };
    },
  };
}

describe('dentroDelLimite', () => {
  it('la primera petición de una IP entra dentro del límite', async () => {
    const db = dbFalso();
    expect(await dentroDelLimite(db, '203.0.113.1')).toBe(true);
  });

  it('exactamente TOPE_POR_VENTANA peticiones seguidas entran, la siguiente no', async () => {
    const db = dbFalso();
    const ahora = new Date('2026-08-26T10:00:00.000Z');
    for (let i = 0; i < TOPE_POR_VENTANA; i++) {
      expect(await dentroDelLimite(db, '203.0.113.1', ahora)).toBe(true);
    }
    expect(await dentroDelLimite(db, '203.0.113.1', ahora)).toBe(false);
  });

  it('dos IPs distintas no comparten cupo', async () => {
    const db = dbFalso();
    const ahora = new Date('2026-08-26T10:00:00.000Z');
    for (let i = 0; i < TOPE_POR_VENTANA; i++) {
      await dentroDelLimite(db, '203.0.113.1', ahora);
    }
    // La primera IP ya agotó su cupo -- la segunda, que nunca pidió nada,
    // sigue entera.
    expect(await dentroDelLimite(db, '203.0.113.1', ahora)).toBe(false);
    expect(await dentroDelLimite(db, '198.51.100.9', ahora)).toBe(true);
  });

  it('pasada la ventana, el cupo se reinicia', async () => {
    const db = dbFalso();
    const inicio = new Date('2026-08-26T10:00:00.000Z');
    for (let i = 0; i < TOPE_POR_VENTANA; i++) {
      await dentroDelLimite(db, '203.0.113.1', inicio);
    }
    expect(await dentroDelLimite(db, '203.0.113.1', inicio)).toBe(false);

    // Un segundo antes de que la ventana venza, sigue bloqueada.
    const casiVencida = new Date(inicio.getTime() + VENTANA_SEGUNDOS * 1000 - 1000);
    expect(await dentroDelLimite(db, '203.0.113.1', casiVencida)).toBe(false);

    // Justo después de la ventana, el cupo es nuevo.
    const vencida = new Date(inicio.getTime() + VENTANA_SEGUNDOS * 1000 + 1000);
    expect(await dentroDelLimite(db, '203.0.113.1', vencida)).toBe(true);
  });

  it('manda la ventana y el tope reales como parámetros del rpc', async () => {
    const db = dbFalso();
    await dentroDelLimite(db, '203.0.113.1', new Date('2026-08-26T10:00:00.000Z'));
    expect(db.llamadas[0]).toEqual({
      nombre: 'lead_limite_tasa_incrementar',
      argumentos: {
        p_ip: '203.0.113.1',
        p_ahora: '2026-08-26T10:00:00.000Z',
        p_ventana_segundos: VENTANA_SEGUNDOS,
        p_tope: TOPE_POR_VENTANA,
      },
    });
  });

  // No lanza, y no bloquea el formulario real por un problema de
  // infraestructura del contador -- mismo criterio que `registrarFallo` en
  // lib/cotizador/usuarios.ts.
  it('si la base falla, deja pasar (falla abierto) y lo registra', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = { rpc: async () => ({ data: null, error: { message: 'función inexistente' } }) };
    expect(await dentroDelLimite(db, '203.0.113.1')).toBe(true);
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});

describe('ipDeLaPeticion', () => {
  it('toma el primer valor de x-forwarded-for (el cliente original, no los proxies)', () => {
    const req = new Request('http://da-igual', { headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } });
    expect(ipDeLaPeticion(req)).toBe('203.0.113.7');
  });

  it('recorta espacios alrededor de la IP', () => {
    const req = new Request('http://da-igual', { headers: { 'x-forwarded-for': '  203.0.113.7  , 10.0.0.1' } });
    expect(ipDeLaPeticion(req)).toBe('203.0.113.7');
  });

  it('sin la cabecera, devuelve un valor fijo en vez de saltarse el límite', () => {
    const req = new Request('http://da-igual');
    expect(ipDeLaPeticion(req)).toBe('ip-desconocida');
  });

  // El punto entero de este orden: `x-forwarded-for` la escribe el cliente.
  // Si se leyera primero, un script que manda una IP inventada distinta en
  // cada petición cae en un cubo distinto cada vez y el límite no limita
  // nada. Las dos cabeceras `x-vercel-*`/`x-real-ip` las pone la red de
  // Vercel y no se pueden falsificar desde afuera.
  it('prefiere x-vercel-forwarded-for a un x-forwarded-for falsificado', () => {
    const req = new Request('http://da-igual', {
      headers: {
        'x-forwarded-for': '198.51.100.99',
        'x-vercel-forwarded-for': '203.0.113.7',
      },
    });
    expect(ipDeLaPeticion(req)).toBe('203.0.113.7');
  });

  it('prefiere x-real-ip a un x-forwarded-for falsificado', () => {
    const req = new Request('http://da-igual', {
      headers: {
        'x-forwarded-for': '198.51.100.99',
        'x-real-ip': '203.0.113.7',
      },
    });
    expect(ipDeLaPeticion(req)).toBe('203.0.113.7');
  });

  it('cae a x-forwarded-for cuando Vercel no puso ninguna de las suyas', () => {
    const req = new Request('http://da-igual', { headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } });
    expect(ipDeLaPeticion(req)).toBe('203.0.113.7');
  });

  it('salta una cabecera vacía en vez de devolver cadena vacía como IP', () => {
    const req = new Request('http://da-igual', {
      headers: { 'x-vercel-forwarded-for': '   ', 'x-real-ip': '203.0.113.7' },
    });
    expect(ipDeLaPeticion(req)).toBe('203.0.113.7');
  });
});
