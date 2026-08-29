import { NextResponse } from 'next/server';
import { cookieDeCierre } from '@/lib/sesion';

export const runtime = 'nodejs';

// Revisión final, Importante 3: hasta acá no había forma de salir del panel ni
// de cambiar de usuario. En una computadora compartida —la recepción, la
// oficina— el segundo vendedor no tenía cómo dejar de ser el primero, y sus
// cotizaciones quedaban firmadas con el nombre equivocado de forma permanente
// e indistinguible. Esta ruta caduca la cookie con los mismos atributos con
// que se emitió (ver `cookieDeCierre` en lib/sesion.ts: sin `Path`, `Secure`,
// `SameSite=None` y `Partitioned` idénticos, el navegador no la reemplaza).
//
// No exige nada para entrar —ni sesión válida ni token anti-CSRF— y es
// deliberado: lo único que puede hacer quien la llame es quedarse sin su
// propia sesión. El peor abuso posible es que un sitio ajeno haga que un
// vendedor tenga que volver a escribir su clave, que es molesto y no es un
// riesgo; exigir el token, en cambio, dejaría sin salida a quien perdió el
// token pero conserva la cookie — exactamente la persona que más necesita
// salir.
export async function POST() {
  const respuesta = NextResponse.json({ ok: true });
  respuesta.headers.set('Set-Cookie', cookieDeCierre());
  return respuesta;
}
