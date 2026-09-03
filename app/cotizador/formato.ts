// Formateadores puros compartidos entre las vistas del panel. Sin
// `server-only`: son de cliente — se usan para pintar montos y tasas que ya
// llegaron calculados desde el servidor, no para calcular nada.

// `GRUPOS`/`GrupoDescuento`/`DescuentoPersonalizado` (lib/cotizador/tipos.ts)
// son client-safe a propósito: ese archivo no lleva `import 'server-only'`
// (a diferencia de lib/cotizador/equipo.ts o lib/cotizador/usuarios.ts, cuyos
// tipos SÍ hay que duplicar acá — ver el comentario de `Estado`/`Rol` en
// VistaListado.tsx/Panel.tsx). `VistaListado.tsx` ya importa `LineaEntrada`
// del mismo archivo, así que traer estos tres no cruza ningún límite nuevo.
import type { DescuentoPersonalizado, GrupoDescuento } from '@/lib/cotizador/tipos';
import { GRUPOS } from '@/lib/cotizador/tipos';

// Nombre legible de cada grupo, para un vendedor o un superadmin que no
// tienen por qué conocer las claves internas (`sets-cama`, en vez de "Sets
// de cama"). Un solo lugar para las tres pantallas que necesitan mostrarlo
// (VistaCrear, VistaAprobaciones, VistaListado) — repetirlo en cada una es
// exactamente el tipo de cosa que diverge en silencio la segunda vez que
// alguien agrega un grupo.
export const ETIQUETAS_GRUPO: Record<GrupoDescuento, string> = {
  uniformes: 'Uniformes',
  'sets-cama': 'Sets de cama',
  'fundas-insertos': 'Fundas e insertos',
  toallas: 'Toallas',
  bata: 'Batas',
  almohadas: 'Almohadas',
};

// Texto de una sola línea para leer de un vistazo qué se pidió/aprobó: "20%
// general" o "Toallas 10%, Batas 5%". `familias` puede llegar con alguna
// clave en `undefined` (la forma que permite `Partial<Record<...>>`) —se
// filtra, no se imprime "undefined%".
export function formatearDescuentoPersonalizado(dp: DescuentoPersonalizado): string {
  if ('general' in dp) return `${dp.general}% general`;
  const partes = Object.entries(dp.familias)
    .filter((entrada): entrada is [GrupoDescuento, number] => entrada[1] !== undefined)
    .map(([grupo, pct]) => `${ETIQUETAS_GRUPO[grupo as GrupoDescuento] ?? grupo} ${pct}%`);
  return partes.length > 0 ? partes.join(', ') : 'Sin familias';
}

// Cuánto tiempo pasó desde `iso` hasta ahora, en la unidad más grande que
// tenga sentido — "3 días", "5 horas", "20 min" — para que el superadmin no
// tenga que restar fechas de memoria mirando el listado (diseño: "el
// listado muestra cuánto lleva esperando", sección de riesgos).
export function formatearEspera(iso: string, ahora: Date = new Date()): string {
  const desde = new Date(iso);
  if (Number.isNaN(desde.getTime())) return '—';
  const minutos = Math.max(0, Math.round((ahora.getTime() - desde.getTime()) / 60000));
  if (minutos < 60) return `${minutos} min`;
  const horas = Math.floor(minutos / 60);
  if (horas < 24) return `${horas} hora${horas === 1 ? '' : 's'}`;
  const dias = Math.floor(horas / 24);
  return `${dias} día${dias === 1 ? '' : 's'}`;
}

export { GRUPOS };

// Colones sin decimales, agrupados de a tres. No se usa `toLocaleString`
// porque el separador de miles que trae el runtime de Node para `es-CR`
// varía entre versiones de ICU (a veces un espacio, no un punto), y el
// formato con punto es el que Luxe espera ver.
export function formatearColones(valor: number): string {
  return `₡${Math.round(valor).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}

// Mismo formato que `formatearTasa` en lib/cotizador/ghl.ts, duplicado a
// propósito: esta pantalla no puede importar código del servidor (arrastraría
// `lib/cotizador/escalas.ts` al navegador — ver Tarea 8). `Math.round(tasa *
// 100)` da "IVA 3%" para una tasa reducida de 2.5% — el rótulo miente sobre
// el monto real (que sí es 2.5%). Hasta dos decimales, sin ceros de más: 13
// -> "13", 2.5 -> "2.5".
export function formatearTasa(tasa: number): string {
  return (tasa * 100).toFixed(2).replace(/\.?0+$/, '');
}
