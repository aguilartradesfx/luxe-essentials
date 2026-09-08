import 'server-only';
import { normalizarCorreo } from '@/lib/campanas/baja';

// La tabla de excluidos (`bajas_correo`, migración 0018) y el filtro que la
// bandeja de campañas consulta antes de mandar nada. Este módulo es el único
// lugar del repositorio que escribe en esa tabla -- lo llaman
// app/api/baja/confirmar/route.ts (alguien tocó el botón en /baja) y
// app/api/baja/route.ts (la baja de un clic de RFC 8058) -- y el único que
// la lee para decidir a quién se le puede escribir.

// Duck-typed a propósito, mismo criterio que `ClienteAlmacen` en
// `lib/cotizador/almacen.ts`: alcanza con `.from(tabla)` para poder probar
// este módulo con un doble de Supabase en memoria, sin arrastrar el tipo
// completo de `SupabaseClient` a las pruebas.
export type ClienteBajas = { from: (tabla: string) => any };

// Las dos vías por las que una baja puede llegar -- mismo `check` que la
// columna `via` en la migración 0018. Vive acá y no sólo en el SQL para que
// escribir un tercer valor sea un error de TypeScript en vez de un 23514 de
// Postgres que aparece recién al desplegar.
export const VIAS_BAJA = ['pagina', 'un_clic'] as const;
export type ViaBaja = (typeof VIAS_BAJA)[number];

export type ResultadoRegistrarBaja = { ok: true } | { ok: false; error: string };

// Da de baja un correo. Idempotente por diseño: dos llamadas con el mismo
// correo -- alguien que toca "confirmar" dos veces, o un cliente de correo
// que reintenta el POST de un clic -- nunca revientan ni duplican la fila.
// `ignoreDuplicates: true` con `onConflict: 'correo'` es un
// `ON CONFLICT (correo) DO NOTHING` de verdad, resuelto por Postgres contra
// el `unique` de la columna (migración 0018) -- no una lectura-y-luego-
// escritura de la aplicación, que dejaría una ventana entre las dos mitades
// donde dos peticiones concurrentes con el mismo correo podrían insertar
// las dos. La primera vía que registra una baja es la que queda: una
// segunda llamada con una vía distinta no la pisa (ver el comentario de
// `via` en la migración 0018 sobre para qué sirve esa columna).
export async function registrarBaja(
  correo: string,
  via: ViaBaja,
  db: ClienteBajas,
): Promise<ResultadoRegistrarBaja> {
  const normalizado = normalizarCorreo(correo);
  if (!normalizado) return { ok: false, error: 'Falta el correo.' };

  try {
    const { error } = await db
      .from('bajas_correo')
      .upsert({ correo: normalizado, via }, { onConflict: 'correo', ignoreDuplicates: true });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Símbolo NO exportado: es lo que vuelve `Permitido<T>` un tipo que ningún
// otro módulo puede producir por su cuenta. TypeScript no impide construir
// un objeto con la forma de `T` -- eso es tipado estructural -- pero sí
// impide que ese objeto pase por un tipo que exige una propiedad indexada
// por un símbolo que el módulo llamante no puede ni nombrar. La única forma
// de obtener un valor de este tipo es que esta función lo devuelva -- o un
// `as unknown as Permitido<T>` explícito, que ya no es un descuido sino una
// decisión tomada a la vista de quien lo escribe y de quien lo revisa.
declare const marcaPermitido: unique symbol;
export type Permitido<T> = T & { readonly [marcaPermitido]: true };

// La función que la bandeja de campañas (todavía por construir) tiene que
// usar antes de mandar nada: "¿a quién de esta lista le puedo escribir?".
// Pensada para filtrar de una sola vez -- toma la lista completa de
// destinatarios y devuelve la lista completa de permitidos, no un correo a
// la vez -- porque una campaña se arma para miles de contactos y una
// consulta por destinatario sería lenta y frágil justo ahí.
//
// Diseño recomendado para cuando exista la función de enviar: que reciba
// `Permitido<Contacto>[]` y no `Contacto[]`. Con esa firma, mandar una
// campaña con la lista cruda de contactos -- sin pasar por este filtro --
// deja de ser un descuido posible: no compila. Es la forma de que "nunca
// mandes sin filtrar" no dependa de que quien escriba ese código se acuerde
// de llamar a esta función.
export async function filtrarPermitidosParaCampana<T extends { correo: string }>(
  destinatarios: readonly T[],
  db: ClienteBajas,
): Promise<Permitido<T>[]> {
  if (destinatarios.length === 0) return [];

  // Se trae la tabla de bajas ENTERA, en vez de un `.in('correo', ...)` con
  // los miles de correos de `destinatarios`: la relación de tamaños es al
  // revés de lo que parece. Los excluidos son una lista corta -- con suerte,
  // algunas decenas -- frente a los miles de contactos que se quieren
  // filtrar, y un `.in()` con miles de valores además choca contra el
  // límite de tamaño de la URL que arma el cliente de Supabase. Una sola
  // lectura, un `Set` en memoria, y el filtro no le cuesta más caro a un
  // envío de 3.340 que a uno de 30.
  const { data, error } = await db.from('bajas_correo').select('correo');
  if (error) {
    // Nunca se interpreta un fallo de lectura como "nadie está de baja": si
    // no se pudo confirmar quién está excluido, no hay forma segura de
    // devolver ninguna lista de permitidos -- se lanza, en vez de devolver
    // un array vacío o (peor) la lista completa sin filtrar.
    throw new Error(`No se pudo leer la lista de bajas: ${error.message}`);
  }

  const excluidos = new Set(
    ((data ?? []) as { correo: string }[]).map((fila) => normalizarCorreo(fila.correo)),
  );

  return destinatarios
    .filter((d) => !excluidos.has(normalizarCorreo(d.correo)))
    .map((d) => d as Permitido<T>);
}
