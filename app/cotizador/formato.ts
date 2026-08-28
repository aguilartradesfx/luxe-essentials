// Formateadores puros compartidos entre las vistas del panel. Sin
// `server-only`: son de cliente — se usan para pintar montos y tasas que ya
// llegaron calculados desde el servidor, no para calcular nada.

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
