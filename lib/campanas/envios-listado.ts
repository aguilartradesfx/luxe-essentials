import 'server-only';
import { estadoDeEntrega, type EstadoEntrega } from '@/lib/campanas/estado-entrega';

// Los envíos de las campañas UNO POR UNO, para la pantalla «Correos
// enviados» (pedido del dueño: «poder ver todos los emails uno a uno, y
// poder filtrarlos»). Sólo lectura. Mismo tipo laxo `Db` que
// lib/campanas/progreso.ts: alcanza con `.from()` para probarlo con un
// doble en memoria.
export type Db = { from: (tabla: string) => any };

export const TAMANO_PAGINA = 50;

export type FiltrosEnvios = {
  zona?: string;
  campanaId?: string;
  estado?: EstadoEntrega;
  busqueda?: string;
};

// Dónde quedó la página anterior. Cursor por CLAVE, no por posición: el
// orden es (actualizado_at desc, id desc), una clave única y que no cambia
// una vez que el correo salió (el webhook de Resend nunca la toca). Con un
// «saltear N filas» una campaña que sigue mandando correos empujaría filas
// nuevas arriba y la página siguiente repetiría las últimas de la anterior;
// con la clave, cada página arranca exactamente donde terminó la otra.
export type Cursor = { at: string; id: string };

export type EnvioListado = {
  id: string;
  correo: string;
  // `nombre_crm`: el nombre tal cual venía del CRM al armar la campaña, la
  // misma fuente de `{{empresa}}` en las plantillas.
  empresa: string;
  zona: string | null;
  plantilla: string;
  campanaId: string;
  // Cuándo se cerró el intento de envío (`actualizado_at`).
  enviadoAt: string;
  estado: EstadoEntrega;
  // Rebote, fallo o retraso: el motivo que informó Resend. Para `no_salio`,
  // el error de la propia tanda.
  detalle: string | null;
  // Cuándo se supo el último estado de entrega.
  entregaEventoAt: string | null;
};

export type OpcionCampana = { id: string; zona: string | null; plantilla: string; creadoAt: string };

export type PaginaEnvios = {
  envios: EnvioListado[];
  // Cuántos por página: la pantalla lo usa para decir «51–100 de 948».
  tamano: number;
  total: number;
  siguiente: Cursor | null;
  opciones: { zonas: string[]; campanas: OpcionCampana[] };
  // `false` si NINGÚN correo de ninguna campaña recibió todavía un evento
  // de entrega: la pantalla lo avisa, porque «todo sin confirmar» entonces
  // casi seguro es el webhook sin configurar y no un problema de los correos.
  hayConfirmaciones: boolean;
};

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;

export function esUuid(v: unknown): v is string {
  return typeof v === 'string' && RE_UUID.test(v);
}
export function esCursor(v: unknown): v is Cursor {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Cursor).at === 'string' &&
    RE_TIMESTAMP.test((v as Cursor).at) &&
    esUuid((v as Cursor).id)
  );
}

// Un valor entre comillas dentro de un `or(...)` de PostgREST: las comillas
// protegen comas y paréntesis (una empresa llamada «Foo, S.A.»); adentro
// sólo `\` y `"` necesitan escape.
function entreComillas(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// El patrón de `ilike` para «contiene». `%` y `_` del texto de quien busca
// son comodines de SQL: se escapan para que «john_doe» busque un guion bajo
// y no «cualquier carácter». `*` es el comodín de PostgREST: se descarta.
export function patronContiene(texto: string): string {
  const limpio = texto.replace(/\*/g, '').replace(/[\\%_]/g, '\\$&');
  return `*${limpio}*`;
}

export const MAX_BUSQUEDA = 100;

export async function listarEnvios(
  db: Db,
  filtros: FiltrosEnvios,
  cursor: Cursor | null,
  tamano: number = TAMANO_PAGINA,
): Promise<PaginaEnvios> {
  // Dos consultas de apoyo, independientes de la página.
  const apoyo = Promise.all([
    db.from('campanas').select('id, zona, plantilla, creado_at').order('creado_at', { ascending: false }),
    db
      .from('campanas_envios')
      .select('id', { count: 'exact', head: true })
      .in('entrega_estado', ['enviado', 'retrasado', 'entregado', 'rebotado', 'fallido', 'queja']),
  ]);

  // Los filtros del usuario, SIN el cursor: los usan por igual la consulta
  // de la página y la del total. El total no puede salir de la consulta de
  // la página -- esa lleva la condición del cursor, y el «de 948» iría
  // bajando página a página.
  //
  // `!inner`: la zona vive en `campanas`, y filtrar por ella exige que la
  // unión descarte las filas que no coinciden (sin eso PostgREST devolvería
  // el envío igual, con `campanas: null`).
  const conFiltros = (q: any) => {
    // Los 'pendiente' todavía no son un correo enviado: no entran.
    q = q.in('estado', ['enviado', 'error']);
    if (filtros.zona) q = q.eq('campanas.zona', filtros.zona);
    if (filtros.campanaId) q = q.eq('campana_id', filtros.campanaId);

    switch (filtros.estado) {
      case undefined:
        break;
      case 'no_salio':
        q = q.eq('estado', 'error');
        break;
      case 'sin_confirmar':
        q = q.eq('estado', 'enviado').or('entrega_estado.is.null,entrega_estado.eq.enviado');
        break;
      default:
        q = q.eq('estado', 'enviado').eq('entrega_estado', filtros.estado);
    }

    const texto = filtros.busqueda?.trim().slice(0, MAX_BUSQUEDA);
    if (texto) {
      const patron = entreComillas(patronContiene(texto));
      q = q.or(`correo.ilike.${patron},nombre_crm.ilike.${patron}`);
    }
    return q;
  };

  let pedida = conFiltros(
    db
      .from('campanas_envios')
      .select(
        'id, correo, nombre_crm, estado, error, actualizado_at, campana_id, entrega_estado, entrega_evento_at, entrega_detalle, campanas!inner(zona, plantilla)',
      ),
  );
  if (cursor) {
    const at = entreComillas(cursor.at);
    pedida = pedida.or(`actualizado_at.lt.${at},and(actualizado_at.eq.${at},id.lt.${entreComillas(cursor.id)})`);
  }
  const [paginaRes, totalRes] = await Promise.all([
    pedida
      .order('actualizado_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(tamano + 1),
    conFiltros(
      db.from('campanas_envios').select('id, campanas!inner(zona)', { count: 'exact', head: true }),
    ),
  ]);
  const { data, error } = paginaRes;
  if (error) throw new Error(`No se pudo listar los envíos: ${error.message}`);
  if (totalRes.error) throw new Error(`No se pudo contar los envíos: ${totalRes.error.message}`);
  const count = totalRes.count;

  const [campanasRes, confirmadosRes] = await apoyo;
  if (campanasRes.error) throw new Error(`No se pudo listar las campañas: ${campanasRes.error.message}`);
  if (confirmadosRes.error) throw new Error(`No se pudo contar las confirmaciones: ${confirmadosRes.error.message}`);

  const filas = (data ?? []) as any[];
  const hayMas = filas.length > tamano;
  const pagina = hayMas ? filas.slice(0, tamano) : filas;

  const envios: EnvioListado[] = pagina.map((f) => {
    const campana = Array.isArray(f.campanas) ? f.campanas[0] : f.campanas;
    const estado = estadoDeEntrega(f);
    return {
      id: f.id,
      correo: f.correo,
      empresa: f.nombre_crm,
      zona: campana?.zona ?? null,
      plantilla: campana?.plantilla ?? '',
      campanaId: f.campana_id,
      enviadoAt: f.actualizado_at,
      estado,
      detalle: estado === 'no_salio' ? (f.error ?? null) : (f.entrega_detalle ?? null),
      entregaEventoAt: f.entrega_evento_at ?? null,
    };
  });

  const ultimo = pagina[pagina.length - 1];
  const campanas = ((campanasRes.data ?? []) as any[]).map((c) => ({
    id: c.id as string,
    zona: (c.zona ?? null) as string | null,
    plantilla: c.plantilla as string,
    creadoAt: c.creado_at as string,
  }));
  const zonas = [...new Set(campanas.map((c) => c.zona).filter((z): z is string => Boolean(z)))].sort((a, b) =>
    a.localeCompare(b, 'es'),
  );

  return {
    envios,
    tamano,
    total: count ?? 0,
    siguiente: hayMas && ultimo ? { at: ultimo.actualizado_at, id: ultimo.id } : null,
    opciones: { zonas, campanas },
    hayConfirmaciones: (confirmadosRes.count ?? 0) > 0,
  };
}
