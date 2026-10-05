import 'server-only';
import { armarCorreoParaDestinatario, htmlBaseDeCampana } from '@/lib/campanas/envio';

// El correo EXACTO que se le mandó a una persona, para la ventana que se
// abre al hacer clic en una fila de «Correos enviados». No se reconstruye ni
// se aproxima: se vuelve a armar con las mismas funciones que lo armaron al
// enviarlo (`htmlBaseDeCampana` + `armarCorreoParaDestinatario`, las que usa
// `enviarTanda`), sobre el asunto y el html que guardó la campaña y el
// nombre que traía el envío. Sólo lectura; nada de esto llama al proveedor
// de correo.
//
// Va aparte del listado a propósito: el cuerpo pesa ~10 KB por fila y casi
// nunca se abre, así que sólo se pide cuando se abre la ventana.
export type Db = { from: (tabla: string) => any };

export type CorreoEnviado = {
  id: string;
  destinatario: string;
  empresa: string;
  zona: string | null;
  plantilla: string;
  campanaId: string;
  enviadoAt: string;
  // `false`: el envío quedó en error y el correo nunca salió. Se muestra
  // igual, como se habría visto, pero la ventana lo aclara.
  salio: boolean;
  asunto: string;
  html: string;
};

// `null` si no existe o si todavía es 'pendiente' (no se mandó: no hay
// «correo enviado» que mostrar).
export async function leerCorreoEnviado(db: Db, id: string): Promise<CorreoEnviado | null> {
  const { data: fila, error } = await db
    .from('campanas_envios')
    .select('id, correo, nombre_crm, estado, actualizado_at, campana_id')
    .eq('id', id)
    .in('estado', ['enviado', 'error'])
    .maybeSingle();
  if (error) throw new Error(`No se pudo leer el envío: ${error.message}`);
  if (!fila) return null;

  const { data: campana, error: errorCampana } = await db
    .from('campanas')
    .select('asunto, html, preview_text, zona, plantilla')
    .eq('id', fila.campana_id)
    .maybeSingle();
  if (errorCampana) throw new Error(`No se pudo leer la campaña: ${errorCampana.message}`);
  if (!campana) return null;

  const correo = armarCorreoParaDestinatario(
    htmlBaseDeCampana(campana.html as string, campana.preview_text as string | null),
    campana.asunto as string,
    { correo: fila.correo as string, nombreCrm: fila.nombre_crm as string },
  );

  return {
    id: fila.id,
    destinatario: fila.correo,
    empresa: fila.nombre_crm,
    zona: campana.zona ?? null,
    plantilla: campana.plantilla,
    campanaId: fila.campana_id,
    enviadoAt: fila.actualizado_at,
    salio: fila.estado === 'enviado',
    asunto: correo.asunto,
    html: correo.html,
  };
}
