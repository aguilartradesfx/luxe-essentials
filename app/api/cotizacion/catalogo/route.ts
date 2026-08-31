import { NextResponse } from 'next/server';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { CATALOGO } from '@/lib/cotizador/catalogo';
import { csrfDeSesion } from '@/lib/sesion';

export const runtime = 'nodejs';

// Tarea 8: este es el único lugar donde el catálogo completo (con
// `precioLista` y `grupo`, la estructura de márgenes por volumen) toca el
// servidor de cara a la pantalla. Lo que sale de acá hacia el navegador es
// deliberadamente angosto: ni precios ni grupo de descuento, solo lo que el
// vendedor necesita para buscar y elegir un SKU. `/api/cotizacion/previsualizar`
// es quien calcula con el catálogo real, siempre en el servidor.
export async function POST(request: Request) {
  let crudo: unknown;
  try {
    crudo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  // La credencial se revisa antes de tocar el resto del cuerpo. Acá no hay
  // esquema que validar —el cuerpo va vacío—, pero el orden se mantiene igual
  // que en los otros endpoints de este directorio por consistencia. Ruta de
  // solo lectura: no exige el token anti-CSRF, ese requisito es de las que
  // escriben (app/api/cotizacion/route.ts).
  const auth = autenticarPeticion(request, crudo, { requiereCsrf: false });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const skus = CATALOGO.map((sku) => ({ id: sku.id, nombre: sku.nombre, familia: sku.familia }));

  // Ronda de correcciones 1 (Tarea 9, hallazgo crítico): esta es la única
  // sonda que el panel llama para saber si ya hay una sesión viva al montar
  // (Panel.tsx), así que es también el punto más barato para devolverle a
  // quien entra por cookie el token anti-CSRF que le corresponde — sin eso,
  // la única forma de conseguirlo era `/api/cotizacion/entrar`, y guardarlo
  // solo en `sessionStorage` (por pestaña) dejaba la sesión real —la
  // cookie, que dura 30 días y sobrevive a cerrar el navegador— sin forma
  // de recuperar su token en una pestaña nueva o tras reabrir el navegador.
  //
  // Es seguro: `csrfDeSesion` deriva el token de la cookie misma
  // (`HMAC(secreto, "csrf." + valorCookie)`), así que devolvérselo a quien
  // ya la presenta válida no concede nada que esa cookie no demostrara ya.
  // `null` (y por lo tanto ningún campo `csrf` en la respuesta) si la cookie
  // no es válida.
  //
  // `Sec-Fetch-Site: cross-site` es la marca de que quien disparó esta
  // petición no es este sitio: con `SameSite=None` (necesaria para el
  // iframe de GoHighLevel) un sitio ajeno puede disparar la petición con la
  // cookie adjunta sola, aunque hoy no pueda LEER la respuesta —no hay
  // ninguna cabecera `Access-Control-Allow-Origin` en este proyecto, así
  // que la respuesta es opaca para JavaScript de otro origen—. Este chequeo
  // es un endurecimiento barato que no depende de que eso siga siendo
  // cierto para siempre: si alguien agrega CORS a esta ruta por descuido
  // más adelante, sigue sin repartir tokens a un sitio ajeno. Esta ruta
  // NUNCA debe llevar `Access-Control-Allow-Origin`: el día que la lleve,
  // se convierte en un repartidor de tokens anti-CSRF para cualquier sitio
  // que dispare esta petición con la cookie.
  const esCrossSite = request.headers.get('sec-fetch-site') === 'cross-site';
  const csrf = esCrossSite ? null : csrfDeSesion(request);

  // Tarea 5 (usuarios del panel): esta es también la sonda que `Panel.tsx`
  // usa para confirmar, tras `/entrar`, que la cookie de verdad cuajó en el
  // navegador — y la que reconfirma la sesión en cada recarga del iframe. En
  // ambos casos el nombre del vendedor solo llegó una vez, en la respuesta de
  // `/entrar`; sin repetirlo acá, un refresco dejaría al panel con sesión
  // pero sin saber de quién es. `auth.vendedor` sale de la misma cookie que
  // ya se validó arriba — no es un dato nuevo que este endpoint decida exponer
  // de más.
  return NextResponse.json({
    ok: true,
    skus,
    vendedor: auth.vendedor,
    rol: auth.rol,
    ...(csrf ? { csrf } : {}),
  });
}
