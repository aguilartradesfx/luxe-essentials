// Los dos correos del descuento personalizado con aprobación
// (docs/superpowers/specs/2026-09-02-descuento-aprobacion-design.md):
//
//   - `enviarSolicitudAprobacion`: a todos los superadmin activos, cuando un
//     vendedor pide un descuento fuera de escala.
//   - `enviarResolucionAprobacion`: al vendedor que lo pidió, cuando se
//     resuelve -- aprobado (tal cual o con el porcentaje cambiado) o
//     rechazado.
//
// Mismo patrón que lib/cotizador/correo-invitacion.ts: `fetch` crudo contra
// Resend, `fetchImpl` inyectable, nunca lanza, tablas + estilos en línea
// (Outlook no soporta hojas de estilo ni flexbox/grid), versión en texto
// plano, y TODO lo que puede haber escrito una persona se escapa antes de
// interpolarse en el HTML -- `cliente.nombre`, `cliente.empresa`,
// `solicitadoPor`, `aprobadoPor` y `motivoRechazo` los escribe un vendedor o
// un superadmin, no el sistema, y son exactamente el tipo de valor que sin
// escapar deja colar un enlace de phishing con remitente y dominio
// legítimos (ver el comentario de `escaparHtml` en correo-invitacion.ts,
// que documenta el hallazgo real que motiva esto).
import 'server-only';
import type { DepsCorreo, ResultadoCorreo } from '@/lib/cotizador/correo';
import type { DescuentoPersonalizado } from '@/lib/cotizador/tipos';

const RESEND_URL = 'https://api.resend.com/emails';

const NAVY = '#2F4156';
const TEAL = '#567C8D';
const BEIGE = '#F5EFEB';
const TINTA = '#2A2A2A';
const TINTA_SUAVE = '#6B7A85';
// Mismo tono que `correo.ts` usa para destacar el total: acá se reutiliza
// para el porcentaje que cambió, el dato más caro de pasar por alto.
const AMBAR = '#93712f';

export type ClienteCorreo = { nombre: string; empresa?: string; email: string };

function urlSitio(): string {
  return process.env.NEXT_PUBLIC_SITE_URL || 'https://luxeessentialscr.com';
}

function enlacePanel(): string {
  return `${urlSitio()}/cotizador`;
}

function escaparHtml(valor: string): string {
  return valor
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Mismo criterio que `colones()` en lib/cotizador/correo.ts y
// lib/cotizador/documento.tsx: sin `toLocaleString`/`Intl.NumberFormat`,
// porque el separador de miles de `es-CR` varía entre versiones de ICU del
// runtime, y un correo no puede depender de eso. Se duplica acá a
// propósito, mismo motivo que en esos dos módulos: no vale la pena una
// dependencia compartida por tres líneas que además cada módulo puede
// necesitar ajustar por separado el día que Luxe pida otro formato.
function colones(valor: number): string {
  return `₡${Math.round(valor).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}

function nombreDestino(cliente: ClienteCorreo): string {
  return cliente.empresa ? `${cliente.nombre} (${cliente.empresa})` : cliente.nombre;
}

// Texto corto y legible del descuento pedido/aprobado, para los dos
// correos. Las claves de `familias` son un `GrupoDescuento` cerrado (los
// seis de lib/cotizador/tipos.ts) y los porcentajes son números -- ninguno
// de los dos es texto libre de una persona, así que no hace falta
// escaparlos.
export function formatearDescuento(d: DescuentoPersonalizado): string {
  if ('general' in d) return `general, ${d.general}%`;
  const partes = Object.entries(d.familias)
    .filter((par): par is [string, number] => par[1] !== undefined)
    .map(([grupo, pct]) => `${grupo}: ${pct}%`);
  return `por familia (${partes.join(', ')})`;
}

function envoltorio(tituloHtml: string, cuerpoHtml: string): string {
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: ${BEIGE};">
  <tr>
    <td align="center" style="padding: 40px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width: 100%; max-width: 600px; background-color: #ffffff; border-radius: 12px; overflow: hidden;">
        <tr>
          <td style="background-color: ${NAVY}; padding: 36px 40px;">
            <span style="font-family: Georgia, 'Times New Roman', serif; font-size: 22px; letter-spacing: 0.5px; color: #ffffff;">
              Luxe Essentials
            </span>
          </td>
        </tr>
        <tr>
          <td style="background-color: ${TEAL}; height: 4px; line-height: 4px; font-size: 1px;">&nbsp;</td>
        </tr>
        <tr>
          <td style="padding: 40px 40px 8px 40px; font-family: Arial, Helvetica, sans-serif; color: ${TINTA};">
            <p style="margin: 0 0 20px 0; font-size: 22px; font-weight: bold; line-height: 1.35; color: ${NAVY};">
              ${tituloHtml}
            </p>
            ${cuerpoHtml}
          </td>
        </tr>
        <tr>
          <td align="center" style="padding: 0 40px 36px 40px;">
            <table role="presentation" cellpadding="0" cellspacing="0">
              <tr>
                <td align="center" style="background-color: ${TEAL}; border-radius: 8px;">
                  <a href="${escaparHtml(enlacePanel())}" style="display: inline-block; padding: 15px 40px; font-family: Arial, Helvetica, sans-serif; font-size: 16px; font-weight: bold; color: #ffffff; text-decoration: none;">
                    Ver en el panel
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
`.trim();
}

// --- Solicitud (a los superadmin) ---

export type ParamsSolicitudCorreo = {
  // Uno o más destinatarios -- todos los superadmin activos, en un solo
  // correo (Resend acepta varios `to`). Ver `avisarSolicitudAprobacion` en
  // lib/cotizador/aprobacion.ts, que arma esta lista.
  para: string[];
  numero: string;
  cliente: ClienteCorreo;
  total: number;
  descuentoPedido: DescuentoPersonalizado;
  solicitadoPor: string;
};

function cuerpoSolicitudHtml(p: ParamsSolicitudCorreo): string {
  const cliente = escaparHtml(nombreDestino(p.cliente));
  const solicitante = escaparHtml(p.solicitadoPor);
  return envoltorio(
    'Un descuento personalizado espera tu aprobación',
    `
    <p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.6;">
      <strong>${solicitante}</strong> pidió un descuento fuera de escala para la cotización
      <strong>${escaparHtml(p.numero)}</strong>, para <strong>${cliente}</strong>.
    </p>
    <p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.6;">
      Descuento pedido: <strong>${formatearDescuento(p.descuentoPedido)}</strong>.<br />
      Monto de la cotización: <span style="font-size: 18px; font-weight: bold; color: ${AMBAR};">${colones(p.total)}</span>.
    </p>
    <p style="margin: 0 0 20px 0; font-size: 15px; line-height: 1.6; color: ${TINTA_SUAVE};">
      La cotización no sale al cliente hasta que la apruebes, la cambies o la rechaces.
    </p>
    `,
  );
}

function cuerpoSolicitudTexto(p: ParamsSolicitudCorreo): string {
  return [
    'LUXE ESSENTIALS',
    '',
    'Un descuento personalizado espera tu aprobación',
    '',
    `${p.solicitadoPor} pidió un descuento fuera de escala para la cotización ${p.numero},`,
    `para ${nombreDestino(p.cliente)}.`,
    '',
    `Descuento pedido: ${formatearDescuento(p.descuentoPedido)}`,
    `Monto de la cotización: ${colones(p.total)}`,
    '',
    'La cotización no sale al cliente hasta que la apruebes, la cambies o la rechaces.',
    '',
    enlacePanel(),
  ].join('\n');
}

export async function enviarSolicitudAprobacion(
  p: ParamsSolicitudCorreo,
  deps: DepsCorreo,
): Promise<ResultadoCorreo> {
  const { apiKey, remitente, fetchImpl = fetch } = deps;

  if (!apiKey) return { ok: false, error: 'Falta RESEND_API_KEY: no se pudo enviar el correo.' };
  if (!remitente) return { ok: false, error: 'Falta LUXE_CORREO_REMITENTE: no se pudo enviar el correo.' };
  if (p.para.length === 0) {
    return { ok: false, error: 'No hay ningún superadmin activo a quien avisar.' };
  }

  const cuerpo = {
    from: remitente,
    to: p.para,
    subject: `Descuento por aprobar — ${p.numero}`,
    html: cuerpoSolicitudHtml(p),
    text: cuerpoSolicitudTexto(p),
  };

  return enviarPorResend(cuerpo, fetchImpl, apiKey);
}

// --- Resolución (al vendedor que la pidió) ---

export type ParamsResolucionCorreo = {
  para: string;
  numero: string;
  cliente: ClienteCorreo;
  resultado: 'aprobada' | 'rechazada';
  descuentoPedido: DescuentoPersonalizado;
  // Sólo tiene valor cuando `resultado === 'aprobada'`.
  descuentoAprobado?: DescuentoPersonalizado;
  // El dato más caro de pasar por alto (diseño): si el superadmin cambió el
  // porcentaje antes de aprobar, el correo lo dice de forma destacada, para
  // que el vendedor nunca llame al hotel a hablar de un precio que el hotel
  // no recibió.
  cambioPorcentaje: boolean;
  // Sólo tiene valor cuando `resultado === 'rechazada'`.
  motivoRechazo?: string;
  resueltoPor: string;
};

function cuerpoResolucionHtml(p: ParamsResolucionCorreo): string {
  const cliente = escaparHtml(nombreDestino(p.cliente));
  const resolutor = escaparHtml(p.resueltoPor);
  const numero = escaparHtml(p.numero);

  if (p.resultado === 'rechazada') {
    const motivo = p.motivoRechazo ? escaparHtml(p.motivoRechazo) : '';
    return envoltorio(
      `Tu cotización ${numero} fue rechazada`,
      `
      <p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.6;">
        El descuento personalizado que pediste para <strong>${cliente}</strong> (cotización
        <strong>${numero}</strong>) fue rechazado por <strong>${resolutor}</strong>.
      </p>
      ${motivo
        ? `<p style="margin: 0 0 20px 0; font-size: 15px; line-height: 1.6;">Motivo: <em>${motivo}</em></p>`
        : ''}
      <p style="margin: 0; font-size: 15px; line-height: 1.6; color: ${TINTA_SUAVE};">
        Podés armar la cotización de nuevo con otro descuento, o sin uno.
      </p>
      `,
    );
  }

  const descuentoAprobado = p.descuentoAprobado ?? p.descuentoPedido;
  const avisoCambio = p.cambioPorcentaje
    ? `
      <p style="margin: 0 0 20px 0; padding: 14px 18px; background-color: #fdf1e0; border-left: 4px solid ${AMBAR}; font-size: 15px; line-height: 1.6;">
        <strong>Ojo:</strong> pediste <strong>${formatearDescuento(p.descuentoPedido)}</strong> y se aprobó
        <strong style="color: ${AMBAR};">${formatearDescuento(descuentoAprobado)}</strong>. El precio que le
        llegó al hotel es el aprobado, no el que pediste -- confirmalo antes de hablar con el cliente.
      </p>
      `
    : `
      <p style="margin: 0 0 20px 0; font-size: 15px; line-height: 1.6;">
        Se aprobó tal cual lo pediste: <strong>${formatearDescuento(descuentoAprobado)}</strong>.
      </p>
      `;

  return envoltorio(
    `Tu cotización ${numero} fue aprobada`,
    `
    <p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.6;">
      <strong>${resolutor}</strong> aprobó el descuento personalizado de la cotización
      <strong>${numero}</strong>, para <strong>${cliente}</strong>. Ya salió al cliente.
    </p>
    ${avisoCambio}
    `,
  );
}

function cuerpoResolucionTexto(p: ParamsResolucionCorreo): string {
  if (p.resultado === 'rechazada') {
    return [
      'LUXE ESSENTIALS',
      '',
      `Tu cotización ${p.numero} fue rechazada`,
      '',
      `El descuento personalizado que pediste para ${nombreDestino(p.cliente)} (cotización ${p.numero})`,
      `fue rechazado por ${p.resueltoPor}.`,
      ...(p.motivoRechazo ? ['', `Motivo: ${p.motivoRechazo}`] : []),
      '',
      'Podés armar la cotización de nuevo con otro descuento, o sin uno.',
      '',
      enlacePanel(),
    ].join('\n');
  }

  const descuentoAprobado = p.descuentoAprobado ?? p.descuentoPedido;
  return [
    'LUXE ESSENTIALS',
    '',
    `Tu cotización ${p.numero} fue aprobada`,
    '',
    `${p.resueltoPor} aprobó el descuento personalizado de la cotización ${p.numero},`,
    `para ${nombreDestino(p.cliente)}. Ya salió al cliente.`,
    '',
    p.cambioPorcentaje
      ? `OJO: pediste ${formatearDescuento(p.descuentoPedido)} y se aprobó ${formatearDescuento(descuentoAprobado)}. ` +
        'El precio que le llegó al hotel es el aprobado, no el que pediste -- confirmalo antes de hablar con el cliente.'
      : `Se aprobó tal cual lo pediste: ${formatearDescuento(descuentoAprobado)}.`,
    '',
    enlacePanel(),
  ].join('\n');
}

export async function enviarResolucionAprobacion(
  p: ParamsResolucionCorreo,
  deps: DepsCorreo,
): Promise<ResultadoCorreo> {
  const { apiKey, remitente, fetchImpl = fetch } = deps;

  if (!apiKey) return { ok: false, error: 'Falta RESEND_API_KEY: no se pudo enviar el correo.' };
  if (!remitente) return { ok: false, error: 'Falta LUXE_CORREO_REMITENTE: no se pudo enviar el correo.' };

  const cuerpo = {
    from: remitente,
    to: [p.para],
    subject: p.resultado === 'aprobada' ? `Cotización aprobada — ${p.numero}` : `Cotización rechazada — ${p.numero}`,
    html: cuerpoResolucionHtml(p),
    text: cuerpoResolucionTexto(p),
  };

  return enviarPorResend(cuerpo, fetchImpl, apiKey);
}

async function enviarPorResend(
  cuerpo: Record<string, unknown>,
  fetchImpl: typeof fetch,
  apiKey: string,
): Promise<ResultadoCorreo> {
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
