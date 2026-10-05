// Cuántos correos por página en «Correos enviados»: el navegador sólo puede
// elegir entre estos (pedido del dueño; 10 por omisión). Vive aparte de
// envios-listado.ts porque lo comparten la pantalla y el servidor, y ese
// módulo es sólo de servidor. El valor que llegue de afuera se valida contra
// la lista con `esTamanoPagina`; nunca se usa un número crudo como límite de
// la consulta.
export const TAMANOS_PAGINA = [10, 20, 50, 100] as const;
export type TamanoPagina = (typeof TAMANOS_PAGINA)[number];
export const TAMANO_PAGINA: TamanoPagina = 10;

export function esTamanoPagina(v: unknown): v is TamanoPagina {
  return typeof v === 'number' && (TAMANOS_PAGINA as readonly number[]).includes(v);
}
