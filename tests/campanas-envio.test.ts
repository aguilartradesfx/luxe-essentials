// tests/campanas-envio.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { crearCampana, enviarTanda, TAMANO_TANDA, MINUTOS_RESERVA_VENCIDA } from '@/lib/campanas/envio';
import { filtrarPermitidosParaCampana } from '@/lib/campanas/exclusiones';
import type { DestinatarioCampana } from '@/lib/campanas/contactos';

// `crearCampana` exige `Permitido<DestinatarioCampana>[]` -- el único modo
// de conseguir uno de verdad es pasar por `filtrarPermitidosParaCampana`
// (ver el comentario grande de exclusiones.ts sobre el símbolo no
// exportado). Se usa acá, con una base sin bajas registradas, para que las
// pruebas trabajen con el tipo real y no con un `as any` que se saltaría
// justo la garantía que este diseño protege.
async function permitidos(destinatarios: DestinatarioCampana[]) {
  const dbSinBajas = { from: () => ({ select: async () => ({ data: [], error: null }) }) };
  return filtrarPermitidosParaCampana(destinatarios, dbSinBajas);
}

const destinatariosCrudos: DestinatarioCampana[] = [
  { contactId: 'c-1', correo: 'Ana@Hotel.com', nombreCrm: 'Ana Rodríguez' },
  { contactId: 'c-2', correo: 'beto@hotel.com', nombreCrm: 'restaurante ardere' },
];

function mockCampanasInsert(resultado: { data: any; error: any }) {
  const single = vi.fn().mockResolvedValue(resultado);
  const select = vi.fn(() => ({ single }));
  const insert = vi.fn(() => ({ select }));
  return { insert, select, single };
}

function mockEnviosUpsert(resultado: { data: any; error: any }) {
  const select = vi.fn().mockResolvedValue(resultado);
  const upsert = vi.fn((_filas: any[], _opciones: Record<string, unknown>) => ({ select }));
  return { upsert, select };
}

function dbParaCrear(resultadoCampana: any, resultadoEnvios: any) {
  const campanas = mockCampanasInsert(resultadoCampana);
  const envios = mockEnviosUpsert(resultadoEnvios);
  const from = vi.fn((tabla: string) => {
    if (tabla === 'campanas') return campanas;
    if (tabla === 'campanas_envios') return envios;
    throw new Error(`tabla no mockeada en esta prueba: ${tabla}`);
  });
  return { from, rpc: vi.fn(), campanas, envios };
}

const paramsCampana = {
  plantilla: 'inicial' as const,
  asunto: 'Asunto de prueba',
  html: 'Buenos días{{nombre}}: de parte de {{empresa}}. {{unsubscribe_url}}',
  creadoPor: 'guillermo',
};

describe('crearCampana', () => {
  it('crea la fila de campanas y una fila por destinatario, y devuelve el conteo', async () => {
    const dest = await permitidos(destinatariosCrudos);
    const db = dbParaCrear(
      { data: { id: 'camp-1' }, error: null },
      { data: [{ id: 'e-1' }, { id: 'e-2' }], error: null },
    );

    const r = await crearCampana(paramsCampana, dest, db as any);
    expect(r).toEqual({ ok: true, campanaId: 'camp-1', destinatarios: 2 });

    expect(db.campanas.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        plantilla: 'inicial',
        asunto: 'Asunto de prueba',
        creado_por: 'guillermo',
      }),
    );
  });

  it('normaliza el correo (minúsculas, sin espacios) antes de guardarlo', async () => {
    const dest = await permitidos(destinatariosCrudos);
    const db = dbParaCrear({ data: { id: 'camp-1' }, error: null }, { data: [{ id: 'e-1' }], error: null });

    await crearCampana(paramsCampana, dest, db as any);

    const [filas] = db.envios.upsert.mock.calls[0];
    expect(filas[0].correo).toBe('ana@hotel.com');
  });

  // Mata el mutante que usara `insert` a secas en vez de `upsert` con
  // `ignoreDuplicates`: sin esto, dos destinatarios con el mismo correo (la
  // base trae 339 casos reales, ver docs/ghl-base-comercial-2026.md)
  // tumbarían la creación entera de la campaña contra el índice único de la
  // migración 0019.
  it('usa upsert con onConflict campana_id,correo e ignoreDuplicates: true', async () => {
    const dest = await permitidos(destinatariosCrudos);
    const db = dbParaCrear({ data: { id: 'camp-1' }, error: null }, { data: [{ id: 'e-1' }], error: null });

    await crearCampana(paramsCampana, dest, db as any);

    const [, opciones] = db.envios.upsert.mock.calls[0];
    expect(opciones).toEqual({ onConflict: 'campana_id,correo', ignoreDuplicates: true });
  });

  it('sin asunto, no llega a tocar la base', async () => {
    const dest = await permitidos(destinatariosCrudos);
    const db = dbParaCrear({ data: { id: 'camp-1' }, error: null }, { data: [], error: null });

    const r = await crearCampana({ ...paramsCampana, asunto: '  ' }, dest, db as any);
    expect(r.ok).toBe(false);
    expect(db.campanas.insert).not.toHaveBeenCalled();
  });

  it('sin html, no llega a tocar la base', async () => {
    const dest = await permitidos(destinatariosCrudos);
    const db = dbParaCrear({ data: { id: 'camp-1' }, error: null }, { data: [], error: null });

    const r = await crearCampana({ ...paramsCampana, html: '' }, dest, db as any);
    expect(r.ok).toBe(false);
    expect(db.campanas.insert).not.toHaveBeenCalled();
  });

  it('sin destinatarios, no llega a tocar la base', async () => {
    const db = dbParaCrear({ data: { id: 'camp-1' }, error: null }, { data: [], error: null });
    const r = await crearCampana(paramsCampana, [], db as any);
    expect(r).toEqual({ ok: false, error: expect.stringContaining('destinatarios') });
    expect(db.campanas.insert).not.toHaveBeenCalled();
  });

  it('si falla la creación de la campaña, no intenta registrar destinatarios', async () => {
    const dest = await permitidos(destinatariosCrudos);
    const db = dbParaCrear({ data: null, error: { message: 'boom' } }, { data: [], error: null });

    const r = await crearCampana(paramsCampana, dest, db as any);
    expect(r.ok).toBe(false);
    expect(db.envios.upsert).not.toHaveBeenCalled();
  });

  it('si falla el registro de destinatarios, devuelve el error de la base', async () => {
    const dest = await permitidos(destinatariosCrudos);
    const db = dbParaCrear(
      { data: { id: 'camp-1' }, error: null },
      { data: null, error: { message: 'constraint violada' } },
    );

    const r = await crearCampana(paramsCampana, dest, db as any);
    expect(r).toEqual({ ok: false, error: expect.stringContaining('constraint violada') });
  });
});

// ---------------------------------------------------------------------

function mockCampanasSelect(resultado: any) {
  const maybeSingle = vi.fn().mockResolvedValue(resultado);
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  return { select, eq, maybeSingle };
}

function dbParaEnviar(p: { campana: any; reclamo: any; errorAlActualizar?: boolean }) {
  const campanasMock = mockCampanasSelect(p.campana);
  const eqUpdate = vi.fn().mockResolvedValue(p.errorAlActualizar ? { error: { message: 'db caída' } } : { error: null });
  const update = vi.fn(() => ({ eq: eqUpdate }));
  const enviosMock = { update };
  const from = vi.fn((tabla: string) => {
    if (tabla === 'campanas') return campanasMock;
    if (tabla === 'campanas_envios') return enviosMock;
    throw new Error(`tabla no mockeada en esta prueba: ${tabla}`);
  });
  const rpc = vi.fn().mockResolvedValue(p.reclamo);
  return { from, rpc, campanasMock, enviosMock, update, eqUpdate };
}

const campanaGuardada = {
  data: { asunto: 'Asunto de prueba', html: 'Hola{{nombre}}, de {{empresa}}: {{unsubscribe_url}}' },
  error: null,
};

function filaReclamada(i: number) {
  return { id: `env-${i}`, correo: `c${i}@hotel.com`, nombre_crm: 'Ana Rodríguez' };
}

function respuestaResend(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as unknown as Response;
}

const depsEnvio = { resendApiKey: 'llave', remitente: 'Luxe <campanas@luxe.cr>' };

describe('enviarTanda', () => {
  beforeEach(() => {
    process.env.LUXE_BAJA_SECRETO = 'secreta';
  });

  it('reclama la tanda vía rpc con el límite correcto y manda un solo lote a Resend', async () => {
    const filas = [filaReclamada(1), filaReclamada(2)];
    const db = dbParaEnviar({ campana: campanaGuardada, reclamo: { data: filas, error: null } });
    const fetchImpl = vi.fn().mockResolvedValue(respuestaResend({ data: [{ id: 'r-1' }, { id: 'r-2' }] }));

    const r = await enviarTanda('camp-1', { ...depsEnvio, fetchImpl }, db as any);

    expect(db.rpc).toHaveBeenCalledWith(
      'campanas_reclamar_pendientes',
      expect.objectContaining({ p_campana_id: 'camp-1', p_limite: TAMANO_TANDA }),
    );
    // Un solo POST a Resend por tanda -- el punto entero del endpoint de
    // lote (ver el comentario de TAMANO_TANDA).
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.resend.com/emails/batch');
    expect(r).toEqual({ ok: true, procesados: 2, enviados: 2, fallidos: 0, terminada: true });
  });

  it('el cuerpo a Resend trae el asunto, el html con marcadores resueltos y las cabeceras de baja', async () => {
    const db = dbParaEnviar({ campana: campanaGuardada, reclamo: { data: [filaReclamada(1)], error: null } });
    const fetchImpl = vi.fn().mockResolvedValue(respuestaResend({ data: [{ id: 'r-1' }] }));

    await enviarTanda('camp-1', { ...depsEnvio, fetchImpl }, db as any);

    const cuerpo = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(cuerpo).toHaveLength(1);
    expect(cuerpo[0].from).toBe('Luxe <campanas@luxe.cr>');
    expect(cuerpo[0].to).toEqual(['c1@hotel.com']);
    expect(cuerpo[0].subject).toBe('Asunto de prueba');
    expect(cuerpo[0].html).toContain('Hola, Ana, de Ana Rodríguez:');
    expect(cuerpo[0].html).toContain('https://luxeessentialscr.com/baja?t=');
    expect(cuerpo[0].headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(cuerpo[0].headers['List-Unsubscribe']).toContain('/api/baja?t=');
  });

  it('p_vencido_desde se calcula restando MINUTOS_RESERVA_VENCIDA al reloj inyectado', async () => {
    const db = dbParaEnviar({ campana: campanaGuardada, reclamo: { data: [], error: null } });
    const ahora = () => new Date('2026-09-08T12:00:00.000Z');

    await enviarTanda('camp-1', { ...depsEnvio, ahora }, db as any);

    const esperado = new Date(Date.parse('2026-09-08T12:00:00.000Z') - MINUTOS_RESERVA_VENCIDA * 60_000).toISOString();
    expect(db.rpc).toHaveBeenCalledWith('campanas_reclamar_pendientes', expect.objectContaining({ p_vencido_desde: esperado }));
  });

  it('sin candidatos pendientes: no llama a Resend y avisa que terminó', async () => {
    const db = dbParaEnviar({ campana: campanaGuardada, reclamo: { data: [], error: null } });
    const fetchImpl = vi.fn();

    const r = await enviarTanda('camp-1', { ...depsEnvio, fetchImpl }, db as any);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: true, procesados: 0, enviados: 0, fallidos: 0, terminada: true });
  });

  it('terminada: false cuando la tanda reclamada viene completa (puede haber más)', async () => {
    const filas = Array.from({ length: TAMANO_TANDA }, (_, i) => filaReclamada(i));
    const db = dbParaEnviar({ campana: campanaGuardada, reclamo: { data: filas, error: null } });
    const fetchImpl = vi.fn().mockResolvedValue(
      respuestaResend({ data: filas.map((_, i) => ({ id: `r-${i}` })) }),
    );

    const r = await enviarTanda('camp-1', { ...depsEnvio, fetchImpl }, db as any);
    expect(r).toMatchObject({ ok: true, terminada: false, procesados: TAMANO_TANDA });
  });

  // El destinatario cuyo índice no trae `id` en la respuesta de Resend se
  // marca 'error' -- y el resto de la tanda sigue su curso normal como
  // 'enviado'. Mata el mutante que ignorara un fallo puntual y marcara todo
  // como enviado igual.
  it('un fallo puntual de un destinatario no tumba al resto de la tanda', async () => {
    const filas = [filaReclamada(1), filaReclamada(2), filaReclamada(3)];
    const db = dbParaEnviar({ campana: campanaGuardada, reclamo: { data: filas, error: null } });
    // El del medio no trae id: Resend no lo confirmó.
    const fetchImpl = vi.fn().mockResolvedValue(
      respuestaResend({ data: [{ id: 'r-1' }, {}, { id: 'r-3' }] }),
    );

    const r = await enviarTanda('camp-1', { ...depsEnvio, fetchImpl }, db as any);

    expect(r).toEqual({ ok: true, procesados: 3, enviados: 2, fallidos: 1, terminada: true });
    expect(db.update).toHaveBeenCalledWith(
      expect.objectContaining({ estado: 'enviado', resend_id: 'r-1' }),
    );
    expect(db.update).toHaveBeenCalledWith(
      expect.objectContaining({ estado: 'error' }),
    );
    expect(db.eqUpdate).toHaveBeenCalledWith('id', 'env-2');
  });

  // El corazón del diseño de "retomable ante un fallo de Resend": si la
  // tanda ENTERA falla, ninguna fila se marca -- se deja la reserva viva
  // para que `campanas_reclamar_pendientes` la vuelva a entregar sola.
  it('si Resend falla la tanda entera (red caída), no marca ninguna fila', async () => {
    const filas = [filaReclamada(1), filaReclamada(2)];
    const db = dbParaEnviar({ campana: campanaGuardada, reclamo: { data: filas, error: null } });
    const fetchImpl = vi.fn().mockRejectedValue(new Error('sin red'));

    const r = await enviarTanda('camp-1', { ...depsEnvio, fetchImpl }, db as any);

    expect(r).toEqual({ ok: false, error: expect.stringContaining('sin red') });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('si Resend responde 4xx/5xx para la tanda entera, no marca ninguna fila', async () => {
    const filas = [filaReclamada(1)];
    const db = dbParaEnviar({ campana: campanaGuardada, reclamo: { data: filas, error: null } });
    const fetchImpl = vi.fn().mockResolvedValue(respuestaResend({ message: 'no autorizado' }, 401));

    const r = await enviarTanda('camp-1', { ...depsEnvio, fetchImpl }, db as any);

    expect(r).toEqual({ ok: false, error: expect.stringContaining('401') });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('si Resend responde con JSON ilegible, no marca ninguna fila', async () => {
    const filas = [filaReclamada(1)];
    const db = dbParaEnviar({ campana: campanaGuardada, reclamo: { data: filas, error: null } });
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => 'no es json' });

    const r = await enviarTanda('camp-1', { ...depsEnvio, fetchImpl }, db as any);

    expect(r.ok).toBe(false);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('sin RESEND_API_KEY, no llega ni a consultar la campaña', async () => {
    const db = dbParaEnviar({ campana: campanaGuardada, reclamo: { data: [], error: null } });
    const r = await enviarTanda('camp-1', { ...depsEnvio, resendApiKey: '' }, db as any);
    expect(r.ok).toBe(false);
    expect(db.campanasMock.select).not.toHaveBeenCalled();
  });

  it('sin remitente, no llega ni a consultar la campaña', async () => {
    const db = dbParaEnviar({ campana: campanaGuardada, reclamo: { data: [], error: null } });
    const r = await enviarTanda('camp-1', { ...depsEnvio, remitente: '' }, db as any);
    expect(r.ok).toBe(false);
    expect(db.campanasMock.select).not.toHaveBeenCalled();
  });

  it('si la campaña no existe, devuelve un error legible y no reclama nada', async () => {
    const db = dbParaEnviar({ campana: { data: null, error: null }, reclamo: { data: [], error: null } });
    const r = await enviarTanda('camp-inexistente', depsEnvio, db as any);
    expect(r).toEqual({ ok: false, error: expect.stringContaining('camp-inexistente') });
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('si el rpc de reclamo falla, devuelve el error sin llamar a Resend', async () => {
    const db = dbParaEnviar({ campana: campanaGuardada, reclamo: { data: null, error: { message: 'lock timeout' } } });
    const fetchImpl = vi.fn();
    const r = await enviarTanda('camp-1', { ...depsEnvio, fetchImpl }, db as any);
    expect(r).toEqual({ ok: false, error: expect.stringContaining('lock timeout') });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('un fallo al escribir el resultado final se registra pero no rompe la tanda', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const filas = [filaReclamada(1)];
    const db = dbParaEnviar({ campana: campanaGuardada, reclamo: { data: filas, error: null }, errorAlActualizar: true });
    const fetchImpl = vi.fn().mockResolvedValue(respuestaResend({ data: [{ id: 'r-1' }] }));

    const r = await enviarTanda('camp-1', { ...depsEnvio, fetchImpl }, db as any);

    expect(r).toEqual({ ok: true, procesados: 1, enviados: 1, fallidos: 0, terminada: true });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
