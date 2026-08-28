// El correo con el que la cotización le llega al hotel. El PDF (Tarea 2) y
// el enlace firmado (Tarea 3) ya vienen hechos; acá sólo se arma el mensaje
// y se manda por Resend.
//
// Se llama a `POST https://api.resend.com/emails` con `fetch` en vez de usar
// el SDK de Resend, para mantener el mismo patrón que `lib/cotizador/ghl.ts`
// y `lib/agente/acciones.ts`: `fetchImpl` inyectable, nunca lanza, se puede
// probar sin red.
import 'server-only';
import { formatearFechaLargaCR } from '@/lib/cotizador/fechas';

const RESEND_URL = 'https://api.resend.com/emails';

export type ParamsCorreo = {
  numero: string;
  cliente: { nombre: string; empresa?: string; email: string };
  total: number;
  vence: Date;
  pdf: Buffer;
  enlace: string;
};

export type DepsCorreo = { apiKey: string; remitente: string; fetchImpl?: typeof fetch };

export type ResultadoCorreo = { ok: true; resendId: string } | { ok: false; error: string };

// Mismo criterio que `colones()` en `lib/cotizador/documento.tsx`: sin
// `toLocaleString`/`Intl.NumberFormat`, porque el separador de miles que trae
// el runtime de Node para `es-CR` varía entre versiones de ICU (a veces un
// espacio, no un punto), y un correo que lee el cliente no puede depender de
// eso.
function colones(valor: number): string {
  return `₡${Math.round(valor).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}

// Fecha en palabras ("26 de setiembre de 2026"), con los nombres de mes de
// Costa Rica — ver `lib/cotizador/fechas.ts`, compartido con `documento.tsx`
// para que el correo y el PDF nunca digan cosas distintas.
const formatearVigencia = formatearFechaLargaCR;

// HTML plano, con estilos en línea y sin flexbox/grid: nada que un cliente de
// correo como Outlook no sepa pintar. Un párrafo, el monto destacado, la
// vigencia, el enlace y la firma — nada de tablas de plantilla ni fórmulas
// tipo "Estimado cliente".
function cuerpoHtml(p: ParamsCorreo): string {
  const primerNombre = p.cliente.nombre.trim().split(/\s+/)[0] ?? p.cliente.nombre;
  const destino = p.cliente.empresa ? ` para ${p.cliente.empresa}` : '';

  // Ronda de correcciones 1 (Tarea 5): cuando `enlaceFirmado` falla, la ruta
  // manda `enlace: ''` para no bloquear el correo por eso — pero antes este
  // párrafo se imprimía igual, y el hotel leía "puede abrirla acá:" seguido
  // de un enlace vacío. Sin enlace, el párrafo entero se omite.
  return `
<div style="font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #20211f; max-width: 560px; margin: 0 auto;">
  <p style="margin: 0 0 16px 0;">Hola ${primerNombre},</p>
  <p style="margin: 0 0 16px 0;">
    Le adjunto la cotización <strong>${p.numero}</strong>${destino}, en PDF.
  </p>
  <p style="margin: 0 0 20px 0;">
    El total es
    <span style="font-size: 20px; font-weight: bold; color: #93712f;">${colones(p.total)}</span>,
    válido hasta el <strong>${formatearVigencia(p.vence)}</strong>.
  </p>
  ${p.enlace
    ? `<p style="margin: 0 0 20px 0;">
    Si prefiere verla desde el navegador en vez del adjunto, puede abrirla acá:<br />
    <a href="${p.enlace}" style="color: #93712f;">${p.enlace}</a>
  </p>`
    : ''}
  <p style="margin: 0;">
    Saludos,<br />
    Luxe Essentials
  </p>
</div>
`.trim();
}

// Nunca lanza: un fallo mandando el correo no debe tumbar el flujo de
// cotización, que ya guardó el PDF y la fila antes de llegar acá. Devuelve
// el texto del error para que la pantalla lo muestre y el vendedor decida
// reintentar o mandar el enlace a mano.
export async function enviarCotizacion(
  p: ParamsCorreo, deps: DepsCorreo,
): Promise<ResultadoCorreo> {
  const { apiKey, remitente, fetchImpl = fetch } = deps;

  if (!apiKey) return { ok: false, error: 'Falta RESEND_API_KEY: no se pudo enviar el correo.' };
  // Ronda de correcciones final (hallazgo menor): el remitente no se
  // validaba temprano como sí se valida la llave. Con la variable vacía,
  // `cuerpo.from` salía como `''` y Resend devolvía un error opaco (algo
  // como "from must not be empty") en vez de decir qué faltaba configurar —
  // y es literalmente lo primero que va a pasar el día que se configure
  // Resend si alguien olvida `LUXE_CORREO_REMITENTE`.
  if (!remitente) return { ok: false, error: 'Falta LUXE_CORREO_REMITENTE: no se pudo enviar el correo.' };

  const cuerpo = {
    from: remitente,
    to: [p.cliente.email],
    subject: `Cotización ${p.numero} — Luxe Essentials`,
    html: cuerpoHtml(p),
    attachments: [
      {
        filename: `${p.numero}.pdf`,
        content: p.pdf.toString('base64'),
      },
    ],
  };

  try {
    const res = await fetchImpl(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(cuerpo),
    });
    const texto = await res.text();
    if (!res.ok) return { ok: false, error: `Resend ${res.status}: ${texto.slice(0, 300)}` };

    const datos = JSON.parse(texto) as { id?: string };
    if (!datos.id) return { ok: false, error: `Resend respondió sin id: ${texto.slice(0, 300)}` };

    return { ok: true, resendId: datos.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
