import { describe, it, expect, vi, beforeEach } from 'vitest';

const hidratar = vi.fn();
vi.mock('@/lib/agente/conversacion', async (original) => ({
  ...(await original<typeof import('@/lib/agente/conversacion')>()),
  hidratar: (...a: unknown[]) => hidratar(...a),
}));

const generar = vi.fn();
vi.mock('@/lib/agente/cerebro', () => ({ generar: (...a: unknown[]) => generar(...a) }));

const prepararMedios = vi.fn();
vi.mock('@/lib/agente/medios', () => ({ prepararMedios: (...a: unknown[]) => prepararMedios(...a) }));

const enviarMensaje = vi.fn();
const actualizarContacto = vi.fn();
const agregarNota = vi.fn();
const dispararWorkflow = vi.fn();
vi.mock('@/lib/agente/acciones', async (original) => ({
  ...(await original<typeof import('@/lib/agente/acciones')>()),
  enviarMensaje: (...a: unknown[]) => enviarMensaje(...a),
  actualizarContacto: (...a: unknown[]) => actualizarContacto(...a),
  agregarNota: (...a: unknown[]) => agregarNota(...a),
  dispararWorkflow: (...a: unknown[]) => dispararWorkflow(...a),
}));

const leerOCrear = vi.fn();
const tomarMensaje = vi.fn();
const guardar = vi.fn();
vi.mock('@/lib/agente/estado', async (original) => ({
  ...(await original<typeof import('@/lib/agente/estado')>()),
  leerOCrear: (...a: unknown[]) => leerOCrear(...a),
  tomarMensaje: (...a: unknown[]) => tomarMensaje(...a),
  guardar: (...a: unknown[]) => guardar(...a),
}));

const { procesar } = await import('@/lib/agente/procesar');
const { DATOS_VACIOS } = await import('@/lib/agente/estado');

const deps = {
  db: {} as never, ghlApiKey: 'k', locationId: 'l',
  anthropicKey: 'a', openaiKey: 'o',
};

const FILA_NUEVA = {
  contact_id: 'c1', conversation_id: null, canal: null, estado: 'activo',
  turnos: 0, datos: DATOS_VACIOS, ultimo_mensaje_id: null, procesando_hasta: null,
  enviados: [] as string[], notificado_at: null,
};

const entrante = (over = {}) => ({
  id: 'in-1', tipo: 'TYPE_WHATSAPP', direccion: 'inbound',
  texto: 'Hola', adjuntos: [], ...over,
});

function conversacionCon(mensajes: unknown[]) {
  return { ok: true, conversacion: { conversationId: 'conv-1', mensajes } };
}

beforeEach(() => {
  vi.clearAllMocks();
  leerOCrear.mockResolvedValue({ ...FILA_NUEVA });
  tomarMensaje.mockResolvedValue(true);
  guardar.mockResolvedValue(undefined);
  prepararMedios.mockResolvedValue({ bloques: [], transcripciones: [], fallos: 0 });
  generar.mockResolvedValue({ ok: true, salida: { respuesta: 'Hola, ¿tu nombre?', datos: DATOS_VACIOS } });
  enviarMensaje.mockResolvedValue({ ok: true, messageId: 'out-1' });
  actualizarContacto.mockResolvedValue(undefined);
  agregarNota.mockResolvedValue(undefined);
  dispararWorkflow.mockResolvedValue(undefined);
  hidratar.mockResolvedValue(conversacionCon([entrante()]));
});

describe('camino feliz', () => {
  it('responde por el canal del último entrante', async () => {
    const r = await procesar('c1', deps);
    expect(r.desenlace).toBe('respondido');
    expect(enviarMensaje).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: 'c1', canal: 'WhatsApp' }),
      expect.anything(),
    );
  });

  it('acumula el id enviado, que es lo que alimenta la guarda del humano', async () => {
    await procesar('c1', deps);
    expect(guardar).toHaveBeenCalledWith('c1', expect.objectContaining({ enviados: ['out-1'] }), expect.anything());
  });

  it('incrementa el contador de turnos', async () => {
    await procesar('c1', deps);
    expect(guardar).toHaveBeenCalledWith('c1', expect.objectContaining({ turnos: 1 }), expect.anything());
  });
});

describe('guarda 1 — anti-bucle', () => {
  // Nuestra propia respuesta vuelve a disparar el workflow de GHL. Sin esto,
  // el agente se contesta a sí mismo indefinidamente, cobrando cada vuelta.
  it('no responde cuando el último mensaje real es saliente propio', async () => {
    leerOCrear.mockResolvedValue({ ...FILA_NUEVA, enviados: ['out-1'] });
    hidratar.mockResolvedValue(conversacionCon([entrante(), entrante({ id: 'out-1', direccion: 'outbound' })]));
    const r = await procesar('c1', deps);
    expect(r.desenlace).toBe('sin-entrante');
    expect(enviarMensaje).not.toHaveBeenCalled();
  });

  // El caso original del proyecto: la conversación sólo trae actividades del
  // CRM, así que tras filtrar no queda nada que responder.
  it('no responde cuando no queda ningún mensaje real', async () => {
    hidratar.mockResolvedValue(conversacionCon([]));
    const r = await procesar('c1', deps);
    expect(r.desenlace).toBe('sin-entrante');
    expect(generar).not.toHaveBeenCalled();
  });
});

describe('guarda 2 — humano presente', () => {
  it('calla para siempre en cuanto detecta un saliente ajeno', async () => {
    hidratar.mockResolvedValue(conversacionCon([entrante(), entrante({ id: 'del-asesor', direccion: 'outbound' })]));
    const r = await procesar('c1', deps);
    expect(r.desenlace).toBe('humano-presente');
    expect(guardar).toHaveBeenCalledWith('c1', expect.objectContaining({ estado: 'humano' }), expect.anything());
    expect(enviarMensaje).not.toHaveBeenCalled();
  });

  it('ni siquiera hidrata cuando el contacto ya estaba marcado como humano', async () => {
    leerOCrear.mockResolvedValue({ ...FILA_NUEVA, estado: 'humano' });
    const r = await procesar('c1', deps);
    expect(r.desenlace).toBe('inactivo');
    expect(hidratar).not.toHaveBeenCalled();
  });
});

describe('guarda 3 — anti-duplicado', () => {
  it('abandona sin responder cuando otro proceso ya tomó el mensaje', async () => {
    tomarMensaje.mockResolvedValue(false);
    const r = await procesar('c1', deps);
    expect(r.desenlace).toBe('duplicado');
    expect(enviarMensaje).not.toHaveBeenCalled();
  });

  // El candado va ANTES del trabajo caro: si se tomara después, dos webhooks
  // simultáneos pagarían dos llamadas a Claude para descartar una.
  it('toma el candado antes de llamar a Claude', async () => {
    const orden: string[] = [];
    tomarMensaje.mockImplementation(async () => { orden.push('candado'); return true; });
    generar.mockImplementation(async () => { orden.push('claude'); return { ok: true, salida: { respuesta: 'x', datos: DATOS_VACIOS } }; });
    await procesar('c1', deps);
    expect(orden).toEqual(['candado', 'claude']);
  });
});

describe('tope de turnos', () => {
  it('en el cuarto turno responde y deja el contacto agotado', async () => {
    leerOCrear.mockResolvedValue({ ...FILA_NUEVA, turnos: 3 });
    const r = await procesar('c1', deps);
    expect(r.desenlace).toBe('respondido');
    expect(guardar).toHaveBeenCalledWith('c1', expect.objectContaining({ estado: 'agotado', turnos: 4 }), expect.anything());
  });

  it('no responde un quinto mensaje', async () => {
    leerOCrear.mockResolvedValue({ ...FILA_NUEVA, estado: 'agotado', turnos: 4 });
    const r = await procesar('c1', deps);
    expect(r.desenlace).toBe('inactivo');
    expect(enviarMensaje).not.toHaveBeenCalled();
  });
});

describe('correo', () => {
  it('responde una vez y marca el contacto como ya respondido', async () => {
    hidratar.mockResolvedValue(conversacionCon([entrante({ tipo: 'TYPE_EMAIL' })]));
    const r = await procesar('c1', deps);
    expect(r.desenlace).toBe('respondido');
    expect(enviarMensaje).toHaveBeenCalledWith(expect.objectContaining({ canal: 'Email' }), expect.anything());
    expect(guardar).toHaveBeenCalledWith('c1', expect.objectContaining({ estado: 'email_respondido' }), expect.anything());
  });

  it('no responde un segundo correo', async () => {
    leerOCrear.mockResolvedValue({ ...FILA_NUEVA, estado: 'email_respondido' });
    const r = await procesar('c1', deps);
    expect(r.desenlace).toBe('inactivo');
  });
});

describe('aviso al equipo', () => {
  it('dispara el workflow cuando hay nombre y un medio de contacto', async () => {
    generar.mockResolvedValue({
      ok: true,
      salida: { respuesta: 'Gracias', datos: { ...DATOS_VACIOS, nombre: 'Ana Pérez', email: 'ana@x.com' } },
    });
    await procesar('c1', deps);
    expect(dispararWorkflow).toHaveBeenCalledWith('c1', expect.anything());
  });

  it('no dispara con nombre pero sin correo ni teléfono', async () => {
    generar.mockResolvedValue({
      ok: true, salida: { respuesta: 'Gracias', datos: { ...DATOS_VACIOS, nombre: 'Ana' } },
    });
    await procesar('c1', deps);
    expect(dispararWorkflow).not.toHaveBeenCalled();
  });

  // Para que el equipo se entere aunque el cliente nunca suelte sus datos.
  it('dispara igual al agotar los turnos, sin datos', async () => {
    leerOCrear.mockResolvedValue({ ...FILA_NUEVA, turnos: 3 });
    await procesar('c1', deps);
    expect(dispararWorkflow).toHaveBeenCalled();
  });

  it('no dispara dos veces para el mismo contacto', async () => {
    leerOCrear.mockResolvedValue({ ...FILA_NUEVA, turnos: 3, notificado_at: '2026-08-24T10:00:00Z' });
    await procesar('c1', deps);
    expect(dispararWorkflow).not.toHaveBeenCalled();
  });
});

describe('durabilidad', () => {
  // Estampar y luego disparar perdería el aviso para siempre ante un 500
  // pasajero: debeAvisar no volvería a autorizarlo nunca.
  it('no da el aviso por hecho si el workflow falló', async () => {
    leerOCrear.mockResolvedValue({ ...FILA_NUEVA, turnos: 3 });
    dispararWorkflow.mockResolvedValue('GHL workflow 500: boom');
    await procesar('c1', deps);
    const cambios = guardar.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect('notificado_at' in cambios).toBe(false);
  });

  it('estampa el aviso cuando el workflow sí salió', async () => {
    leerOCrear.mockResolvedValue({ ...FILA_NUEVA, turnos: 3 });
    await procesar('c1', deps);
    const cambios = guardar.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(typeof cambios.notificado_at).toBe('string');
  });

  it('libera el arriendo del contacto al terminar el turno', async () => {
    await procesar('c1', deps);
    expect(guardar).toHaveBeenCalledWith(
      'c1', expect.objectContaining({ procesando_hasta: null }), expect.anything(),
    );
  });

  // El arriendo se toma antes del trabajo caro; si el trabajo falla y no se
  // suelta, el reintento inmediato del cliente se descarta durante 90 s.
  it('libera el arriendo si Claude falla', async () => {
    generar.mockResolvedValue({ ok: false, error: 'refusal' });
    await procesar('c1', deps);
    expect(guardar).toHaveBeenCalledWith('c1', { procesando_hasta: null }, expect.anything());
  });

  it('libera el arriendo si el envío falla', async () => {
    enviarMensaje.mockResolvedValue({ ok: false, error: 'GHL envío 403' });
    await procesar('c1', deps);
    expect(guardar).toHaveBeenCalledWith('c1', { procesando_hasta: null }, expect.anything());
  });

  // Si el aviso saliera antes, el asesor abriría la notificación y encontraría
  // el contacto todavía en blanco.
  it('avisa al equipo sólo después de escribir el contacto y la nota', async () => {
    leerOCrear.mockResolvedValue({ ...FILA_NUEVA, turnos: 3 });
    const orden: string[] = [];
    actualizarContacto.mockImplementation(async () => { orden.push('contacto'); return undefined; });
    agregarNota.mockImplementation(async () => { orden.push('nota'); return undefined; });
    dispararWorkflow.mockImplementation(async () => { orden.push('aviso'); return undefined; });
    await procesar('c1', deps);
    expect(orden).toEqual(['contacto', 'nota', 'aviso']);
  });

  it('estampa el aviso en una escritura aparte, no junto al resto del estado', async () => {
    leerOCrear.mockResolvedValue({ ...FILA_NUEVA, turnos: 3 });
    await procesar('c1', deps);
    const ultima = guardar.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(Object.keys(ultima)).toEqual(['notificado_at']);
  });

  // Si el latch no se persiste, la guarda del humano deja de ser permanente.
  it('grita en el log si no pudo persistir el latch de humano', async () => {
    const espia = vi.spyOn(console, 'error').mockImplementation(() => {});
    hidratar.mockResolvedValue(conversacionCon([entrante(), entrante({ id: 'del-asesor', direccion: 'outbound' })]));
    guardar.mockResolvedValue('timeout');
    const r = await procesar('c1', deps);
    expect(r.desenlace).toBe('humano-presente');
    expect(espia).toHaveBeenCalled();
    espia.mockRestore();
  });
});

describe('fallos', () => {
  it('no responde si la hidratación falla', async () => {
    hidratar.mockResolvedValue({ ok: false, error: 'GHL search 500' });
    const r = await procesar('c1', deps);
    expect(r.desenlace).toBe('error');
    expect(enviarMensaje).not.toHaveBeenCalled();
  });

  it('no responde si Claude falla', async () => {
    generar.mockResolvedValue({ ok: false, error: 'refusal' });
    const r = await procesar('c1', deps);
    expect(r.desenlace).toBe('error');
    expect(enviarMensaje).not.toHaveBeenCalled();
  });

  // Si el envío falla, el turno no se consume: el siguiente mensaje del
  // cliente vuelve a intentarlo.
  it('no consume turno si el envío falla', async () => {
    enviarMensaje.mockResolvedValue({ ok: false, error: 'GHL envío 403' });
    const r = await procesar('c1', deps);
    expect(r.desenlace).toBe('error');
    expect(guardar).not.toHaveBeenCalledWith('c1', expect.objectContaining({ turnos: 1 }), expect.anything());
  });

  it('un canal que la allowlist no acepta ni llega a la orquestación', async () => {
    hidratar.mockResolvedValue(conversacionCon([entrante({ tipo: 'TYPE_SMS' })]));
    const r = await procesar('c1', deps);
    expect(r.desenlace).toBe('sin-entrante');
    expect(enviarMensaje).not.toHaveBeenCalled();
  });
});
