import 'server-only';

// Comprobacion de origen para rutas publicas sin autenticacion (I9,
// revision-final-2.md: /api/lead no tiene clave ni cookie que revisar --
// es el formulario publico del sitio, y tiene que seguir siendolo).
//
// Compara el host de la cabecera `Origin` contra el host `Host` de esta
// MISMA peticion -- no contra un dominio fijo tipo `NEXT_PUBLIC_SITE_URL`.
// Comparar contra el host real evita que esto se rompa en un deploy de
// preview de Vercel (cada uno tiene su propio subdominio) sin necesitar
// una lista de dominios permitidos que alguien tenga que mantener al dia.
//
// Solo rechaza cuando `Origin` VIENE y no calza -- nunca por su ausencia.
// Los navegadores mandan `Origin` en toda peticion fetch/XHR que no sea
// GET/HEAD de navegacion, asi que el envio real del formulario (un POST
// con `Content-Type: application/json` desde components/QuoteForm.tsx)
// siempre la trae. Lo que no la manda es tipico de scripts sencillos
// (curl, la mayoria de los clientes HTTP de una linea) -- exigirla
// bloquearia justo al bot mas simple mientras que los que la copian del
// sitio real la pasan igual; no vale la pena romper ningun cliente
// legitimo por esa ganancia marginal.
export function origenValido(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;

  let origenHost: string;
  try {
    origenHost = new URL(origin).host;
  } catch {
    // Un `Origin` que ni siquiera es una URL valida no es de un navegador
    // real: mejor rechazar que confiar en un valor roto.
    return false;
  }

  const destinoHost = request.headers.get('host');
  return origenHost === destinoHost;
}
