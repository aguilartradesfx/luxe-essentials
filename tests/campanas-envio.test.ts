// tests/campanas-envio.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { crearCampana, enviarTanda, cancelarCampana, TAMANO_TANDA, MINUTOS_RESERVA_VENCIDA } from '@/lib/campanas/envio';
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

  // Punto 1 del encargo ("cancelar"): la campaña ya viene cancelada -- ni
  // siquiera se llega a llamar al rpc de reclamo, y mucho menos a Resend.
  // Mata al mutante que borrara este chequeo entero (`if (campana.cancelada_at)`):
  // sin él, esta prueba fallaría porque `db.rpc` SÍ se llamaría.
  it('si la campaña ya está cancelada, no reclama nada ni llama a Resend', async () => {
    const db = dbParaEnviar({
      campana: { data: { ...campanaGuardada.data, cancelada_at: '2026-01-01T00:00:00.000Z' }, error: null },
      reclamo: { data: [], error: null },
    });
    const fetchImpl = vi.fn();

    const r = await enviarTanda('camp-1', { ...depsEnvio, fetchImpl }, db as any);

    expect(r).toEqual({ ok: true, procesados: 0, enviados: 0, fallidos: 0, terminada: true, cancelada: true });
    expect(db.rpc).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------

function mockCampanasUpdate(resultado: { error: any }) {
  const eqUpdate = vi.fn().mockResolvedValue(resultado);
  const update = vi.fn(() => ({ eq: eqUpdate }));
  return { update, eqUpdate };
}

function dbParaCancelar(p: { campana: any; errorAlEscribir?: boolean }) {
  const lectura = mockCampanasSelect(p.campana);
  const escritura = mockCampanasUpdate(p.errorAlEscribir ? { error: { message: 'db caída' } } : { error: null });
  const from = vi.fn((tabla: string) => {
    if (tabla === 'campanas') return { ...lectura, ...escritura };
    throw new Error(`tabla no mockeada en esta prueba: ${tabla}`);
  });
  return { from, rpc: vi.fn(), lectura, escritura };
}

describe('cancelarCampana', () => {
  it('marca cancelada_at/cancelada_por y devuelve yaEstabaCancelada:false', async () => {
    const db = dbParaCancelar({ campana: { data: { id: 'camp-1', cancelada_at: null }, error: null } });
    const ahora = () => new Date('2026-09-08T12:00:00.000Z');

    const r = await cancelarCampana('camp-1', 'Ana Solano', db as any, ahora);

    expect(r).toEqual({ ok: true, yaEstabaCancelada: false });
    expect(db.escritura.update).toHaveBeenCalledWith({
      cancelada_at: '2026-09-08T12:00:00.000Z',
      cancelada_por: 'Ana Solano',
    });
    expect(db.escritura.eqUpdate).toHaveBeenCalledWith('id', 'camp-1');
  });

  // Idempotente: cancelar una campaña ya cancelada no es un error, y no
  // vuelve a escribir nada (no pisa quién/cuándo la canceló la primera
  // vez). Mata al mutante que quitara el `if (campana.cancelada_at) return...`:
  // sin él, `db.escritura.update` SÍ se llamaría acá.
  it('si ya estaba cancelada, no vuelve a escribir y avisa yaEstabaCancelada:true', async () => {
    const db = dbParaCancelar({
      campana: { data: { id: 'camp-1', cancelada_at: '2026-01-01T00:00:00.000Z' }, error: null },
    });

    const r = await cancelarCampana('camp-1', 'Ana Solano', db as any);

    expect(r).toEqual({ ok: true, yaEstabaCancelada: true });
    expect(db.escritura.update).not.toHaveBeenCalled();
  });

  it('si la campaña no existe, devuelve un error con codigo "no_existe" y no escribe nada', async () => {
    const db = dbParaCancelar({ campana: { data: null, error: null } });

    const r = await cancelarCampana('camp-inexistente', 'Ana Solano', db as any);

    expect(r).toEqual({ ok: false, error: expect.stringContaining('camp-inexistente'), codigo: 'no_existe' });
    expect(db.escritura.update).not.toHaveBeenCalled();
  });

  it('si falla la lectura, devuelve el error de la base', async () => {
    const db = dbParaCancelar({ campana: { data: null, error: { message: 'timeout' } } });

    const r = await cancelarCampana('camp-1', 'Ana Solano', db as any);

    expect(r).toEqual({ ok: false, error: expect.stringContaining('timeout') });
  });

  it('si falla la escritura, devuelve el error de la base', async () => {
    const db = dbParaCancelar({
      campana: { data: { id: 'camp-1', cancelada_at: null }, error: null },
      errorAlEscribir: true,
    });

    const r = await cancelarCampana('camp-1', 'Ana Solano', db as any);

    expect(r).toEqual({ ok: false, error: expect.stringContaining('db caída') });
  });
});

// ---------------------------------------------------------------------
// La carrera que el encargo pide resolver Y anclar con una prueba: "puede
// haber una tanda en vuelo justo cuando se cancela". Un doble de Supabase
// EN MEMORIA (a diferencia de `dbParaEnviar`, que devuelve siempre la misma
// respuesta fija) -- porque acá `cancelarCampana` y `enviarTanda` tienen que
// operar sobre el MISMO estado mutable para que la prueba tenga algo real
// que demostrar: que cancelar a mitad de una llamada a Resend no le impide
// a esa tanda terminar de mandarse, y que la tanda SIGUIENTE (la que
// reclamaría lo que quedó) ya no reclama nada.
//
// El `rpc` de este doble reproduce, en JavaScript, el filtro que la
// migración 0020 agrega DENTRO de `campanas_reclamar_pendientes`
// (`and not exists (select 1 from campanas where ... cancelada_at is not
// null)`) -- es la pieza que de verdad cierra la ventana de la carrera del
// lado de la base; acá se reproduce su EFECTO (no reclama nada de una
// campaña cancelada) para poder probar, sin un Postgres real, que
// `enviarTanda` se comporta bien cuando la base se comporta así.
function dbEnMemoria(campanaInicial: Record<string, any>, enviosIniciales: Record<string, any>[]) {
  const campana = { ...campanaInicial };
  const envios = enviosIniciales.map((e) => ({ ...e }));

  function nodoCampanas() {
    const filtros: [string, unknown][] = [];
    const nodo: any = {
      select() {
        return nodo;
      },
      eq(c: string, v: unknown) {
        filtros.push([c, v]);
        return nodo;
      },
      maybeSingle: async () => {
        const idPedido = filtros.find(([c]) => c === 'id')?.[1];
        if (idPedido !== undefined && idPedido !== campana.id) return { data: null, error: null };
        return { data: { ...campana }, error: null };
      },
      update: (cambios: Record<string, unknown>) => ({
        eq: async (_c: string, v: unknown) => {
          if (v === campana.id) Object.assign(campana, cambios);
          return { error: null };
        },
      }),
    };
    return nodo;
  }

  function nodoEnvios() {
    return {
      update: (cambios: Record<string, unknown>) => ({
        eq: async (_c: string, id: string) => {
          const fila = envios.find((e) => e.id === id);
          if (fila) Object.assign(fila, cambios);
          return { error: null };
        },
      }),
    };
  }

  const from = vi.fn((tabla: string) => {
    if (tabla === 'campanas') return nodoCampanas();
    if (tabla === 'campanas_envios') return nodoEnvios();
    throw new Error(`tabla no mockeada en esta prueba: ${tabla}`);
  });

  const rpc = vi.fn(async (nombre: string, args: Record<string, unknown>) => {
    if (nombre !== 'campanas_reclamar_pendientes') throw new Error(`rpc no soportada: ${nombre}`);
    // Reproduce el `not exists (... cancelada_at is not null)` de la
    // migración 0020: la propia sentencia de reclamo deja de entregar nada
    // apenas la cancelación está escrita, sin que `enviarTanda` tenga que
    // enterarse por su cuenta.
    if (campana.cancelada_at) return { data: [], error: null };
    const pendientes = envios.filter((e) => e.campana_id === args.p_campana_id && e.estado === 'pendiente');
    const reclamadas = pendientes.slice(0, args.p_limite as number);
    for (const f of reclamadas) f.actualizado_at = new Date().toISOString();
    return { data: reclamadas.map((f) => ({ id: f.id, correo: f.correo, nombre_crm: f.nombre_crm })), error: null };
  });

  return { from, rpc, _campana: campana, _envios: envios };
}

describe('la carrera: cancelar mientras una tanda está en vuelo', () => {
  it('una tanda ya reclamada termina de mandarse entera, pero ninguna tanda siguiente reclama lo que quedó', async () => {
    // 101 pendientes -- uno más que TAMANO_TANDA -- para que la primera
    // tanda reclame exactamente 100 y deje UNO sin reclamar, que es
    // justamente el que tiene que quedar 'pendiente' para siempre después
    // de cancelar.
    const envios = Array.from({ length: TAMANO_TANDA + 1 }, (_, i) => ({
      id: `e-${i}`,
      campana_id: 'camp-1',
      correo: `c${i}@hotel.cr`,
      nombre_crm: 'Hotel de Prueba',
      estado: 'pendiente',
    }));
    const db = dbEnMemoria(
      { id: 'camp-1', asunto: 'Asunto', html: 'Hola{{nombre}}: {{unsubscribe_url}}', cancelada_at: null, cancelada_por: null },
      envios,
    );

    // Se cancela A MITAD de la llamada a Resend -- la carrera exacta que
    // pide el encargo: "puede haber una tanda en vuelo justo cuando se
    // cancela".
    const fetchImpl = vi.fn().mockImplementation(async () => {
      await cancelarCampana('camp-1', 'Ana Solano', db as any);
      return respuestaResend({ data: Array.from({ length: TAMANO_TANDA }, (_, i) => ({ id: `r-${i}` })) });
    });

    const r1 = await enviarTanda('camp-1', { ...depsEnvio, fetchImpl }, db as any);

    // Lo ya reclamado se manda entero -- cancelar a mitad de vuelo no lo
    // aborta ni lo deja a medias.
    expect(r1).toMatchObject({ ok: true, procesados: TAMANO_TANDA, enviados: TAMANO_TANDA, terminada: false });
    expect(db._envios.filter((e) => e.estado === 'enviado')).toHaveLength(TAMANO_TANDA);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // La tanda SIGUIENTE -- la que reclamaría el único que quedó -- ya ve
    // la campaña cancelada: no reclama nada, no llama a Resend de nuevo, y
    // el que quedó se queda 'pendiente' para siempre (no se pierde, no se
    // manda, no se reescribe).
    const r2 = await enviarTanda('camp-1', { ...depsEnvio, fetchImpl }, db as any);

    expect(r2).toEqual({ ok: true, procesados: 0, enviados: 0, fallidos: 0, terminada: true, cancelada: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // sigue en 1: la segunda llamada nunca llegó a Resend
    const sobrante = db._envios.find((e) => e.id === `e-${TAMANO_TANDA}`);
    expect(sobrante?.estado).toBe('pendiente');
  });
});
