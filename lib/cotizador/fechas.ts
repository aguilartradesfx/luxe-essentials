// Fecha en palabras, con los nombres de mes que se usan en Costa Rica —
// compartido por los dos documentos que ve el cliente: el PDF
// (`documento.tsx`) y el correo (`correo.ts`).
//
// OJO, no "simplificar" esto de vuelta a `Intl.DateTimeFormat('es-CR', {
// month: 'long' })`: ese formateador da "septiembre", nunca "setiembre".
// No es un bug nuestro — es que CLDR (la base de datos de locales que usa
// ICU/Intl en Node) sólo tiene la forma "septiembre" para es-CR, y no existe
// un locale que devuelva la forma corriente en el país. Por eso los nombres
// de mes van escritos a mano acá abajo, y la fecha se arma con
// `Intl.DateTimeFormat` sólo para extraer día/mes/año ya ajustados al huso
// horario de Costa Rica (mismo motivo que `FORMATEADOR_FECHA_CR` en
// `lib/cotizador/ghl.ts`: el servidor corre en UTC, así que sin huso horario
// explícito una cotización armada de noche hora tica puede imprimir el día
// siguiente).
import 'server-only';

const MESES_CR = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'setiembre', 'octubre', 'noviembre', 'diciembre',
] as const;

// Sólo para extraer las partes numéricas ya resueltas al huso horario de
// Costa Rica; el nombre del mes nunca sale de acá.
const FORMATEADOR_PARTES_CR = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Costa_Rica',
  day: 'numeric',
  month: 'numeric',
  year: 'numeric',
});

function partesCR(fecha: Date): { dia: number; mes: number; anio: number } {
  const partes = FORMATEADOR_PARTES_CR.formatToParts(fecha);
  const numero = (tipo: string) => Number(partes.find((p) => p.type === tipo)?.value);
  return { dia: numero('day'), mes: numero('month'), anio: numero('year') };
}

// "26 de setiembre de 2026", en huso horario de Costa Rica.
export function formatearFechaLargaCR(fecha: Date): string {
  const { dia, mes, anio } = partesCR(fecha);
  return `${dia} de ${MESES_CR[mes - 1]} de ${anio}`;
}
