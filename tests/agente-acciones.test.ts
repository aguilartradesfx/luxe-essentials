import { describe, it, expect, vi } from 'vitest';
import {
  enviarMensaje, actualizarContacto, agregarNota, dispararWorkflow, resumenParaNota, leerContacto,
  horaEventoGHL,
} from '@/lib/agente/acciones';
import { DATOS_VACIOS } from '@/lib/agente/estado';

const deps = { apiKey: 'llave' };

function ok(body: unknown) {
  return vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify(body) });
}

describe('enviarMensaje', () => {
  it('manda el type de envío, no el messageType leído', async () => {
    const fetchImpl = ok({ messageId: 'msg-1' });
    await enviarMensaje({ contactId: 'c1', canal: 'WhatsApp', texto: 'Hola' }, { ...deps, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.type).toBe('WhatsApp');
    expect(body.contactId).toBe('c1');
    expect(body.message).toBe('Hola');
  });

  it('añade asunto cuando el canal es correo', async () => {
    const fetchImpl = ok({ messageId: 'msg-1' });
    await enviarMensaje({ contactId: 'c1', canal: 'Email', texto: 'Hola' }, { ...deps, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(typeof body.subject).toBe('string');
    expect(body.subject.length).toBeGreaterThan(0);
  });

  it('usa la versión de conversaciones', async () => {
    const fetchImpl = ok({ messageId: 'm' });
    await enviarMensaje({ contactId: 'c1', canal: 'IG', texto: 'x' }, { ...deps, fetchImpl });
    expect(fetchImpl.mock.calls[0][1].headers.Version).toBe('2021-04-15');
  });

  it('devuelve el id del mensaje creado, que alimenta la guarda del humano', async () => {
    const fetchImpl = ok({ messageId: 'msg-42' });
    const r = await enviarMensaje({ contactId: 'c1', canal: 'FB', texto: 'x' }, { ...deps, fetchImpl });
    expect(r).toEqual({ ok: true, messageId: 'msg-42' });
  });

  // Si GHL no devuelve id, el mensaje SÍ salió. Marcarlo como fallo lo haría
  // reenviarse y el cliente lo recibiría dos veces.
  it('cuenta como enviado aunque no venga el id', async () => {
    const fetchImpl = ok({});
    const r = await enviarMensaje({ contactId: 'c1', canal: 'FB', texto: 'x' }, { ...deps, fetchImpl });
    expect(r).toEqual({ ok: true, messageId: null });
  });

  it('falla limpio con un 403 de scope faltante', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => 'forbidden' });
    const r = await enviarMensaje({ contactId: 'c1', canal: 'WhatsApp', texto: 'x' }, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('403');
  });
});

describe('actualizarContacto', () => {
  // Primero LEE el contacto y luego escribe: sin la lectura, el PUT pisaría el
  // correo o el teléfono que el asesor ya hubiera cargado a mano.
  function contactoYPut(actual: Record<string, unknown>) {
    return vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ contact: actual }) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '{}' });
  }

  // `city` es la subzona de ruta en la base importada, no la ciudad del cliente.
  it('nunca escribe city, ni siquiera si está vacío', async () => {
    const fetchImpl = contactoYPut({});
    await actualizarContacto('c1', { ...DATOS_VACIOS, nombre: 'Ana', ubicacion: 'Tamarindo' }, { ...deps, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect('city' in body).toBe(false);
  });

  // En la base importada firstName es el nombre comercial del negocio, así que
  // el nombre de la persona necesita su propio campo o se pierde.
  it('guarda el nombre de la persona en persona_contacto', async () => {
    const fetchImpl = contactoYPut({ firstName: 'Hotel Papagayo' });
    await actualizarContacto('c1', { ...DATOS_VACIOS, nombre: 'Ana Pérez' }, { ...deps, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[1][1].body);
    // La clave lleva el prefijo `contact.`: así es como esta location de GHL
    // reporta sus campos personalizados (ver comentario en config.ts). Sin el
    // prefijo la escritura se perdería en silencio.
    expect(body.customFields).toEqual([{ key: 'contact.persona_contacto', field_value: 'Ana Pérez' }]);
    expect('firstName' in body).toBe(false);
  });

  it('usa la versión de contactos y sólo manda lo que tiene valor', async () => {
    const fetchImpl = contactoYPut({});
    await actualizarContacto('c1', { ...DATOS_VACIOS, nombre: 'Ana Pérez', email: 'ana@x.com' }, { ...deps, fetchImpl });
    const [, init] = fetchImpl.mock.calls[1];
    expect(init.method).toBe('PUT');
    expect(init.headers.Version).toBe('2021-07-28');
    const body = JSON.parse(init.body);
    expect(body.firstName).toBe('Ana');
    expect(body.lastName).toBe('Pérez');
    expect(body.email).toBe('ana@x.com');
    expect('phone' in body).toBe(false);
  });

  // Prueba 15 del spec. El asesor pudo haber corregido el correo a mano; el
  // agente no tiene derecho a sobrescribirlo con lo que dedujo de un chat.
  it('no pisa un dato que el contacto ya tenía en GHL', async () => {
    const fetchImpl = contactoYPut({ email: 'el-bueno@empresa.com' });
    await actualizarContacto(
      'c1', { ...DATOS_VACIOS, email: 'deducido@chat.com', telefono: '+502 5555' }, { ...deps, fetchImpl },
    );
    const body = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect('email' in body).toBe(false);
    expect(body.phone).toBe('+502 5555');
  });

  // Si no sabemos qué hay, no escribimos: los datos igual quedan en la nota,
  // así que no se pierde nada y no se arriesga pisar a ciegas.
  it('no escribe si no pudo leer el contacto', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    const err = await actualizarContacto('c1', { ...DATOS_VACIOS, email: 'x@y.com' }, { ...deps, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(err).toBeTruthy();
  });

  it('etiqueta con el producto de interés', async () => {
    const fetchImpl = contactoYPut({});
    await actualizarContacto('c1', { ...DATOS_VACIOS, nombre: 'Ana', producto: 'hogar' }, { ...deps, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(body.tags).toContain('agente-ia');
    expect(body.tags).toContain('interes-hogar');
  });

  // Un contacto importado trae correo y teléfono del ERP, así que no hay campos
  // vacíos que rellenar. Sin esta rama el equipo nunca sabría con quién habló
  // el agente ni qué le interesaba.
  it('escribe los tags aunque no haya ningún campo que rellenar', async () => {
    const fetchImpl = contactoYPut({ email: 'ya@estaba.com', phone: '+506 1', tags: ['origen-erp-2026'] });
    await actualizarContacto(
      'c1', { ...DATOS_VACIOS, email: 'otro@x.com', producto: 'uniformes' }, { ...deps, fetchImpl },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const body = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(body.tags).toContain('origen-erp-2026');
    expect(body.tags).toContain('interes-uniformes');
  });

  // Pero tampoco se escribe por escribir: sin campos vacíos y con los tags ya
  // puestos, no hay PUT.
  it('no escribe cuando no hay campos vacíos ni tags nuevos', async () => {
    const fetchImpl = contactoYPut({ email: 'ya@estaba.com', tags: ['agente-ia', 'interes-uniformes'] });
    await actualizarContacto(
      'c1', { ...DATOS_VACIOS, email: 'otro@x.com', producto: 'uniformes' }, { ...deps, fetchImpl },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('no llama a la red cuando no hay ni un dato que guardar', async () => {
    const fetchImpl = vi.fn();
    await actualizarContacto('c1', DATOS_VACIOS, { ...deps, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('devuelve el error sin lanzar', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const err = await actualizarContacto('c1', { ...DATOS_VACIOS, nombre: 'Ana' }, { ...deps, fetchImpl });
    expect(err).toContain('ECONNRESET');
  });
});

describe('agregarNota', () => {
  it('escribe la nota en el contacto con la versión de contactos', async () => {
    const fetchImpl = ok({});
    await agregarNota('c1', 'texto de la nota', { ...deps, fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain('/contacts/c1/notes');
    expect(init.method).toBe('POST');
    expect(init.headers.Version).toBe('2021-07-28');
    expect(JSON.parse(init.body)).toEqual({ body: 'texto de la nota' });
  });

  it('devuelve el error sin lanzar', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    const err = await agregarNota('c1', 'x', { ...deps, fetchImpl });
    expect(err).toContain('500');
  });
});

describe('dispararWorkflow', () => {
  // `workflowId` es un parámetro (no una constante fija adentro): este mismo
  // agente dispara más de un workflow — "Notificación interna (Respondió el
  // email)" desde procesar.ts y "Cotización nueva" desde
  // app/api/cotizacion/route.ts — y cada llamador decide cuál.
  it('pega en la ruta del workflow que se le pida', async () => {
    const fetchImpl = ok({});
    await dispararWorkflow('c1', 'workflow-cualquiera', { ...deps, fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toContain('/contacts/c1/workflow/workflow-cualquiera');
    expect(fetchImpl.mock.calls[0][1].method).toBe('POST');
  });

  // GoHighLevel devolvió 422 en producción porque el cuerpo mandaba
  // `toISOString()` (con "Z" y milisegundos) en vez del desfase horario
  // explícito que pide su propio mensaje de error. Esta prueba mira el
  // cuerpo de la petición, no sólo la ruta y el método — antes ninguna
  // prueba de este describe lo hacía, y por eso el 422 llegó a producción
  // sin que la suite lo viera venir.
  it('manda eventStartTime con desfase horario explícito, sin Z y sin milisegundos', async () => {
    const fetchImpl = ok({});
    await dispararWorkflow('c1', 'workflow-cualquiera', { ...deps, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.eventStartTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/);
  });

  it('devuelve el error sin lanzar', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    const err = await dispararWorkflow('c1', 'workflow-cualquiera', { ...deps, fetchImpl });
    expect(err).toContain('500');
  });
});

describe('horaEventoGHL', () => {
  it('produce el formato exacto que GoHighLevel exige: desfase +00:00, sin Z y sin milisegundos', () => {
    const fecha = new Date('2021-06-23T03:30:00.579Z');
    expect(horaEventoGHL(fecha)).toBe('2021-06-23T03:30:00+00:00');
  });

  it('rechaza explícitamente la forma que produce toISOString() (con Z)', () => {
    const fecha = new Date('2021-06-23T03:30:00.579Z');
    expect(horaEventoGHL(fecha)).not.toContain('Z');
    expect(horaEventoGHL(fecha)).not.toMatch(/\./);
  });

  it('es determinista: no depende de la hora del reloj ni de la zona horaria de la máquina', () => {
    const fecha = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0));
    expect(horaEventoGHL(fecha)).toBe('2026-01-01T00:00:00+00:00');
  });
});

describe('leerContacto', () => {
  it('lee las etiquetas del contacto con la versión de contactos', async () => {
    const fetchImpl = ok({ contact: { tags: ['agente-ia', 'Stop_bot'] } });
    const r = await leerContacto('c1', { ...deps, fetchImpl });
    expect(r).toEqual({ ok: true, etiquetas: ['agente-ia', 'Stop_bot'], nombre: null, email: null, telefono: null });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain('/contacts/c1');
    expect(init.headers.Version).toBe('2021-07-28');
  });

  it('devuelve un array vacío si el contacto no trae tags', async () => {
    const fetchImpl = ok({ contact: {} });
    const r = await leerContacto('c1', { ...deps, fetchImpl });
    expect(r).toEqual({ ok: true, etiquetas: [], nombre: null, email: null, telefono: null });
  });

  // El objeto entero ya se pedía para sacar las etiquetas; esto no cuesta una
  // llamada HTTP aparte. `cerebro.ts` lo usa para confirmar en vez de volver a
  // preguntar lo que el CRM ya sabía (ver el prompt del sistema).
  it('devuelve también nombre, correo y teléfono de la ficha, en la misma llamada', async () => {
    const fetchImpl = ok({
      contact: { tags: [], firstName: 'Alejandro', lastName: 'Aguilar', email: 'ale@luxe.cr', phone: '+506 8888 8888' },
    });
    const r = await leerContacto('c1', { ...deps, fetchImpl });
    expect(r).toEqual({
      ok: true, etiquetas: [], nombre: 'Alejandro Aguilar', email: 'ale@luxe.cr', telefono: '+506 8888 8888',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('arma el nombre completo aunque sólo venga el firstName', async () => {
    const fetchImpl = ok({ contact: { tags: [], firstName: 'Alejandro' } });
    const r = await leerContacto('c1', { ...deps, fetchImpl });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.nombre).toBe('Alejandro');
  });

  it('trata los campos en blanco como ausentes, no como cadena vacía', async () => {
    const fetchImpl = ok({ contact: { tags: [], firstName: '', email: '', phone: '' } });
    const r = await leerContacto('c1', { ...deps, fetchImpl });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.nombre).toBeNull();
    expect(r.email).toBeNull();
    expect(r.telefono).toBeNull();
  });

  it('devuelve el error sin lanzar cuando GHL responde con un error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    const r = await leerContacto('c1', { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('500');
  });

  it('devuelve el error sin lanzar cuando la red falla', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const r = await leerContacto('c1', { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('ECONNRESET');
  });
});

describe('resumenParaNota', () => {
  it('lista los datos capturados y el canal', () => {
    const nota = resumenParaNota({ ...DATOS_VACIOS, nombre: 'Ana Pérez', telefono: '+502 5555' }, 'WhatsApp');
    expect(nota).toContain('Ana Pérez');
    expect(nota).toContain('+502 5555');
    expect(nota).toContain('WhatsApp');
  });

  it('dice explícitamente qué falta, para que el asesor lo vea de un vistazo', () => {
    const nota = resumenParaNota({ ...DATOS_VACIOS, nombre: 'Ana' }, 'IG');
    expect(nota.toLowerCase()).toContain('falta');
  });
});
