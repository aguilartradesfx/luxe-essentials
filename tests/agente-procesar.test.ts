import { describe, it, expect, vi, beforeEach } from 'vitest';
import { config } from '@/lib/agente/config';

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
const leerContacto = vi.fn();
vi.mock('@/lib/agente/acciones', async (original) => ({
  ...(await original<typeof import('@/lib/agente/acciones')>()),
  enviarMensaje: (...a: unknown[]) => enviarMensaje(...a),
  actualizarContacto: (...a: unknown[]) => actualizarContacto(...a),
  agregarNota: (...a: unknown[]) => agregarNota(...a),
  dispararWorkflow: (...a: unknown[]) => dispararWorkflow(...a),
  leerContacto: (...a: unknown[]) => leerContacto(...a),
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

// `registrarIntencion` no está mockeado (no es parte de lib/agente/estado ni
// lib/agente/acciones), así que llama de verdad a esta cadena cuando el turno
// trae correo, producto y cantidad. Sin borradores previos por defecto, y con
// `insert` registrado para poder comprobar que el borrador se creó.
const borradorFalso: { insertados: unknown[] } = { insertados: [] };
const dbFalso = {
  from: () => ({
    select: () => ({
      eq: () => ({ eq: () => ({ limit: async () => ({ data: [], error: null }) }) }),
    }),
    insert: async (fila: unknown) => {
      borradorFalso.insertados.push(fila);
      return { error: null };
    },
  }),
};

const deps = {
  db: dbFalso as never, ghlApiKey: 'k', locationId: 'l',
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
  borradorFalso.insertados = [];
  leerOCrear.mockResolvedValue({ ...FILA_NUEVA });
  tomarMensaje.mockResolvedValue(true);
  guardar.mockResolvedValue(undefined);
  prepararMedios.mockResolvedValue({ bloques: [], transcripciones: [], fallos: 0 });
  generar.mockResolvedValue({ ok: true, salida: { respuesta: 'Hola, ¿tu nombre?', datos: DATOS_VACIOS } });
  enviarMensaje.mockResolvedValue({ ok: true, messageId: 'out-1' });
  actualizarContacto.mockResolvedValue(undefined);
  agregarNota.mockResolvedValue(undefined);
  dispararWorkflow.mockResolvedValue(undefined);
  leerContacto.mockResolvedValue({ ok: true, etiquetas: [], nombre: null, email: null, telefono: null });
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

describe('ficha del CRM', () => {
  // `leerContacto` ya pedía el contacto entero para sacar las etiquetas; el
  // nombre, el correo y el teléfono de esa misma respuesta tienen que llegar
  // al cerebro para que confirme en vez de volver a preguntar (ver el prompt
  // del sistema en config.ts).
  it('pasa al cerebro el nombre, correo y teléfono que ya traía la ficha', async () => {
    leerContacto.mockResolvedValue({
      ok: true, etiquetas: [], nombre: 'Alejandro Aguilar', email: null, telefono: '8888-8888',
    });
    await procesar('c1', deps);
    expect(generar).toHaveBeenCalledWith(
      expect.objectContaining({
        fichaCRM: { nombre: 'Alejandro Aguilar', email: null, telefono: '8888-8888' },
      }),
      expect.anything(),
    );
  });

  it('manda la ficha vacía cuando el CRM no traía nada', async () => {
    await procesar('c1', deps);
    expect(generar).toHaveBeenCalledWith(
      expect.objectContaining({ fichaCRM: { nombre: null, email: null, telefono: null } }),
      expect.anything(),
    );
  });
});

describe('guarda 0 — etiqueta Stop_bot', () => {
  it('no responde cuando el contacto tiene la etiqueta', async () => {
    leerContacto.mockResolvedValue({ ok: true, etiquetas: ['Stop_bot'] });
    const r = await procesar('c1', deps);
    expect(r.desenlace).toBe('stop-bot');
    expect(enviarMensaje).not.toHaveBeenCalled();
  });

  // Se comprueba antes de hidratar: pedirle a Claude qué contestar para
  // después tirar la respuesta sería pagar por nada.
  it('ni siquiera hidrata la conversación cuando la etiqueta está puesta', async () => {
    leerContacto.mockResolvedValue({ ok: true, etiquetas: ['Stop_bot'] });
    await procesar('c1', deps);
    expect(hidratar).not.toHaveBeenCalled();
    expect(generar).not.toHaveBeenCalled();
  });

  it('la comparación es insensible a mayúsculas: la detecta en minúsculas', async () => {
    leerContacto.mockResolvedValue({ ok: true, etiquetas: ['stop_bot'] });
    const r = await procesar('c1', deps);
    expect(r.desenlace).toBe('stop-bot');
  });

  it('la comparación es insensible a mayúsculas: la detecta toda en mayúsculas', async () => {
    leerContacto.mockResolvedValue({ ok: true, etiquetas: ['STOP_BOT'] });
    const r = await procesar('c1', deps);
    expect(r.desenlace).toBe('stop-bot');
  });

  // Mismo contacto que el camino feliz por defecto (mismos mocks, mismo fila
  // nueva), sólo cambia la lista de etiquetas: si esta prueba deja de caer al
  // quitar la comparación de `tieneEtiquetaStopBot`, es porque algo más la
  // haría fallar y estaría protegiendo lo que no es.
  it('sí responde cuando el contacto no tiene la etiqueta', async () => {
    leerContacto.mockResolvedValue({ ok: true, etiquetas: ['otra-cosa'] });
    const r = await procesar('c1', deps);
    expect(r.desenlace).toBe('respondido');
    expect(enviarMensaje).toHaveBeenCalled();
  });

  it('no se confunde con una etiqueta parecida pero distinta', async () => {
    leerContacto.mockResolvedValue({ ok: true, etiquetas: ['stop_bot_temporal'] });
    const r = await procesar('c1', deps);
    expect(r.desenlace).toBe('respondido');
  });

  // Decisión explícita: si la lectura de GHL falla, el agente se calla
  // (fail-closed) en vez de arriesgarse a hablarle encima a un asesor. Ver el
  // comentario en procesar.ts para el porqué.
  it('se calla por seguridad si no pudo leer las etiquetas del contacto', async () => {
    leerContacto.mockResolvedValue({ ok: false, error: 'GHL lectura de contacto 500: boom' });
    const r = await procesar('c1', deps);
    expect(r.desenlace).toBe('stop-bot');
    expect(hidratar).not.toHaveBeenCalled();
    expect(enviarMensaje).not.toHaveBeenCalled();
  });

  it('registra en el log, con el id del contacto, cuando se calla por la etiqueta', async () => {
    const espia = vi.spyOn(console, 'error').mockImplementation(() => {});
    leerContacto.mockResolvedValue({ ok: true, etiquetas: ['Stop_bot'] });
    await procesar('c1', deps);
    expect(espia).toHaveBeenCalledWith(expect.anything(), 'contacto:', 'c1');
    espia.mockRestore();
  });

  it('no gasta la llamada a GHL cuando el contacto ya estaba inactivo', async () => {
    leerOCrear.mockResolvedValue({ ...FILA_NUEVA, estado: 'humano' });
    await procesar('c1', deps);
    expect(leerContacto).not.toHaveBeenCalled();
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
  it('en el último turno permitido responde y deja el contacto agotado', async () => {
    leerOCrear.mockResolvedValue({ ...FILA_NUEVA, turnos: config.TOPE_TURNOS - 1 });
    const r = await procesar('c1', deps);
    expect(r.desenlace).toBe('respondido');
    expect(guardar).toHaveBeenCalledWith(
      'c1', expect.objectContaining({ estado: 'agotado', turnos: config.TOPE_TURNOS }), expect.anything(),
    );
  });

  it('no responde un mensaje más allá del tope', async () => {
    leerOCrear.mockResolvedValue({ ...FILA_NUEVA, estado: 'agotado', turnos: config.TOPE_TURNOS });
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

describe('aviso al equipo (workflow config.WORKFLOW_AVISO_INTERNO, tres casos)', () => {
  it('no dispara si no se cumple ninguno de los tres casos', async () => {
    // Camino feliz por defecto: WhatsApp, sin datos captados todavía, lejos
    // del tope de turnos. Control de que el aviso no es el comportamiento
    // por defecto — si `debeAvisar` estuviera rota a `true` siempre, este es
    // el que lo atraparía.
    await procesar('c1', deps);
    expect(dispararWorkflow).not.toHaveBeenCalled();
  });

  it('caso 1: dispara cuando el turno es una respuesta por correo', async () => {
    hidratar.mockResolvedValue(conversacionCon([entrante({ tipo: 'TYPE_EMAIL' })]));
    await procesar('c1', deps);
    expect(dispararWorkflow).toHaveBeenCalledWith('c1', config.WORKFLOW_AVISO_INTERNO, expect.anything());
  });

  it('caso 2: dispara por WhatsApp cuando el turno capta nombre y correo', async () => {
    generar.mockResolvedValue({
      ok: true,
      salida: { respuesta: 'Gracias', datos: { ...DATOS_VACIOS, nombre: 'Alejandro Aguilar', email: 'ale@x.com' } },
    });
    await procesar('c1', deps);
    expect(dispararWorkflow).toHaveBeenCalledWith('c1', config.WORKFLOW_AVISO_INTERNO, expect.anything());
  });

  it('caso 2: dispara por WhatsApp cuando el turno capta nombre y teléfono, sin correo', async () => {
    generar.mockResolvedValue({
      ok: true,
      salida: { respuesta: 'Gracias', datos: { ...DATOS_VACIOS, nombre: 'Alejandro Aguilar', telefono: '8888-8888' } },
    });
    await procesar('c1', deps);
    expect(dispararWorkflow).toHaveBeenCalledWith('c1', config.WORKFLOW_AVISO_INTERNO, expect.anything());
  });

  it('no dispara sólo con el nombre, sin correo ni teléfono', async () => {
    generar.mockResolvedValue({
      ok: true,
      salida: { respuesta: '¿Me confirmás tu correo o teléfono?', datos: { ...DATOS_VACIOS, nombre: 'Alejandro Aguilar' } },
    });
    await procesar('c1', deps);
    expect(dispararWorkflow).not.toHaveBeenCalled();
  });

  // El caso real que costó el lead: WhatsApp, nombre y producto captados,
  // pero sin correo ni teléfono — el contacto se agota de turnos sin haber
  // cumplido el caso 2, y antes de este arreglo no avisaba a nadie.
  it('caso 3: dispara al agotar los turnos aunque no haya lead cualificado', async () => {
    leerOCrear.mockResolvedValue({ ...FILA_NUEVA, turnos: config.TOPE_TURNOS - 1 });
    generar.mockResolvedValue({
      ok: true,
      salida: { respuesta: 'Gracias por escribirnos', datos: { ...DATOS_VACIOS, nombre: 'Alejandro Aguilar', producto: 'uniformes' } },
    });
    await procesar('c1', deps);
    expect(dispararWorkflow).toHaveBeenCalledWith('c1', config.WORKFLOW_AVISO_INTERNO, expect.anything());
  });

  it('no dispara dos veces para el mismo contacto', async () => {
    leerOCrear.mockResolvedValue({ ...FILA_NUEVA, notificado_at: '2026-08-24T10:00:00Z' });
    hidratar.mockResolvedValue(conversacionCon([entrante({ tipo: 'TYPE_EMAIL' })]));
    await procesar('c1', deps);
    expect(dispararWorkflow).not.toHaveBeenCalled();
  });
});

// `registrarIntencion` no está mockeada en este archivo: estas pruebas
// ejercitan la conexión real entre `procesar()` y `lib/cotizador/borrador.ts`,
// no sólo la lógica interna de `registrarIntencion` (ya cubierta en
// tests/cotizador-borrador.test.ts). Sin ellas, borrar por completo la llamada
// en procesar.ts deja la suite en verde.
describe('borrador del cotizador', () => {
  it('registra la intención cuando el turno trae correo, producto y cantidad', async () => {
    generar.mockResolvedValue({
      ok: true,
      salida: {
        respuesta: 'Con gusto, te preparamos la cotización',
        datos: {
          ...DATOS_VACIOS, nombre: 'Ana Pérez', email: 'ana@hotel.com',
          producto: 'uniformes', cantidad: '300 piezas',
        },
      },
    });
    await procesar('c1', deps);
    expect(borradorFalso.insertados).toHaveLength(1);
    const fila = borradorFalso.insertados[0] as Record<string, unknown>;
    expect(fila.origen).toBe('agente');
    expect(fila.estado).toBe('borrador');
    expect(fila.contact_id).toBe('c1');
  });

  it('no registra nada si falta la cantidad', async () => {
    generar.mockResolvedValue({
      ok: true,
      salida: {
        respuesta: 'Gracias',
        datos: { ...DATOS_VACIOS, nombre: 'Ana Pérez', email: 'ana@hotel.com', producto: 'uniformes' },
      },
    });
    await procesar('c1', deps);
    expect(borradorFalso.insertados).toHaveLength(0);
  });
});

describe('durabilidad', () => {
  // Estampar y luego disparar perdería el aviso para siempre ante un 500
  // pasajero: debeAvisar no volvería a autorizarlo nunca.
  it('no da el aviso por hecho si el workflow falló', async () => {
    hidratar.mockResolvedValue(conversacionCon([entrante({ tipo: 'TYPE_EMAIL' })]));
    dispararWorkflow.mockResolvedValue('GHL workflow 500: boom');
    await procesar('c1', deps);
    const cambios = guardar.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect('notificado_at' in cambios).toBe(false);
  });

  it('estampa el aviso cuando el workflow sí salió', async () => {
    hidratar.mockResolvedValue(conversacionCon([entrante({ tipo: 'TYPE_EMAIL' })]));
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
    hidratar.mockResolvedValue(conversacionCon([entrante({ tipo: 'TYPE_EMAIL' })]));
    const orden: string[] = [];
    actualizarContacto.mockImplementation(async () => { orden.push('contacto'); return undefined; });
    agregarNota.mockImplementation(async () => { orden.push('nota'); return undefined; });
    dispararWorkflow.mockImplementation(async () => { orden.push('aviso'); return undefined; });
    await procesar('c1', deps);
    expect(orden).toEqual(['contacto', 'nota', 'aviso']);
  });

  it('estampa el aviso en una escritura aparte, no junto al resto del estado', async () => {
    hidratar.mockResolvedValue(conversacionCon([entrante({ tipo: 'TYPE_EMAIL' })]));
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

  // El mock fabrica a propósito algo que el pipeline real no produce: la
  // allowlist de `aMensajeReal` filtra los tipos no soportados antes de llegar
  // aquí. Lo que se comprueba es la defensa: si alguna vez se colara uno, el
  // turno se detiene en vez de intentar enviar por un canal desconocido.
  it('se detiene si un tipo sin canal de envío se colara hasta la orquestación', async () => {
    hidratar.mockResolvedValue(conversacionCon([entrante({ tipo: 'TYPE_SMS' })]));
    const r = await procesar('c1', deps);
    expect(r.desenlace).toBe('canal-no-soportado');
    expect(enviarMensaje).not.toHaveBeenCalled();
  });
});
