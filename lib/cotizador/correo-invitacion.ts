// El correo con el que se invita a una persona a entrar al panel. Mismo
// patrón que lib/cotizador/correo.ts: `fetch` crudo contra la API de Resend,
// `fetchImpl` inyectable, nunca lanza. `DepsCorreo` y `ResultadoCorreo` se
// importan de ahí y no se redefinen — son el mismo contrato para los dos
// correos que manda este panel.
import 'server-only';
import type { DepsCorreo, ResultadoCorreo } from '@/lib/cotizador/correo';
import { HORAS_VIGENCIA } from '@/lib/cotizador/invitaciones';

const RESEND_URL = 'https://api.resend.com/emails';

// Paleta de la marca. El HTML se arma con tablas y estilos en línea porque
// los clientes de correo (Outlook en particular) no soportan hojas de
// estilo ni flexbox/grid.
const NAVY = '#2F4156';
const TEAL = '#567C8D';
const BEIGE = '#F5EFEB';

export type ParamsInvitacion = {
  para: string;
  nombre: string;
  // El enlace CRUDO, de un solo uso — llega desde `generarInvitacion` (Tarea
  // 1). Este módulo solo lo incrusta en la URL del botón y del texto plano;
  // no lo guarda ni lo transforma.
  enlace: string;
};

function urlSitio(): string {
  return process.env.NEXT_PUBLIC_SITE_URL || 'https://luxeessentialscr.com';
}

function enlaceCompleto(enlace: string): string {
  return `${urlSitio()}/cotizador/clave?enlace=${enlace}`;
}

function primerNombreDe(nombre: string): string {
  return nombre.trim().split(/\s+/)[0] ?? nombre;
}

function cuerpoHtml(p: ParamsInvitacion): string {
  const primerNombre = primerNombreDe(p.nombre);
  const url = enlaceCompleto(p.enlace);

  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: ${BEIGE};">
  <tr>
    <td align="center" style="padding: 32px 16px;">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px;">
        <tr>
          <td style="background-color: ${NAVY}; padding: 20px 32px; border-radius: 8px 8px 0 0;">
            <span style="font-family: Arial, Helvetica, sans-serif; font-size: 18px; font-weight: bold; color: #ffffff;">
              Luxe Essentials
            </span>
          </td>
        </tr>
        <tr>
          <td style="padding: 32px; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #20211f;">
            <p style="margin: 0 0 16px 0;">Hola ${primerNombre},</p>
            <p style="margin: 0 0 24px 0;">
              Te invitaron a entrar al cotizador de Luxe Essentials. Para arrancar, elegí tu
              propia clave desde el siguiente botón:
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 0 24px 0;">
              <tr>
                <td style="background-color: ${TEAL}; border-radius: 6px;">
                  <a href="${url}" style="display: inline-block; padding: 12px 28px; font-family: Arial, Helvetica, sans-serif; font-size: 15px; font-weight: bold; color: #ffffff; text-decoration: none;">
                    Elegir mi clave
                  </a>
                </td>
              </tr>
            </table>
            <p style="margin: 0 0 8px 0; font-size: 13px; color: ${TEAL};">
              Si el botón no se puede hacer clic, copiá y pegá este enlace en tu navegador:
            </p>
            <p style="margin: 0 0 24px 0; font-size: 13px; word-break: break-all;">
              <a href="${url}" style="color: ${TEAL};">${url}</a>
            </p>
            <p style="margin: 0; font-size: 13px; color: ${TEAL};">
              Este enlace vence en ${HORAS_VIGENCIA} horas. Si no lo pediste vos, podés ignorar
              este correo.
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
`.trim();
}

// Versión en texto plano, sin la cual el correo puntúa peor en los filtros de
// spam — el dominio de envío es nuevo y todavía no tiene reputación.
function cuerpoTexto(p: ParamsInvitacion): string {
  const primerNombre = primerNombreDe(p.nombre);
  const url = enlaceCompleto(p.enlace);

  return [
    `Hola ${primerNombre},`,
    '',
    'Te invitaron a entrar al cotizador de Luxe Essentials. Para arrancar, elegí tu propia',
    'clave desde este enlace:',
    '',
    url,
    '',
    `Este enlace vence en ${HORAS_VIGENCIA} horas. Si no lo pediste vos, podés ignorar este`,
    'correo.',
  ].join('\n');
}

export async function enviarInvitacion(
  p: ParamsInvitacion,
  deps: DepsCorreo,
): Promise<ResultadoCorreo> {
  const { apiKey, remitente, fetchImpl = fetch } = deps;

  if (!apiKey) return { ok: false, error: 'Falta RESEND_API_KEY: no se pudo enviar el correo.' };
  if (!remitente) {
    return { ok: false, error: 'Falta LUXE_CORREO_REMITENTE: no se pudo enviar el correo.' };
  }

  const cuerpo = {
    from: remitente,
    to: [p.para],
    subject: 'Tu acceso al cotizador de Luxe Essentials',
    html: cuerpoHtml(p),
    text: cuerpoTexto(p),
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
