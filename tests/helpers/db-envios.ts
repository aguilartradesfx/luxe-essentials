// Un doble en memoria de las consultas que hace lib/campanas/envios-listado.ts,
// que interpreta los filtros de PostgREST (eq, in, or con and anidado, is,
// lt, ilike, order, limit, count) como lo hace la base de verdad. Se verificó
// contra producción, sólo lectura: mismas cuentas que un SQL escrito a mano
// (ver el reporte). Si el doble fuera más permisivo que la base, estas
// pruebas aprobarían filtros que en producción no filtran.

export type Envio = {
  id: string;
  campana_id: string;
  correo: string;
  nombre_crm: string;
  estado: 'pendiente' | 'enviado' | 'error';
  error?: string | null;
  actualizado_at: string | null;
  entrega_estado?: string | null;
  entrega_evento_at?: string | null;
  entrega_detalle?: string | null;
};
export type Campana = { id: string; zona: string | null; plantilla: string; creado_at: string };

export type Datos = { envios: Envio[]; campanas: Campana[] };

// "a,b,and(c,d)" -> ["a","b","and(c,d)"], respetando comillas y paréntesis.
function partirTop(s: string): string[] {
  const out: string[] = [];
  let prof = 0;
  let comillas = false;
  let actual = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (comillas && ch === '\\') {
      actual += ch + s[++i];
      continue;
    }
    if (ch === '"') comillas = !comillas;
    if (!comillas && ch === '(') prof++;
    if (!comillas && ch === ')') prof--;
    if (!comillas && prof === 0 && ch === ',') {
      out.push(actual);
      actual = '';
      continue;
    }
    actual += ch;
  }
  if (actual) out.push(actual);
  return out;
}

function desenmarcar(v: string): string {
  if (!v.startsWith('"')) return v;
  return v.slice(1, -1).replace(/\\(["\\])/g, '$1');
}

// `*` -> comodín de PostgREST; luego el patrón LIKE de SQL: `\x` literal,
// `%` y `_` comodines.
function ilike(valor: string | null | undefined, patron: string): boolean {
  if (valor == null) return false;
  const sql = patron.replace(/\*/g, '%');
  let re = '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === '\\') re += sql[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else if (ch === '%') re += '[\\s\\S]*';
    else if (ch === '_') re += '[\\s\\S]';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i').test(valor);
}

function evaluar(item: string, fila: any): boolean {
  if (item.startsWith('and(')) {
    return partirTop(item.slice(4, -1)).every((i) => evaluar(i, fila));
  }
  const m = /^([a-z_]+)\.(is|eq|lt|ilike)\.(.*)$/s.exec(item);
  if (!m) throw new Error(`filtro no soportado por el doble: ${item}`);
  const [, col, op, crudo] = m;
  const v = fila[col];
  if (op === 'is') {
    if (crudo !== 'null') throw new Error('is sólo soporta null');
    return v === null || v === undefined;
  }
  const valor = desenmarcar(crudo);
  if (op === 'eq') return v === valor;
  if (op === 'lt') return v != null && v < valor;
  return ilike(v, valor);
}

function leer(fila: any, col: string): unknown {
  if (col.includes('.')) {
    const [rel, c] = col.split('.');
    return fila[rel]?.[c];
  }
  return fila[col];
}

export function crearDb(datos: Datos, registro?: { consultas: string[] }) {
  function nodoEnvios() {
    const conds: ((f: any) => boolean)[] = [];
    const orden: { col: string; asc: boolean }[] = [];
    let limite = Infinity;
    let conConteo = false;
    let soloConteo = false;
    let inner = false;
    const nodo: any = {
      select(cols: string, opc?: { count?: string; head?: boolean }) {
        conConteo = opc?.count === 'exact';
        soloConteo = Boolean(opc?.head);
        inner = cols.includes('campanas!inner');
        return nodo;
      },
      eq(c: string, v: unknown) {
        conds.push((f) => leer(f, c) === v);
        return nodo;
      },
      in(c: string, vs: unknown[]) {
        conds.push((f) => vs.includes(leer(f, c)));
        return nodo;
      },
      or(s: string) {
        registro?.consultas.push(`or:${s}`);
        const items = partirTop(s);
        conds.push((f) => items.some((i) => evaluar(i, f)));
        return nodo;
      },
      order(col: string, { ascending }: { ascending: boolean }) {
        orden.push({ col, asc: ascending });
        return nodo;
      },
      limit(n: number) {
        limite = n;
        return nodo;
      },
      then(resolve: any, reject: any) {
        return (async () => {
          let filas = datos.envios.map((e) => ({
            ...e,
            campanas: datos.campanas.find((c) => c.id === e.campana_id) ?? null,
          }));
          if (inner) filas = filas.filter((f) => f.campanas);
          filas = filas.filter((f) => conds.every((c) => c(f)));
          const total = filas.length;
          if (soloConteo) return { data: null, count: total, error: null };
          filas.sort((a: any, b: any) => {
            for (const { col, asc } of orden) {
              if (a[col] === b[col]) continue;
              const r = a[col] < b[col] ? -1 : 1;
              return asc ? r : -r;
            }
            return 0;
          });
          return { data: filas.slice(0, limite), count: conConteo ? total : null, error: null };
        })().then(resolve, reject);
      },
    };
    return nodo;
  }
  function nodoCampanas() {
    const nodo: any = {
      select() {
        return nodo;
      },
      order(col: string, { ascending }: { ascending: boolean }) {
        return (async () => ({
          data: [...datos.campanas].sort((a: any, b: any) => (a[col] < b[col] ? -1 : 1) * (ascending ? 1 : -1)),
          error: null,
        }))();
      },
    };
    return nodo;
  }
  return {
    from(tabla: string) {
      if (tabla === 'campanas_envios') return nodoEnvios();
      if (tabla === 'campanas') return nodoCampanas();
      throw new Error(`tabla no mockeada: ${tabla}`);
    },
  };
}

// Atajo para armar filas.
let contador = 0;
export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}
export function envio(parcial: Partial<Envio> & { campana_id: string }): Envio {
  contador++;
  return {
    id: uuid(contador),
    correo: `persona${contador}@ejemplo.cr`,
    nombre_crm: `Empresa ${contador}`,
    estado: 'enviado',
    error: null,
    actualizado_at: `2026-09-20T15:00:${String(contador % 60).padStart(2, '0')}.123456+00:00`,
    entrega_estado: null,
    ...parcial,
  };
}
