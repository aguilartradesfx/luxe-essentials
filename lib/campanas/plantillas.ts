import 'server-only';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PLANTILLAS, type PlantillaCampana } from '@/lib/campanas/envio';

// Lee los cuatro .html de lib/campanas/plantillas/ (los originales de Luxe
// -- ver el README de esa carpeta sobre por qué no se tocan) y les extrae
// lo que `crearCampana` necesita: asunto, texto de vista previa, y el html
// completo con los tres marcadores todavía sin resolver. Este módulo SÓLO
// lee y extrae -- no transforma ni "limpia" el HTML. La única edición que
// se les hizo a los archivos fue sacar la coma que quedaba delante de
// `{{nombre}}` en el HTML fuente ("Buenos días, {{nombre}}:" ->
// "Buenos días{{nombre}}:"), para que encajaran con el contrato de
// `marcadorNombre` (lib/campanas/marcadores.ts: el marcador ya trae su
// propia coma cuando corresponde, o queda vacío -- si el HTML también
// pusiera una, el resultado sería "Buenos días, , Ana:" o "Buenos días, :",
// los dos rotos). Esa edición vive en los propios archivos .html, no acá.
//
// Mismo patrón que lib/cotizador/documento.tsx para leer las fuentes del
// PDF desde disco: `node:fs` + `fileURLToPath(import.meta.url)` para
// resolver la ruta relativa a este archivo, sin depender del directorio de
// trabajo desde el que arranque el proceso.
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'plantillas');

const ARCHIVOS: Record<PlantillaCampana, string> = {
  inicial: 'inicial.html',
  seguimiento_1: 'seguimiento_1.html',
  seguimiento_2: 'seguimiento_2.html',
  seguimiento_3: 'seguimiento_3.html',
};

export type PlantillaCargada = {
  plantilla: PlantillaCampana;
  // El <title> literal del archivo -- es el asunto del correo. Los cuatro
  // originales vienen sin tildes en el título a propósito (decisión del
  // autor); se extrae tal cual, sin "corregirlo".
  asunto: string;
  // El contenido del <div> oculto del principio (el preheader / vista
  // previa de bandeja). Incluye la ristra final de `&#8203;&nbsp;` a
  // propósito -- es lo que evita que el cliente de correo rellene la vista
  // previa con el arranque del cuerpo -- así que se conserva tal cual, sin
  // recortarla.
  previewText: string;
  // El html completo, tal cual está en disco: con los tres marcadores
  // ({{nombre}}, {{empresa}}, {{unsubscribe_url}}) sin resolver. Se
  // resuelven recién por destinatario, con `renderizarPlantilla`
  // (lib/campanas/marcadores.ts).
  html: string;
};

function extraerAsunto(html: string, archivo: string): string {
  const m = html.match(/<title>([\s\S]*?)<\/title>/);
  if (!m) throw new Error(`${archivo}: no tiene <title>, no se puede extraer el asunto.`);
  return m[1].trim();
}

// El preheader es siempre el MISMO <div> -- el estilo en línea exacto de
// abajo es idéntico en las cuatro plantillas (es parte del armazón fijo,
// no del texto editable) -- así que se ubica por esa firma en vez de tomar
// "el primer div oculto que aparezca", que sería más frágil si el armazón
// alguna vez suma otro elemento oculto.
const FIRMA_PREHEADER =
  'style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#E9ECF0;opacity:0;"';

function extraerVistaPrevia(html: string, archivo: string): string {
  const inicioEstilo = html.indexOf(FIRMA_PREHEADER);
  if (inicioEstilo === -1) {
    throw new Error(`${archivo}: no tiene el div de vista previa esperado.`);
  }
  const aperturaDiv = html.indexOf('>', inicioEstilo) + 1;
  const cierreDiv = html.indexOf('</div>', aperturaDiv);
  if (aperturaDiv === 0 || cierreDiv === -1) {
    throw new Error(`${archivo}: no se pudo delimitar el div de vista previa.`);
  }
  return html.slice(aperturaDiv, cierreDiv).trim();
}

function cargar(plantilla: PlantillaCampana): PlantillaCargada {
  const archivo = ARCHIVOS[plantilla];
  const html = readFileSync(path.join(DIR, archivo), 'utf8');
  return {
    plantilla,
    asunto: extraerAsunto(html, archivo),
    previewText: extraerVistaPrevia(html, archivo),
    html,
  };
}

// Se cargan una sola vez al importar el módulo -- son archivos estáticos
// del repositorio, no cambian durante la vida del proceso, y son chicos (7
// a 9 KB cada uno): no hay ningún motivo para releerlos del disco en cada
// llamada.
const CARGADAS: Record<PlantillaCampana, PlantillaCargada> = Object.fromEntries(
  PLANTILLAS.map((p) => [p, cargar(p)]),
) as Record<PlantillaCampana, PlantillaCargada>;

// Lo que la pantalla (parte 2) necesita para armar el editor: elegir una
// plantilla y partir de su asunto, su vista previa y su html (con los
// párrafos del cuerpo, que son lo único editable por campaña -- el resto
// del armazón, incluido el bloque destacado y el botón, es fijo por
// plantilla).
export function plantillaCargada(plantilla: PlantillaCampana): PlantillaCargada {
  return CARGADAS[plantilla];
}

export function todasLasPlantillas(): PlantillaCargada[] {
  return PLANTILLAS.map((p) => CARGADAS[p]);
}
