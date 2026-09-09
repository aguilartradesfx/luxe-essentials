import 'server-only';
import type { PlantillaCampana } from '@/lib/campanas/envio';

// Cuánto lleva una campaña, para la pantalla (parte 2): "de dónde retomar"
// y "cuándo terminó". El registro por destinatario (`campanas_envios`,
// migración 0019) ya existe del lado del servidor desde que se creó la
// campaña -- este módulo sólo lo cuenta, nunca escribe nada.
//
// Mismo tipo laxo que `ClienteCampanas` en lib/campanas/envio.ts: alcanza
// con `.from()` para poder probar este módulo con un doble de Supabase en
// memoria.
export type Db = { from: (tabla: string) => any };

export type ConteoEnvios = {
  total: number;
  enviados: number;
  fallidos: number;
  pendientes: number;
};

const ESTADOS_CONTABLES = ['enviado', 'error', 'pendiente'] as const;

// Cuenta por `head: true` -- pide un NÚMERO, no las filas -- a propósito:
// una campaña de 3.340 destinatarios no cabe en una sola página de
// PostgREST (el límite por defecto son 1.000 filas), así que traer la
// columna `estado` entera y contarla en JavaScript habría dado un total
// truncado y silenciosamente incorrecto para cualquier campaña grande. Un
// conteo por `head: true` no tiene ese límite: nunca viaja una fila.
async function contar(
  db: Db,
  campanaId: string,
  estado?: (typeof ESTADOS_CONTABLES)[number],
): Promise<number> {
  let consulta = db.from('campanas_envios').select('id', { count: 'exact', head: true }).eq('campana_id', campanaId);
  if (estado) consulta = consulta.eq('estado', estado);
  const { count, error } = await consulta;
  if (error) throw new Error(`No se pudo contar los envíos de la campaña: ${error.message}`);
  return count ?? 0;
}

// Las cuatro cuentas de una campaña, en una sola llamada. `total` es la
// suma de los tres estados -- se pide aparte (sin filtrar por `estado`) en
// vez de sumar los otros tres en JavaScript, para que un quinto estado que
// alguien agregue el día de mañana (una migración que suma 'cancelado', por
// ejemplo) no deje `total` mintiendo por descuido: si ese día nadie
// actualiza `ESTADOS_CONTABLES` acá, `total` seguiría siendo la cuenta real
// de la tabla, aunque `enviados + fallidos + pendientes` ya no la explique
// entera -- una discrepancia visible en la pantalla, no un número
// silenciosamente mal sumado.
export async function progresoCampana(db: Db, campanaId: string): Promise<ConteoEnvios> {
  const [total, enviados, fallidos, pendientes] = await Promise.all([
    contar(db, campanaId),
    contar(db, campanaId, 'enviado'),
    contar(db, campanaId, 'error'),
    contar(db, campanaId, 'pendiente'),
  ]);
  return { total, enviados, fallidos, pendientes };
}

export type FilaCampana = {
  id: string;
  plantilla: PlantillaCampana;
  asunto: string;
  creadoPor: string;
  creadoAt: string;
  progreso: ConteoEnvios;
  // `null` mientras la campaña sigue activa. Cuándo y quién la canceló
  // (punto 1 del encargo) -- lo que la pantalla de historial necesita para
  // distinguir "interrumpida mientras tanto" (retomable) de "cancelada a
  // propósito" (no retomable, y el resto se queda 'pendiente' para
  // siempre -- ver el comentario grande de la migración 0020).
  canceladaAt: string | null;
  canceladaPor: string | null;
};

type FilaCampanaCruda = {
  id: string;
  plantilla: PlantillaCampana;
  asunto: string;
  creado_por: string;
  creado_at: string;
  cancelada_at: string | null;
  cancelada_por: string | null;
};

// El historial de campañas para la pantalla: más reciente primero, cada una
// con su progreso -- es lo que permite "retomar una campaña interrumpida"
// sin depender de que nadie se haya anotado el id en ningún lado (Panel no
// guarda ese id en ninguna parte que sobreviva a cerrar la pestaña; este
// listado es la única forma de recuperarlo).
export async function listarCampanas(db: Db): Promise<FilaCampana[]> {
  const { data, error } = await db
    .from('campanas')
    .select('id, plantilla, asunto, creado_por, creado_at, cancelada_at, cancelada_por')
    .order('creado_at', { ascending: false });
  if (error) throw new Error(`No se pudo listar las campañas: ${error.message}`);

  const filas = (data ?? []) as FilaCampanaCruda[];
  return Promise.all(
    filas.map(async (fila) => ({
      id: fila.id,
      plantilla: fila.plantilla,
      asunto: fila.asunto,
      creadoPor: fila.creado_por,
      creadoAt: fila.creado_at,
      progreso: await progresoCampana(db, fila.id),
      canceladaAt: fila.cancelada_at ?? null,
      canceladaPor: fila.cancelada_por ?? null,
    })),
  );
}
