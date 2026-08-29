import 'server-only';

export const BUCKET = 'cotizaciones';

// 90 días: más que la vigencia de 30 de la cotización, con margen para que el
// cliente vuelva a abrir el correo semanas después de haberla recibido.
const SEGUNDOS_FIRMA = 90 * 24 * 60 * 60;

// El mismo tipo laxo que usa lib/agente/estado.ts, por la misma razón: poder
// probar sin red.
export type ClienteAlmacen = { storage: { from: (bucket: string) => any } };

export type ResultadoAlmacen = { ok: true; ruta: string } | { ok: false; error: string };

// La ruta lleva el id de la fila, no sólo el número: el bucket es privado, pero
// una ruta adivinable a partir del correlativo sería una invitación a probar
// COT-2026-0002 y leer la cotización de otro cliente.
function rutaDe(id: string, numero: string): string {
  const anio = new Date().getFullYear();
  return `${anio}/${numero}-${id}.pdf`;
}

export async function guardarPdf(
  p: { id: string; numero: string; pdf: Buffer }, db: ClienteAlmacen,
): Promise<ResultadoAlmacen> {
  const ruta = rutaDe(p.id, p.numero);
  try {
    const { error } = await db.storage.from(BUCKET).upload(ruta, p.pdf, {
      contentType: 'application/pdf',
      upsert: true,
    });
    if (error) return { ok: false, error: `No se pudo guardar el PDF: ${error.message}` };
    return { ok: true, ruta };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function enlaceFirmado(
  ruta: string, db: ClienteAlmacen, segundos: number = SEGUNDOS_FIRMA,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  try {
    const { data, error } = await db.storage.from(BUCKET).createSignedUrl(ruta, segundos);
    if (error || !data?.signedUrl) {
      return { ok: false, error: `No se pudo firmar el enlace: ${error?.message ?? 'sin url'}` };
    }
    return { ok: true, url: data.signedUrl };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
