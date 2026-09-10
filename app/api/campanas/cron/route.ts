import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/server';
import { ejecutarEnvioProgramado } from '@/lib/campanas/programado';

export const runtime = 'nodejs';

// Mismo criterio que app/api/campanas/enviar/route.ts: una tanda hace un
// rpc de reclamo, hasta cien correos por una sola llamada de LOTE a
// Resend, y el rpc de cierre -- lo mismo puede tardar más que el límite por
// defecto de Vercel (10 s). El envío programado, además, puede tener que
// armar una campaña nueva (paginar GHL entero de una zona) antes de mandar
// nada -- otro motivo para el mismo margen que ya usan /crear y /enviar.
export const maxDuration = 60;

// Vercel Cron dispara esta ruta con GET (no POST, a diferencia de TODA
// otra ruta de app/api/campanas/*) -- así es como Vercel invoca un cron
// job: una petición GET al `path` que declara vercel.json, de lunes a
// viernes a las 15:00 UTC (9:00 de Costa Rica). Nunca la llama un
// navegador con una sesión del panel -- no hay CSRF que pedir acá, ni
// `autenticarPeticion`: la única credencial es el secreto compartido de
// abajo, que Vercel manda solo en la cabecera `Authorization` cuando
// `CRON_SECRET` está configurado en el proyecto.
function autorizacionCronValida(cabecera: string | null, secreto: string): boolean {
  if (!cabecera) return false;
  const recibido = cabecera.startsWith('Bearer ') ? cabecera.slice('Bearer '.length) : cabecera;
  // Comparación en tiempo constante -- mismo criterio, exacto, que
  // `secretoValido` en app/api/ghl/webhook/route.ts. `timingSafeEqual`
  // revienta si los dos buffers no miden lo mismo, así que el largo se
  // compara ANTES, nunca como una optimización opcional.
  const a = Buffer.from(recibido);
  const b = Buffer.from(secreto);
  return a.length === b.length && timingSafeEqual(a, b);
}

// El disparo diario del envío programado (encargo, punto 1 -- "un disparo
// diario por cron de Vercel, no un bucle en el navegador"). Toda la lógica
// de negocio -- a qué zona le toca, cuánto cupo queda hoy, si está pausado
// -- vive en `ejecutarEnvioProgramado` (lib/campanas/programado.ts); esta
// ruta es la cáscara: autoriza el secreto y traduce el resultado.
//
// FALLA CERRADA -- pedido explícito del encargo: sin `CRON_SECRET`
// configurado en el entorno, esta ruta NUNCA manda nada, sin importar qué
// traiga (o no traiga) la cabecera `Authorization`. Sin esta guarda, una
// variable de entorno olvidada en el despliegue dejaría la ruta abierta a
// cualquiera que la encuentre -- "mandá correo real a 3.340 empresas si
// alguien golpea esta URL" es exactamente el modo de fallo que NO puede
// pasar.
export async function GET(request: Request) {
  const secreto = process.env.CRON_SECRET;
  if (!secreto) {
    console.error(
      '[campanas] Falta CRON_SECRET en el entorno: el envio programado no puede correr hasta que se configure.',
    );
    return NextResponse.json({ ok: false, error: 'Falta configurar CRON_SECRET.' }, { status: 500 });
  }

  if (!autorizacionCronValida(request.headers.get('authorization'), secreto)) {
    return NextResponse.json({ ok: false, error: 'No autorizado.' }, { status: 401 });
  }

  const db = supabaseAdmin();
  const deps = {
    resendApiKey: process.env.RESEND_API_KEY ?? '',
    remitente: process.env.LUXE_CORREO_REMITENTE ?? '',
    apiKey: process.env.LUXE_GHL_API_KEY ?? '',
    locationId: process.env.LUXE_GHL_LOCATION_ID ?? '',
  };

  const resultado = await ejecutarEnvioProgramado(db, deps);
  if (!resultado.ok) {
    console.error('[campanas] Fallo el envio programado.', resultado.error);
    return NextResponse.json({ ok: false, error: resultado.error }, { status: 502 });
  }

  // Un renglón por corrida en los logs de Vercel -- es, hoy, la única
  // forma de saber qué hizo el cron sin abrir la base: qué zona, cuántos
  // se mandaron, o por qué no mandó nada (pausado, sin pendientes, cupo
  // agotado).
  console.log('[campanas] Envio programado.', resultado);
  return NextResponse.json(resultado);
}
