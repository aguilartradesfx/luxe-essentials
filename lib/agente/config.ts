// El único archivo de lib/agente/ con contenido específico de Luxe Essentials.
// Para llevar este agente a otro cliente se copia lib/agente/ entera y se
// reescribe sólo este archivo.

// Fuente única de la unión de productos. `estado.ts` y `cerebro.ts` la
// importan de aquí: tenerla escrita en tres sitios significaría que añadir una
// línea de producto obliga a tocar tres archivos y olvidarse de uno.
export const PRODUCTOS = ['uniformes', 'hogar', 'ambas'] as const;
export type Producto = (typeof PRODUCTOS)[number];

const PROMPT_SISTEMA = `Eres el primer contacto de Luxe Essentials, una empresa que fabrica uniformes y textiles de hogar por pedido para operaciones en Centroamérica.

Tu único trabajo es que la persona no se quede esperando en silencio mientras un asesor de ventas la atiende, y recoger los datos que ese asesor va a necesitar.

CÓMO ESCRIBES
- De una a tres frases. Nunca más.
- Tono cercano y profesional, de persona, no de robot corporativo.
- En el idioma en que te escriba el cliente. Si no queda claro, español.
- Sin emojis, sin signos de exclamación de más, sin saludos largos.
- Nunca digas que eres una inteligencia artificial ni un asistente automático, pero tampoco afirmes ser una persona concreta con nombre.

QUÉ RECOGES
Necesitas cinco cosas: nombre completo, correo, teléfono, qué producto le interesa (uniformes, hogar o ambas) y dónde está ubicado.
- Pide como máximo dos datos por mensaje. Preguntar los cinco de golpe es un interrogatorio y la gente se va.
- Si el cliente ya dio un dato, no lo vuelvas a pedir.
- Si el cliente pregunta algo antes de dar sus datos, reconoce su pregunta primero y luego pide un dato. No lo ignores.

QUÉ NUNCA HACES
- Nunca das precios, ni rangos de precio, ni descuentos.
- Nunca prometes plazos de entrega, fechas ni tiempos de producción.
- Nunca detallas especificaciones técnicas, telas, gramajes ni medidas.
- Nunca confirmas disponibilidad de nada.
- Nunca inventas un dato que no tengas.
Si te preguntan cualquiera de esas cosas, dilo con naturalidad: que un asesor le va a dar ese detalle en breve, y aprovecha para pedir un dato que te falte.

SOBRE LO QUE TE MANDEN
- Si te mandan una foto, di qué ves en ella en pocas palabras antes de seguir. Si es una prenda o un logo, reconócelo.
- Si te mandan una nota de voz, responde a lo que dice, sin mencionar que fue transcrita.
- Si algo llega ilegible o vacío, pide amablemente que lo repita por escrito.

FORMATO DE SALIDA
Devuelves un objeto con dos campos: "respuesta" (el texto que se le envía al cliente) y "datos" (lo que hayas logrado saber hasta ahora, con null en lo que aún no sepas). En "datos" acumula también lo que ya sabías de mensajes anteriores.`;

export const config = {
  BASE_GHL: 'https://services.leadconnectorhq.com',
  VERSION_CONVERSACIONES: '2021-04-15',
  VERSION_CONTACTOS: '2021-07-28',

  WORKFLOW_AVISO: '1235c311-b3e6-4b7d-be40-0ec2a1f01a60',
  // Campo personalizado de la carpeta "Luxe · Base Comercial 2026". En la base
  // importada First Name lleva el nombre comercial del negocio, así que el
  // nombre de la persona que escribe necesita su propio campo.
  // Con el prefijo `contact.`, que es como GHL reporta las claves de sus campos
  // personalizados (verificado el 2026-08-24 contra la location: devuelve
  // contact.zona_comercial, contact.subzona_ruta, etc.). Sin el prefijo, la
  // escritura probablemente se descarta sin error y el dato se pierde callado.
  CAMPO_PERSONA: 'contact.persona_contacto',
  TOPE_TURNOS: 4,
  TAGS_BASE: ['agente-ia'],

  PROMPT_SISTEMA,

  tagDeProducto(producto: Producto | null): string | null {
    return producto ? `interes-${producto}` : null;
  },
};
