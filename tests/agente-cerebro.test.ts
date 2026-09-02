import { describe, it, expect, vi } from 'vitest';
import { generar } from '@/lib/agente/cerebro';
import { DATOS_VACIOS } from '@/lib/agente/estado';

const deps = { anthropicKey: 'sk-ant-prueba' };

const entrada = {
  mensajes: [
    { id: 'm1', tipo: 'TYPE_WHATSAPP' as const, direccion: 'inbound' as const,
      texto: 'Hola, necesito uniformes', adjuntos: [] },
  ],
  mios: [] as string[],
  transcripciones: [],
  bloques: [],
  datosPrevios: DATOS_VACIOS,
  fichaCRM: { nombre: null, email: null, telefono: null },
  huboFallosDeMedios: false,
  esCorreo: false,
};

function claude(payload: unknown, stopReason = 'end_turn') {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        stop_reason: stopReason,
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      }),
  });
}

describe('generar', () => {
  it('devuelve la respuesta y los datos extraídos', async () => {
    const fetchImpl = claude({
      respuesta: 'Con gusto. ¿Me compartes tu nombre?',
      esAutomatico: false,
      datos: { ...DATOS_VACIOS, producto: 'uniformes' },
    });
    const r = await generar(entrada, { ...deps, fetchImpl });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.salida.respuesta).toContain('nombre');
    expect(r.salida.datos.producto).toBe('uniformes');
    expect(r.salida.esAutomatico).toBe(false);
  });

  it('usa Opus 5 con effort low y max_tokens acotado', async () => {
    const fetchImpl = claude({ respuesta: 'ok', datos: DATOS_VACIOS });
    await generar(entrada, { ...deps, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.model).toBe('claude-opus-5');
    expect(body.max_tokens).toBe(4096);
    expect(body.output_config.effort).toBe('low');
  });

  // Apagar el thinking en Opus 5 hace que la salida estructurada salga a veces
  // como texto plano: el turno "funciona", el JSON nunca llega y no hay error.
  // El parámetro simplemente no debe ir.
  it('no manda el parámetro thinking', async () => {
    const fetchImpl = claude({ respuesta: 'ok', datos: DATOS_VACIOS });
    await generar(entrada, { ...deps, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.thinking).toBeUndefined();
  });

  it('cachea el bloque de sistema', async () => {
    const fetchImpl = claude({ respuesta: 'ok', datos: DATOS_VACIOS });
    await generar(entrada, { ...deps, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('manda las cabeceras que exige la API de Anthropic', async () => {
    const fetchImpl = claude({ respuesta: 'ok', datos: DATOS_VACIOS });
    await generar(entrada, { ...deps, fetchImpl });
    const headers = fetchImpl.mock.calls[0][1].headers;
    expect(headers['x-api-key']).toBe('sk-ant-prueba');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('adjunta los bloques de imagen al último turno del cliente', async () => {
    const fetchImpl = claude({ respuesta: 'ok', datos: DATOS_VACIOS });
    await generar(
      { ...entrada, bloques: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] },
      { ...deps, fetchImpl },
    );
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    const ultimo = body.messages[body.messages.length - 1];
    expect(ultimo.content.some((b: { type: string }) => b.type === 'image')).toBe(true);
  });

  it('inyecta la transcripción del audio como texto del cliente', async () => {
    const fetchImpl = claude({ respuesta: 'ok', datos: DATOS_VACIOS });
    await generar({ ...entrada, transcripciones: ['Quiero 200 filipinas'] }, { ...deps, fetchImpl });
    expect(JSON.stringify(fetchImpl.mock.calls[0][1].body)).toContain('Quiero 200 filipinas');
  });

  it('falla limpio cuando Claude devuelve un JSON que no valida', async () => {
    const fetchImpl = claude({ respuesta: 123, datos: 'no es un objeto' });
    const r = await generar(entrada, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
  });

  // El esquema de la API y el de Zod tienen que mandar `cantidad` los dos.
  // Sin esta prueba, borrar la línea de `ESQUEMA` o de `required` deja la
  // suite entera en verde: nada más comprueba la forma exacta del cuerpo.
  it('el esquema que se manda a la API incluye cantidad como campo obligatorio', async () => {
    const fetchImpl = claude({ respuesta: 'ok', datos: DATOS_VACIOS });
    await generar(entrada, { ...deps, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    const esquemaDatos = body.output_config.format.schema.properties.datos;
    expect(esquemaDatos.properties).toHaveProperty('cantidad');
    expect(esquemaDatos.required).toContain('cantidad');
  });

  // `esAutomatico` es el campo del que depende que `procesar.ts` no le
  // conteste a la respuesta automática de otro bot. Sin obligarlo aquí (y en
  // salidaSchema, ver la prueba siguiente), la API podría omitirlo y
  // `generado.salida.esAutomatico` llegaría `undefined` —falsy, así que ese
  // turno SÍ se respondería— sin que ninguna prueba lo note.
  it('el esquema que se manda a la API incluye esAutomatico como campo obligatorio', async () => {
    const fetchImpl = claude({ respuesta: 'ok', esAutomatico: false, datos: DATOS_VACIOS });
    await generar(entrada, { ...deps, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    const esquema = body.output_config.format.schema;
    expect(esquema.properties).toHaveProperty('esAutomatico');
    expect(esquema.properties.esAutomatico).toEqual({ type: 'boolean' });
    expect(esquema.required).toContain('esAutomatico');
  });

  // z.object descarta en silencio las claves de sobra: sin esta línea en
  // salidaSchema, una respuesta que omite esAutomatico pasaría igual y
  // `salida.esAutomatico` llegaría `undefined` sin ningún error en el log.
  it('falla limpio cuando la salida del modelo omite esAutomatico', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify({ respuesta: 'ok', datos: DATOS_VACIOS }) }],
        }),
    });
    const r = await generar(entrada, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
  });

  // z.object descarta en silencio las claves de sobra: sin la línea de
  // `cantidad` en salidaSchema, una respuesta que la omite pasaría igual y
  // `salida.datos.cantidad` llegaría `undefined` sin ningún error en ningún
  // log. Esta prueba es la que detecta que esa línea desapareció.
  it('falla limpio cuando la salida del modelo omite cantidad', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          stop_reason: 'end_turn',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                respuesta: 'ok',
                datos: { nombre: null, email: null, telefono: null, producto: null, ubicacion: null },
              }),
            },
          ],
        }),
    });
    const r = await generar(entrada, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
  });

  it('falla limpio cuando el contenido no es JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'lo siento, no puedo' }] }),
    });
    const r = await generar(entrada, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
  });

  // Un refusal llega con HTTP 200 y content vacío. Leer content[0].text sin
  // mirar stop_reason revienta con un TypeError críptico.
  it('trata el refusal como fallo, no como respuesta', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({ stop_reason: 'refusal', content: [] }),
    });
    const r = await generar(entrada, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('refusal');
  });

  // El mensaje del SyntaxError de JSON.parse arrastra la entrada, y ahí va
  // texto derivado de lo que escribió el cliente. Ese error va al log.
  it('no filtra la salida del modelo en el mensaje de error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Ana Pérez, ana@hotelx.com, +506 8888 8888' }],
        }),
    });
    const r = await generar(entrada, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).not.toContain('ana@hotelx.com');
    expect(r.error).not.toContain('Ana Pérez');
  });

  it('rechaza una respuesta más larga de lo que cabe en un mensaje', async () => {
    const fetchImpl = claude({ respuesta: 'a'.repeat(1501), datos: DATOS_VACIOS });
    const r = await generar(entrada, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
  });

  it('falla limpio cuando la red se cae, sin lanzar', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const r = await generar(entrada, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
  });

  // La API exige que el primer turno sea del usuario.
  it('descarta los turnos assistant iniciales', async () => {
    const fetchImpl = claude({ respuesta: 'ok', datos: DATOS_VACIOS });
    await generar(
      {
        ...entrada,
        mensajes: [
          { id: 'o1', tipo: 'TYPE_WHATSAPP' as const, direccion: 'outbound' as const, texto: 'anterior', adjuntos: [] },
          { id: 'i1', tipo: 'TYPE_WHATSAPP' as const, direccion: 'inbound' as const, texto: 'hola', adjuntos: [] },
        ],
      },
      { ...deps, fetchImpl },
    );
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.messages[0].role).toBe('user');
  });

  it('inserta un turno mínimo cuando no queda ningún mensaje', async () => {
    const fetchImpl = claude({ respuesta: 'ok', datos: DATOS_VACIOS });
    await generar({ ...entrada, mensajes: [] }, { ...deps, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe('user');
  });

  it('falla limpio cuando la API responde 429', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => 'rate limited' });
    const r = await generar(entrada, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('429');
  });

  // El modelo necesita distinguir "esto lo dijo el cliente" (datosPrevios) de
  // "esto ya estaba en la ficha del CRM" (fichaCRM): son cosas distintas y el
  // prompt le pide tratarlas distinto (confirmar una, preguntar la otra).
  // Sin esta prueba, alguien podría fusionar los dos bloques en uno solo y la
  // suite seguiría en verde.
  it('manda la ficha del CRM al modelo, aparte de los datos ya capturados en la conversación', async () => {
    const fetchImpl = claude({ respuesta: 'ok', datos: DATOS_VACIOS });
    await generar(
      {
        ...entrada,
        datosPrevios: { ...DATOS_VACIOS, producto: 'uniformes' },
        fichaCRM: { nombre: 'Alejandro Aguilar', email: null, telefono: '8888-8888' },
      },
      { ...deps, fetchImpl },
    );
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    const texto = JSON.stringify(body.messages);
    expect(texto).toContain('Alejandro Aguilar');
    expect(texto).toContain('8888-8888');
    // Los dos bloques van marcados con su origen, no mezclados en un solo texto.
    expect(texto).toMatch(/ficha del contacto en el CRM/);
    expect(texto).toMatch(/datos que ya tienes de esta persona/);
  });

  it('avisa explícitamente cuando la ficha del CRM no traía nada', async () => {
    const fetchImpl = claude({ respuesta: 'ok', datos: DATOS_VACIOS });
    await generar(entrada, { ...deps, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    const texto = JSON.stringify(body.messages);
    expect(texto).toContain('la ficha del contacto en el CRM no traía nombre, correo ni teléfono');
  });
});
