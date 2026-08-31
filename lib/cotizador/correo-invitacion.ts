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

// Ronda de correcciones 1, hallazgo menor: nada en la firma de
// `enviarInvitacion` obliga a que `enlace` sean 64 caracteres hexadecimales
// (hoy lo es, porque `generarInvitacion` lo genera así — Tarea 1). Se
// codifica igual, como cualquier valor que termina en un query string.
function enlaceCompleto(enlace: string): string {
  return `${urlSitio()}/cotizador/clave?enlace=${encodeURIComponent(enlace)}`;
}

function primerNombreDe(nombre: string): string {
  return nombre.trim().split(/\s+/)[0] ?? nombre;
}

// Ronda de correcciones 1, hallazgo importante: `nombre` lo escribe OTRO
// usuario (quien invita, en Tarea 5), no la persona invitada — así que es
// exactamente el tipo de valor que no se puede interpolar crudo en HTML. Sin
// escapar, un nombre como `</p><a/href=https://sitio-falso.cr>Reclamá</a><p>`
// sale íntegro en el correo: el destinatario recibe un mensaje con
// remitente y dominio legítimos que contiene un enlace de phishing armado
// por quien invitó. Cortar en el primer espacio (`primerNombreDe`) no
// alcanza — un payload sin espacios pasa igual, y de hecho el ejemplo de
// arriba no tiene ninguno.
//
// `lib/cotizador/correo.ts` tiene el mismo patrón sin escapar, pero ahí el
// nombre lo escribe el propio vendedor para su cliente (una fuente que ya es
// dueña de la cotización) — arreglar eso es otra tarea, no ésta.
function escaparHtml(valor: string): string {
  return valor
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Gris/navy suave para el texto de cuerpo (no el `${NAVY}` de marca, que acá
// queda reservado para la franja superior y los títulos — usarlo también en
// párrafos largos lo aplana todo a un solo tono y se pierde la jerarquía).
const TINTA = '#2A2A2A';
const TINTA_SUAVE = '#6B7A85';

function cuerpoHtml(p: ParamsInvitacion): string {
  const primerNombre = escaparHtml(primerNombreDe(p.nombre));
  // La URL completa también se escapa antes de interpolarse: es la
  // combinación de `urlSitio()` (variable de entorno, controlada por quien
  // despliega) y el enlace ya codificado con `encodeURIComponent` arriba, así
  // que hoy no puede traer `&`/`<`/`>`/`"` — pero nada en el tipo de
  // `NEXT_PUBLIC_SITE_URL` lo garantiza, y escaparla es gratis.
  const url = escaparHtml(enlaceCompleto(p.enlace));

  // Ancho híbrido a propósito: la tabla interna pide 600 (`width="600"`,
  // lo único que Outlook de escritorio respeta, sin soporte de `@media`) y
  // el `style="max-width: 600px"` es lo que un cliente moderno (Gmail,
  // Apple Mail, el navegador) usa para angostarla en pantallas chicas —
  // ninguno de los dos estorba al otro. Todo en tablas y estilos en línea:
  // nada de `<style>`, flexbox ni imágenes remotas — un cliente que las
  // bloquea, o Outlook, igual debe leerse bien.
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
            <p style="margin: 0 0 20px 0; font-size: 15px; line-height: 1.6;">Hola ${primerNombre},</p>
            <p style="margin: 0 0 12px 0; font-size: 22px; font-weight: bold; line-height: 1.35; color: ${NAVY};">
              Te invitaron al cotizador de Luxe Essentials
            </p>
            <p style="margin: 0 0 32px 0; font-size: 15px; line-height: 1.6; color: ${TINTA};">
              Para arrancar, elegí tu propia clave desde el siguiente botón. Es un enlace de un
              solo uso, pensado solo para vos.
            </p>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding: 0 40px 36px 40px;">
            <table role="presentation" cellpadding="0" cellspacing="0">
              <tr>
                <td align="center" style="background-color: ${TEAL}; border-radius: 8px;">
                  <a href="${url}" style="display: inline-block; padding: 15px 40px; font-family: Arial, Helvetica, sans-serif; font-size: 16px; font-weight: bold; color: #ffffff; text-decoration: none;">
                    Elegir mi clave
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding: 0 40px 36px 40px; border-top: 1px solid ${BEIGE};">
            <p style="margin: 28px 0 6px 0; font-family: Arial, Helvetica, sans-serif; font-size: 12px; line-height: 1.6; color: ${TINTA_SUAVE};">
              Si el botón no se puede hacer clic, copiá y pegá este enlace en tu navegador:
            </p>
            <p style="margin: 0; font-family: Arial, Helvetica, sans-serif; font-size: 12px; line-height: 1.6; word-break: break-all;">
              <a href="${url}" style="color: ${TEAL};">${url}</a>
            </p>
          </td>
        </tr>
        <tr>
          <td style="background-color: ${BEIGE}; padding: 20px 40px; border-radius: 0 0 12px 12px;">
            <p style="margin: 0; font-family: Arial, Helvetica, sans-serif; font-size: 12px; line-height: 1.6; color: ${TINTA_SUAVE};">
              Este enlace vence en ${HORAS_VIGENCIA} horas. Si no lo pediste vos, podés ignorar este
              correo — tu clave actual sigue siendo la misma.
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
    'LUXE ESSENTIALS',
    '',
    `Hola ${primerNombre},`,
    '',
    'Te invitaron al cotizador de Luxe Essentials. Para arrancar, elegí tu propia clave',
    'desde este enlace de un solo uso:',
    '',
    url,
    '',
    `Este enlace vence en ${HORAS_VIGENCIA} horas. Si no lo pediste vos, podés ignorar este`,
    'correo — tu clave actual sigue siendo la misma.',
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
