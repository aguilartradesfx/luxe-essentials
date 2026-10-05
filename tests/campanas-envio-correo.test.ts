import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enviarTanda, URL_BAJA_INERTE } from '@/lib/campanas/envio';
import { leerCorreoEnviado } from '@/lib/campanas/envio-correo';
import { generarTokenBaja, enlacePaginaBaja } from '@/lib/campanas/baja';

// El correo que se muestra al hacer clic en una fila tiene que ser el que
// salió. La prueba central NO compara contra un texto escrito a mano: manda
// la campana por `enviarTanda` de verdad (con un `fetch` que captura lo que
// iria al proveedor) y compara asunto y cuerpo con lo que devuelve
// `leerCorreoEnviado` para la misma fila.

const CAMPANA = {
  id: 'c-1',
  asunto: 'Cotizacion para su hotel',
  // Sin preheader propio: obliga a pasar por `inyectarVistaPrevia`.
  html: '<html><body><p>Hola{{nombre}}, {{empresa}}</p><a href="{{unsubscribe_url}}">Darme de baja</a></body></html>',
  preview_text: 'Texto de bandeja',
  zona: 'Zona Norte',
  plantilla: 'personalizada',
  cancelada_at: null,
};
const FILA = { id: 'e-1', correo: 'ana@hotel.cr', nombre_crm: 'Ana Rodriguez', estado: 'enviado', actualizado_at: '2026-09-20T15:00:00+00:00', campana_id: 'c-1' };

function dbLectura(filas: any[] = [FILA], campanas: any[] = [CAMPANA]) {
  const nodo = (tabla: string) => {
    const conds: [string, unknown][] = [];
    let estados: unknown[] | null = null;
    const n: any = {
      select: () => n,
      eq: (c: string, v: unknown) => (conds.push([c, v]), n),
      in: (_c: string, vs: unknown[]) => ((estados = vs), n),
      maybeSingle: async () => {
        const fuente = tabla === 'campanas_envios' ? filas : campanas;
        const r = fuente.find((f) => conds.every(([c, v]) => f[c] === v) && (!estados || estados.includes(f.estado)));
        return { data: r ?? null, error: null };
      },
    };
    return n;
  };
  return { from: nodo };
}

async function loQueSale(): Promise<{ subject: string; html: string }> {
  const capturado = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data: [{ id: 'r-1' }] }),
  });
  const db = {
    from: (t: string) => {
      if (t !== 'campanas') throw new Error(t);
      const n: any = { select: () => n, eq: () => n, maybeSingle: async () => ({ data: CAMPANA, error: null }) };
      return n;
    },
    rpc: async (nombre: string) =>
      nombre === 'campanas_reclamar_pendientes'
        ? { data: [{ id: FILA.id, correo: FILA.correo, nombre_crm: FILA.nombre_crm }], error: null }
        : { data: 1, error: null },
  };
  await enviarTanda('c-1', { resendApiKey: 'k', remitente: 'Luxe <a@b.cr>', fetchImpl: capturado }, db as any);
  const cuerpo = JSON.parse(capturado.mock.calls[0][1].body);
  return cuerpo[0];
}

beforeEach(() => {
  process.env.LUXE_BAJA_SECRETO = 'secreta-de-baja';
});

describe('leerCorreoEnviado', () => {
  // Es el mismo correo que salio, con UNA diferencia deliberada: el enlace
  // de baja. Todo lo demas -- asunto, diseno, saludo, nombre de la empresa,
  // texto de bandeja -- tiene que coincidir caracter por caracter, porque se
  // arma con la misma funcion. Si algun dia se separan, esta prueba cae.
  it('es el mismo asunto y el mismo cuerpo que salieron por enviarTanda, salvo el enlace de baja', async () => {
    const salido = await loQueSale();
    const visto = await leerCorreoEnviado(dbLectura() as any, 'e-1');
    expect(visto).not.toBeNull();
    expect(visto!.asunto).toBe(salido.subject);

    const enlaceReal = enlacePaginaBaja('ana@hotel.cr');
    expect(salido.html).toContain(enlaceReal);
    expect(visto!.html).toBe(salido.html.split(enlaceReal).join(URL_BAJA_INERTE));
  });

  // Hallazgo de la verificacion en produccion (2026-10-05): el enlace de
  // baja es una LLAVE -- un token firmado que da de baja a esa empresa a
  // quien lo tenga. La vista previa lo acunaba igual que un envio real, asi
  // que viajaba hasta el navegador y se limpiaba recien al pintarlo. El
  // marco aislado impide el clic, pero no impide copiarlo de las
  // herramientas del navegador. Ahora no se acuna nunca.
  it('NUNCA trae el token de baja de esa persona -- no se acuna, no se tapa', async () => {
    const visto = await leerCorreoEnviado(dbLectura() as any, 'e-1');
    expect(visto!.html).not.toContain(generarTokenBaja('ana@hotel.cr'));
    expect(visto!.html).not.toMatch(/\/baja\?t=/);
    expect(visto!.html).toContain(URL_BAJA_INERTE);
  });

  it('trae todo resuelto: empresa, saludo y texto de bandeja, sin marcadores sin resolver', async () => {
    const visto = await leerCorreoEnviado(dbLectura() as any, 'e-1');
    expect(visto!.html).toContain('Hola, Ana, Ana Rodriguez');
    expect(visto!.html).toContain('Texto de bandeja');
    expect(visto!.html).not.toMatch(/\{\{/);
  });

  it('trae a quién, de qué empresa, zona y campana, y cuándo salió', async () => {
    const visto = await leerCorreoEnviado(dbLectura() as any, 'e-1');
    expect(visto).toMatchObject({
      destinatario: 'ana@hotel.cr',
      empresa: 'Ana Rodriguez',
      zona: 'Zona Norte',
      plantilla: 'personalizada',
      campanaId: 'c-1',
      enviadoAt: '2026-09-20T15:00:00+00:00',
      salio: true,
    });
  });

  it('un envio que quedo en error se reproduce, marcado como que no salio', async () => {
    const visto = await leerCorreoEnviado(dbLectura([{ ...FILA, estado: 'error' }]) as any, 'e-1');
    expect(visto!.salio).toBe(false);
  });

  it('uno pendiente (todavia no se mando) o inexistente: null', async () => {
    expect(await leerCorreoEnviado(dbLectura([{ ...FILA, estado: 'pendiente' }]) as any, 'e-1')).toBeNull();
    expect(await leerCorreoEnviado(dbLectura() as any, 'e-9')).toBeNull();
  });

  it('si la base falla, lanza (la ruta responde 500, no un correo vacio)', async () => {
    const roto = { from: () => { const n: any = { select: () => n, eq: () => n, in: () => n, maybeSingle: async () => ({ data: null, error: { message: 'caida' } }) }; return n; } };
    await expect(leerCorreoEnviado(roto as any, 'e-1')).rejects.toThrow(/caida/);
  });
});
