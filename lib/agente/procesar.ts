import { config } from '@/lib/agente/config';
import { canalDeEnvio, esCorreo } from '@/lib/agente/canal';
import { hidratar, ultimoReal, huboRespuestaHumana } from '@/lib/agente/conversacion';
import { prepararMedios } from '@/lib/agente/medios';
import { generar } from '@/lib/agente/cerebro';
import {
  enviarMensaje, actualizarContacto, agregarNota, dispararWorkflow, resumenParaNota, leerContacto,
} from '@/lib/agente/acciones';
import {
  leerOCrear, tomarMensaje, guardar, fusionarDatos, type Db, type Fila, type Datos,
} from '@/lib/agente/estado';
import { registrarIntencion } from '@/lib/cotizador/borrador';

// No hay variante 'agotado': al consumir el último turno el desenlace sigue
// siendo 'respondido' (el cliente sí recibió respuesta), y es el mensaje
// SIGUIENTE el que sale por 'inactivo'.
export type Desenlace =
  | 'respondido' | 'sin-entrante' | 'humano-presente' | 'duplicado'
  | 'inactivo' | 'canal-no-soportado' | 'stop-bot' | 'mensaje-automatico' | 'error';

export type DepsProcesar = {
  db: Db;
  ghlApiKey: string;
  locationId: string;
  anthropicKey: string;
  openaiKey: string;
  fetchImpl?: typeof fetch;
};

// El equipo se entera del contacto en cuanto ocurre cualquiera de tres casos
// — todos disparan el mismo workflow, config.WORKFLOW_AVISO_INTERNO:
//   1. el contacto responde por correo electrónico,
//   2. el turno captó un lead cualificado -nombre y además correo o
//      teléfono- por cualquier canal (WhatsApp, SMS, Instagram, Facebook...),
//   3. se agotaron los turnos (`agotado`) sin haber logrado ninguno de los
//      dos anteriores.
// El caso 2 es el que debería dispararse en casi toda conversación que llega
// a buen puerto; el caso 3 es sólo la red para cuando no se logra. El caso 1
// hoy en día es un subconjunto casi seguro del 2 (quien responde por correo
// ya dejó su correo), pero se conserva aparte porque no depende de que el
// modelo haya extraído el nombre.
//
// `notificado_at` sigue siendo la guarda de una sola vez por contacto: una
// vez avisado, no se vuelve a avisar aunque después se cumpla otro caso.
function debeAvisar(fila: Fila, datos: Datos, agotado: boolean, esCorreoRespuesta: boolean): boolean {
  if (fila.notificado_at) return false;
  const leadCualificado = Boolean(datos.nombre) && Boolean(datos.email || datos.telefono);
  return esCorreoRespuesta || leadCualificado || agotado;
}

// El arriendo se toma ANTES del trabajo caro, así que hay que soltarlo también
// cuando ese trabajo falla. Si no, el contacto queda bloqueado hasta 90 s — y
// justo después de un turno fallido es cuando el cliente vuelve a escribir,
// así que su reintento se descartaría en silencio. Eso es exactamente la espera
// muda que este agente existe para evitar.
async function liberarArriendo(contactId: string, db: Db): Promise<void> {
  await guardar(contactId, { procesando_hasta: null }, db);
}

export async function procesar(
  contactId: string, deps: DepsProcesar,
): Promise<{ desenlace: Desenlace; detalle?: string }> {
  const { db, ghlApiKey, locationId, anthropicKey, openaiKey, fetchImpl } = deps;
  const escritura = { apiKey: ghlApiKey, fetchImpl };

  const fila = await leerOCrear(contactId, db);
  if (fila.estado !== 'activo') return { desenlace: 'inactivo', detalle: fila.estado };

  const hidratado = await hidratar(contactId, { apiKey: ghlApiKey, locationId, fetchImpl });
  if (!hidratado.ok) return { desenlace: 'error', detalle: hidratado.error };
  const { conversacion } = hidratado;

  // ORDEN DE LAS DOS GUARDAS SIGUIENTES — a propósito, no accidental.
  //
  // La guarda del humano (abajo) escribe un LATCH PERMANENTE: en cuanto se
  // detecta, `estado` pasa a 'humano' y el contacto no vuelve a pasar por
  // aquí nunca más. La guarda de la etiqueta Stop_bot (más abajo todavía) es
  // un INTERRUPTOR REVERSIBLE: no persiste nada, se revisa de cero en cada
  // mensaje, y en cuanto el asesor la quita el agente vuelve a hablar solo.
  //
  // Antes la de Stop_bot corría PRIMERO, antes incluso de hidratar. Eso
  // rompía lo permanente: un asesor que etiqueta Stop_bot y LUEGO responde
  // deja al contacto con un saliente humano real en la conversación, pero la
  // guarda de la etiqueta cortaba el turno antes de que `hidratar` trajera
  // esa conversación y antes de que `huboRespuestaHumana` pudiera verla — el
  // latch nunca se escribía. Semanas después alguien quita la etiqueta, y
  // `huboRespuestaHumana` ya no ve nada (sólo mira salientes posteriores al
  // último entrante), así que el agente vuelve a hablarle encima al asesor.
  //
  // Por eso ahora lo permanente se revisa PRIMERO: si hay un saliente humano
  // en la conversación, el latch se escribe pase lo que pase con la
  // etiqueta, y el turno termina ahí. La etiqueta sólo importa cuando el
  // latch NO se disparó. El costo de este orden es que ahora `hidratar` (una
  // lectura, no la llamada a Claude) corre siempre, incluso para un contacto
  // etiquetado — pero lo caro de verdad, `generar`, sigue evitándose: la
  // etiqueta corta el turno antes de llegar ahí. Que nadie vuelva a invertir
  // este orden sin volver a leer este comentario.
  if (huboRespuestaHumana(conversacion, fila.enviados)) {
    const errorLatch = await guardar(contactId, { estado: 'humano' }, db);
    // Este latch es lo único que hace permanente la guarda. Si no se persiste,
    // el agente puede volver a hablarle encima al asesor en cuanto el cliente
    // escriba otra vez, porque huboRespuestaHumana sólo mira los salientes
    // posteriores al último entrante. Por eso se registra aparte y más fuerte
    // que el resto de fallos de escritura.
    if (errorLatch) {
      console.error(
        '[agente] NO SE PUDO MARCAR EL CONTACTO COMO ATENDIDO POR UN HUMANO.',
        'El agente podría volver a responder sobre esta conversación.',
        'contacto:', contactId, errorLatch,
      );
    }
    return { desenlace: 'humano-presente' };
  }

  // Guarda de la etiqueta Stop_bot: interruptor reversible (ver el comentario
  // grande de arriba sobre el orden). Va antes de preparar medios o llamar al
  // modelo — pedirle a Claude qué contestar para después tirar la respuesta
  // sería pagar por nada.
  //
  // Si la lectura de GHL falla (con reintento — ver `leerContacto` en
  // acciones.ts), el agente se calla igual (fail-closed) en vez de responder.
  // Se eligió así porque el costo de las dos opciones no es simétrico: un
  // cliente que espera un poco más se recupera solo —no se persiste nada en
  // este punto, así que su próximo mensaje (o un reintento de webhook de GHL)
  // vuelve a intentar el turno desde cero—, mientras que una respuesta que se
  // le habla encima a un asesor que puso la etiqueta ya salió y no hay forma
  // de deshacerla. Misma asimetría que la guarda del humano de arriba.
  //
  // El desenlace de esta lectura fallida es 'error', NO 'stop-bot': son dos
  // cosas muy distintas en los logs — un asesor que silenció el contacto a
  // propósito, contra GoHighLevel caído — y antes de este arreglo se
  // reportaban igual, así que no había forma de distinguir una de la otra.
  const contacto = await leerContacto(contactId, { apiKey: ghlApiKey, fetchImpl });
  if (!contacto.ok) {
    console.error(
      '[agente] No se pudo leer la ficha del contacto; se calla por seguridad.',
      'contacto:', contactId, contacto.error,
    );
    return { desenlace: 'error', detalle: `lectura de contacto: ${contacto.error}` };
  }
  if (config.tieneEtiquetaStopBot(contacto.etiquetas)) {
    console.error('[agente] Se calla: el contacto tiene la etiqueta Stop_bot.', 'contacto:', contactId);
    return { desenlace: 'stop-bot' };
  }

  // Guarda 1: si lo último no es un entrante real, no hay nada que contestar.
  // Es lo que mata el bucle de responderse a sí mismo, y también el caso del
  // webhook cuya conversación sólo trae actividades del CRM.
  const ultimo = ultimoReal(conversacion);
  if (!ultimo || ultimo.direccion !== 'inbound') return { desenlace: 'sin-entrante' };

  // Defensa, no camino esperado: hoy es inalcanzable porque `aMensajeReal` sólo
  // construye mensajes cuyo tipo pasó la allowlist, y los cinco de esa lista
  // tienen canal de envío. Se conserva en vez de castear el tipo porque si
  // alguien amplía `MensajeReal.tipo` en el futuro, un cast haría que
  // `enviarMensaje` recibiera null como canal en lugar de detener el turno.
  const canal = canalDeEnvio(ultimo.tipo);
  if (!canal) return { desenlace: 'canal-no-soportado', detalle: ultimo.tipo };

  // Guarda 3, antes del trabajo caro: si se tomara después, dos webhooks
  // simultáneos pagarían dos llamadas a Claude para acabar descartando una.
  if (!(await tomarMensaje(contactId, ultimo.id, db))) return { desenlace: 'duplicado' };

  const medios = await prepararMedios(ultimo.adjuntos, { openaiKey, fetchImpl });

  const generado = await generar(
    {
      mensajes: conversacion.mensajes,
      mios: fila.enviados,
      transcripciones: medios.transcripciones,
      bloques: medios.bloques,
      datosPrevios: fila.datos,
      fichaCRM: { nombre: contacto.nombre, email: contacto.email, telefono: contacto.telefono },
      huboFallosDeMedios: medios.fallos > 0,
      esCorreo: esCorreo(ultimo.tipo),
    },
    { anthropicKey, fetchImpl },
  );
  if (!generado.ok) {
    await liberarArriendo(contactId, db);
    return { desenlace: 'error', detalle: generado.error };
  }

  // El otro lado también puede tener un bot: un saludo de bienvenida que
  // salta solo, un aviso de fuera de horario. Nadie leyó nuestro mensaje
  // todavía, así que contestar sería hablarle a ese bot. El criterio es del
  // modelo (ver MENSAJES AUTOMÁTICOS en PROMPT_SISTEMA), deliberadamente
  // conservador: ante la duda marca false y este bloque no se ejecuta. No se
  // manda "respuesta", no se cuenta el turno y no se toca la ficha del
  // contacto — el nombre de un saludo automático es el del negocio, no el de
  // quien vaya a escribir después, y guardarlo contaminaría la ficha. El
  // mensaje SÍ queda marcado como procesado: `tomarMensaje` ya escribió
  // `ultimo_mensaje_id` antes de esta llamada, así que un reintento del
  // webhook no lo vuelve a evaluar. Se libera el arriendo para que, si la
  // persona real escribe segundos después, ese mensaje nuevo no espere a que
  // expire el candado de 90 s de éste.
  if (generado.salida.esAutomatico) {
    console.error(
      '[agente] Mensaje entrante identificado como respuesta automática; no se responde.',
      'contacto:', contactId, (ultimo.texto || '').slice(0, 200),
    );
    await liberarArriendo(contactId, db);
    return { desenlace: 'mensaje-automatico' };
  }

  const envio = await enviarMensaje(
    { contactId, canal, texto: generado.salida.respuesta }, escritura,
  );
  // El turno no se consume si el envío falló: el siguiente mensaje del cliente
  // lo reintenta en vez de darlo por perdido.
  if (!envio.ok) {
    await liberarArriendo(contactId, db);
    return { desenlace: 'error', detalle: envio.error };
  }

  const datos = fusionarDatos(fila.datos, generado.salida.datos);
  const turnos = fila.turnos + 1;
  const esCorreoRespuesta = esCorreo(ultimo.tipo);

  const estado = esCorreoRespuesta
    ? 'email_respondido'
    : turnos >= config.TOPE_TURNOS
      ? 'agotado'
      : 'activo';

  const avisar = debeAvisar(fila, datos, estado === 'agotado', esCorreoRespuesta);

  // El aviso al equipo se dispara ANTES de estampar `notificado_at`, y sólo se
  // estampa si salió bien. Al revés —estampar y luego disparar— un 500 pasajero
  // de GHL perdería el aviso para siempre: `debeAvisar` no volvería a
  // autorizarlo nunca. Y como un contacto que sale de este turno en
  // 'email_respondido' o 'agotado' no vuelve a pasar por aquí (guarda 1/2 sólo
  // procesan `estado === 'activo'`), no hay ningún turno futuro de este
  // contacto que reintente el aviso: un lead cualificado, o que ya respondió,
  // del que nadie en Luxe se entera — que es justo lo que este agente existe
  // para evitar. Por eso `dispararWorkflow` (acciones.ts) reintenta una vez
  // ante un 5xx/fallo de red antes de darse por vencido: para estos dos
  // estados terminales es la única red que existe contra un fallo pasajero.
  // Ver el comentario de esa función para el porqué de elegir un reintento y
  // no otro mecanismo, y qué pasa si el reintento también falla.
  // El estado se persiste PRIMERO, en cuanto el mensaje salió, porque es lo
  // único de lo que dependen las guardas del turno siguiente: perder `enviados`
  // deja al agente confundiendo su propio saliente con el de un asesor. Las
  // escrituras en GHL van después; ninguna guarda depende de ellas.
  const errorGuardar = await guardar(
    contactId,
    {
      conversation_id: conversacion.conversationId,
      canal: ultimo.tipo,
      datos,
      turnos,
      estado,
      // Se libera el arriendo del contacto: el turno terminó y el siguiente
      // mensaje no debe esperar a que expire.
      procesando_hasta: null,
      enviados: envio.messageId ? [...fila.enviados, envio.messageId] : fila.enviados,
    },
    db,
  );

  // Estas escrituras no pueden hacer fallar el turno: al cliente ya se le
  // respondió, que es lo que importa. Sus errores van al log y nada más.
  //
  // `registrarIntencion` va aquí, DESPUÉS de `guardar`, y no entre enviar y
  // guardar. Ese hueco es el peor lugar posible: si el proceso se queda sin
  // presupuesto de tiempo mientras corre la consulta de borradores, `guardar`
  // nunca llega a ejecutarse, se pierde el `messageId` en `enviados`, y en el
  // turno siguiente el propio saliente del agente parece de un asesor humano
  // — el contacto queda mudo para siempre. Aquí abajo, un fallo o una demora
  // de `registrarIntencion` no puede impedir que el estado ya se haya
  // persistido.
  const errores: (string | undefined)[] = [
    errorGuardar,
    await actualizarContacto(contactId, datos, escritura),
    await agregarNota(contactId, resumenParaNota(datos, canal), escritura),
    await registrarIntencion({ contactId, datos }, db),
  ];

  // El aviso al equipo va AL FINAL, cuando el contacto ya tiene sus campos, sus
  // tags y su nota escritos. Si se disparara antes, el asesor abriría la
  // notificación y encontraría un contacto todavía en blanco.
  //
  // Y `notificado_at` se estampa sólo si el disparo salió, en una segunda
  // escritura pequeña. Al revés —estampar junto con el resto y disparar
  // después— un 500 pasajero de GHL perdería el aviso para siempre, porque
  // `debeAvisar` no volvería a autorizarlo nunca.
  if (avisar) {
    const errorAviso = await dispararWorkflow(contactId, config.WORKFLOW_AVISO_INTERNO, escritura);
    errores.push(errorAviso);
    if (!errorAviso) {
      errores.push(await guardar(contactId, { notificado_at: new Date().toISOString() }, db));
    }
  }

  const reales = errores.filter(Boolean);

  if (reales.length > 0) {
    console.error('[agente] Se respondió pero falló alguna escritura.', 'contacto:', contactId, reales);
  }

  return { desenlace: 'respondido' };
}
