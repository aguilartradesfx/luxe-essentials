import type { Datos } from '@/lib/agente/estado';

// El mismo tipo laxo que usa lib/agente/estado.ts, por la misma razón: poder
// probar sin base de datos.
type Db = { from: (tabla: string) => any };

export type ParamsIntencion = { contactId: string; datos: Datos };

// Nunca lanza. Un fallo registrando la intención no debe tumbar el turno del
// agente: al cliente ya se le respondió, y deshacer eso no es posible.
// Devuelve el mensaje de error para que quien llama lo registre.
export async function registrarIntencion(
  p: ParamsIntencion, db: Db,
): Promise<string | undefined> {
  const { datos } = p;

  // Sin correo no hay a quién cotizar; sin producto ni cantidad no hay nada
  // que un vendedor pueda convertir. Se espera a tener las tres.
  if (!datos.email || !datos.producto || !datos.cantidad) return undefined;

  try {
    // Un contacto insistente genera varios turnos con los mismos datos. Sin
    // esta comprobación, la cola se llena de borradores idénticos del mismo
    // cliente y el vendedor no sabe cuál mirar.
    const { data, error } = await db
      .from('cotizaciones')
      .select('id')
      .eq('contact_id', p.contactId)
      .eq('estado', 'borrador')
      .limit(1);
    if (error) return `No se pudo consultar borradores: ${error.message}`;
    if (Array.isArray(data) && data.length > 0) return undefined;

    const { error: errorAlta } = await db.from('cotizaciones').insert({
      origen: 'agente',
      estado: 'borrador',
      contact_id: p.contactId,
      // La intención cruda, tal como la dijo el cliente. No se interpreta:
      // "unos 300" no es 300, y decidirlo es trabajo del vendedor.
      cliente: {
        nombre: datos.nombre,
        email: datos.email,
        telefono: datos.telefono,
        producto: datos.producto,
        cantidadTexto: datos.cantidad,
        ubicacion: datos.ubicacion,
      },
      lineas: [],
      totales: {},
    });
    if (errorAlta) return `No se pudo crear el borrador: ${errorAlta.message}`;
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
