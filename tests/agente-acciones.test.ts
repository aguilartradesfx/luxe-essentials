import { describe, it, expect, vi } from 'vitest';
import { enviarMensaje, actualizarContacto, agregarNota, dispararWorkflow, resumenParaNota } from '@/lib/agente/acciones';
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
  it('pega en la ruta del workflow de aviso interno', async () => {
    const fetchImpl = ok({});
    await dispararWorkflow('c1', { ...deps, fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toContain('/contacts/c1/workflow/1235c311-b3e6-4b7d-be40-0ec2a1f01a60');
    expect(fetchImpl.mock.calls[0][1].method).toBe('POST');
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
