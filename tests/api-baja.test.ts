// tests/api-baja.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generarTokenBaja } from '@/lib/campanas/baja';

// Doble mínimo de `bajas_correo`: las dos rutas de este archivo sólo llaman
// a `upsert` (vía `registrarBaja`, lib/campanas/exclusiones.ts). Mismo
// patrón de tests/api-fijar-clave.test.ts: se registra cada llamada para
// poder afirmar qué se intentó escribir, sin arrastrar el cliente completo
// de Supabase.
let resultadoUpsert: { error: { message: string } | null };
let llamadasUpsert: { valores: unknown; opciones: unknown }[];

function reiniciarDoble() {
  resultadoUpsert = { error: null };
  llamadasUpsert = [];
}

vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      upsert: async (valores: unknown, opciones: unknown) => {
        llamadasUpsert.push({ valores, opciones });
        return resultadoUpsert;
      },
    }),
  }),
}));

const { POST: unClicPOST } = await import('@/app/api/baja/route');
const { POST: confirmarPOST } = await import('@/app/api/baja/confirmar/route');

describe('POST /api/baja (RFC 8058, baja de un clic)', () => {
  beforeEach(() => {
    process.env.LUXE_BAJA_SECRETO = 'secreta-de-baja';
    reiniciarDoble();
  });

  it('con un token válido en la URL, registra la baja con vía "un_clic"', async () => {
    const token = generarTokenBaja('ana@hotel.com');
    const res = await unClicPOST(new Request(`https://x/api/baja?t=${token}`, { method: 'POST' }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(llamadasUpsert).toEqual([
      {
        valores: { correo: 'ana@hotel.com', via: 'un_clic' },
        opciones: { onConflict: 'correo', ignoreDuplicates: true },
      },
    ]);
  });

  it('sin token en la URL, no registra nada y responde 400', async () => {
    const res = await unClicPOST(new Request('https://x/api/baja', { method: 'POST' }));
    expect(res.status).toBe(400);
    expect(llamadasUpsert).toEqual([]);
  });

  // El propio corazón de RFC 8058 acá: sin la firma correcta, este endpoint
  // es de acceso público sin ningún otro guardián (Tarea 3, "la firma del
  // enlace es toda su seguridad"). Un token con la firma cambiada no puede
  // dar de baja a nadie.
  it('con la firma alterada, no registra nada y responde 400', async () => {
    const token = generarTokenBaja('ana@hotel.com');
    const [codificado] = token.split('.');
    const res = await unClicPOST(
      new Request(`https://x/api/baja?t=${codificado}.firmainventada`, { method: 'POST' }),
    );
    expect(res.status).toBe(400);
    expect(llamadasUpsert).toEqual([]);
  });

  it('si falla la escritura, responde 500', async () => {
    const token = generarTokenBaja('ana@hotel.com');
    resultadoUpsert = { error: { message: 'sin red' } };
    const res = await unClicPOST(new Request(`https://x/api/baja?t=${token}`, { method: 'POST' }));
    expect(res.status).toBe(500);
  });

  // No exporta GET: nadie puede disparar la baja de un clic con sólo
  // visitar la URL en un navegador — RFC 8058 exige POST, y esta ruta no
  // ofrece ningún otro método que un cliente de correo pudiera invocar por
  // error.
  it('no expone un método GET', async () => {
    const modulo = await import('@/app/api/baja/route');
    expect((modulo as { GET?: unknown }).GET).toBeUndefined();
  });
});

describe('POST /api/baja/confirmar (botón explícito de la página pública)', () => {
  beforeEach(() => {
    process.env.LUXE_BAJA_SECRETO = 'secreta-de-baja';
    reiniciarDoble();
  });

  it('con un token válido, registra la baja con vía "pagina" y devuelve el correo', async () => {
    const token = generarTokenBaja('ana@hotel.com');
    const res = await confirmarPOST(
      new Request('https://x/api/baja/confirmar', {
        method: 'POST',
        body: JSON.stringify({ token }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, correo: 'ana@hotel.com' });
    expect(llamadasUpsert).toEqual([
      {
        valores: { correo: 'ana@hotel.com', via: 'pagina' },
        opciones: { onConflict: 'correo', ignoreDuplicates: true },
      },
    ]);
  });

  it('con un token inválido, no registra nada y responde 400', async () => {
    const res = await confirmarPOST(
      new Request('https://x/api/baja/confirmar', {
        method: 'POST',
        body: JSON.stringify({ token: 'inventado' }),
      }),
    );
    expect(res.status).toBe(400);
    expect(llamadasUpsert).toEqual([]);
  });

  it('con un cuerpo que no es JSON, responde 400 sin registrar nada', async () => {
    const res = await confirmarPOST(
      new Request('https://x/api/baja/confirmar', { method: 'POST', body: 'no es json' }),
    );
    expect(res.status).toBe(400);
    expect(llamadasUpsert).toEqual([]);
  });

  it('sin token en el cuerpo, responde 400', async () => {
    const res = await confirmarPOST(
      new Request('https://x/api/baja/confirmar', { method: 'POST', body: JSON.stringify({}) }),
    );
    expect(res.status).toBe(400);
    expect(llamadasUpsert).toEqual([]);
  });

  it('si falla la escritura, responde 500', async () => {
    const token = generarTokenBaja('ana@hotel.com');
    resultadoUpsert = { error: { message: 'sin red' } };
    const res = await confirmarPOST(
      new Request('https://x/api/baja/confirmar', { method: 'POST', body: JSON.stringify({ token }) }),
    );
    expect(res.status).toBe(500);
  });

  it('no expone un método GET', async () => {
    const modulo = await import('@/app/api/baja/confirmar/route');
    expect((modulo as { GET?: unknown }).GET).toBeUndefined();
  });
});
