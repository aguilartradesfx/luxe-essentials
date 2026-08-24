import { config } from '@/lib/agente/config';
import { canalDeEnvio, esCorreo } from '@/lib/agente/canal';
import { hidratar, ultimoReal, huboRespuestaHumana } from '@/lib/agente/conversacion';
import { prepararMedios } from '@/lib/agente/medios';
import { generar } from '@/lib/agente/cerebro';
import { enviarMensaje, actualizarContacto, agregarNota, dispararWorkflow, resumenParaNota } from '@/lib/agente/acciones';
import { leerOCrear, tomarMensaje, guardar, fusionarDatos, type Db, type Datos, type Fila } from '@/lib/agente/estado';

// No hay variante 'agotado': al consumir el último turno el desenlace sigue
// siendo 'respondido' (el cliente sí recibió respuesta), y es el mensaje
// SIGUIENTE el que sale por 'inactivo'.
export type Desenlace =
  | 'respondido' | 'sin-entrante' | 'humano-presente' | 'duplicado'
  | 'inactivo' | 'canal-no-soportado' | 'error';

export type DepsProcesar = {
  db: Db;
  ghlApiKey: string;
  locationId: string;
  anthropicKey: string;
  openaiKey: string;
  fetchImpl?: typeof fetch;
};

// El equipo se entera cuando tenemos con quién hablar y cómo contactarlo, o
// cuando el agente se quedó sin turnos — esto último para que un cliente que
// nunca da sus datos no desaparezca en silencio.
function debeAvisar(fila: Fila, datos: Datos, turnos: number): boolean {
  if (fila.notificado_at) return false;
  if (datos.nombre && (datos.email || datos.telefono)) return true;
  return turnos >= config.TOPE_TURNOS;
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

  // Guarda 2, antes que nada: si el asesor ya entró, el agente no vuelve a
  // hablar aunque el cliente siga escribiendo.
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

  // Guarda 1: si lo último no es un entrante real, no hay nada que contestar.
  // Es lo que mata el bucle de responderse a sí mismo, y también el caso del
  // webhook cuya conversación sólo trae actividades del CRM.
  const ultimo = ultimoReal(conversacion);
  if (!ultimo || ultimo.direccion !== 'inbound') return { desenlace: 'sin-entrante' };

  const canal = canalDeEnvio(ultimo.tipo);
  if (!canal) return { desenlace: 'canal-no-soportado', detalle: ultimo.tipo };

  // Guarda 3, antes del trabajo caro: si se tomara después, dos webhooks
  // simultáneos pagarían dos llamadas a Claude para acabar descartando una.
  if (!(await tomarMensaje(contactId, ultimo.id, db))) return { desenlace: 'duplicado' };

  const medios = await prepararMedios(ultimo.adjuntos, { openaiKey, fetchImpl });

  const generado = await generar(
    {
      mensajes: conversacion.mensajes,
      transcripciones: medios.transcripciones,
      bloques: medios.bloques,
      datosPrevios: fila.datos,
      huboFallosDeMedios: medios.fallos > 0,
      esCorreo: esCorreo(ultimo.tipo),
    },
    { anthropicKey, fetchImpl },
  );
  if (!generado.ok) return { desenlace: 'error', detalle: generado.error };

  const envio = await enviarMensaje(
    { contactId, canal, texto: generado.salida.respuesta }, escritura,
  );
  // El turno no se consume si el envío falló: el siguiente mensaje del cliente
  // lo reintenta en vez de darlo por perdido.
  if (!envio.ok) return { desenlace: 'error', detalle: envio.error };

  const datos = fusionarDatos(fila.datos, generado.salida.datos);
  const turnos = fila.turnos + 1;
  const avisar = debeAvisar(fila, datos, turnos);

  const estado = esCorreo(ultimo.tipo)
    ? 'email_respondido'
    : turnos >= config.TOPE_TURNOS
      ? 'agotado'
      : 'activo';

  // El aviso al equipo se dispara ANTES de estampar `notificado_at`, y sólo se
  // estampa si salió bien. Al revés —estampar y luego disparar— un 500 pasajero
  // de GHL perdería el aviso para siempre: `debeAvisar` no volvería a
  // autorizarlo nunca. Y si eso ocurre en el turno del tope, el contacto queda
  // 'agotado' y no hay ningún evento futuro que lo reintente: un lead
  // cualificado del que nadie se entera, que es justo lo que este agente existe
  // para evitar.
  const errorAviso = avisar ? await dispararWorkflow(contactId, escritura) : undefined;
  const avisoHecho = avisar && !errorAviso;

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
      ...(avisoHecho ? { notificado_at: new Date().toISOString() } : {}),
    },
    db,
  );

  // Estas escrituras no pueden hacer fallar el turno: al cliente ya se le
  // respondió, que es lo que importa. Sus errores van al log y nada más.
  const errores = [
    errorAviso,
    errorGuardar,
    await actualizarContacto(contactId, datos, escritura),
    await agregarNota(contactId, resumenParaNota(datos, canal), escritura),
  ].filter(Boolean);

  if (errores.length > 0) {
    console.error('[agente] Se respondió pero falló alguna escritura.', 'contacto:', contactId, errores);
  }

  return { desenlace: 'respondido' };
}
