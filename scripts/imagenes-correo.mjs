import sharp from 'sharp';
import { mkdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Genera las imagenes de producto que usan las plantillas de campana
// (lib/campanas/plantillas/*.html). Existen aparte de `npm run images`
// porque resuelven un problema distinto: ese script sirve al SITIO, que
// acepta WebP -- esto sirve al CORREO, y Outlook para Windows no sabe
// pintar WebP (no se ve una imagen rota: se ve un hueco). La fuente es la
// MISMA foto ya optimizada en public/images/<id>.webp -- no se vuelve a
// tocar el original de IMAGENES-GENERADAS/ -- y la salida es JPEG, mas
// chica que el tamano del sitio porque en el correo la imagen va a un
// ancho de columna fijo (512 px, el ancho de contenido de las cuatro
// plantillas: 600 menos 44 px de margen a cada lado), no a pantalla
// completa.
const SRC_DIR = join(process.cwd(), 'public', 'images');
const OUT_DIR = join(process.cwd(), 'public', 'images', 'correo');

// 512x288 = 16:9. Dos de las tres fuentes ya vienen horizontales en
// ~2400x1792 (4:3, ver scripts/optimize-images.mjs), asi que el recorte de
// `cover` final es moderado y `attention` (el area mas "interesante" segun
// sharp) elige bien sola. La tercera (seccion-uniformes) es vertical y
// necesita un recorte manual antes de ese paso -- ver `crop` en
// ASIGNACIONES.
const WIDTH = 512;
const HEIGHT = 288;
const QUALITY = 74;

// Que imagen le toca a cada plantilla, y por que -- el criterio comercial
// va en el reporte de la tarea, no aca.
export const ASIGNACIONES = [
  {
    id: 'seccion-uniformes',
    plantilla: 'inicial',
    // seccion-uniformes.png es retrato (1792x2400): las tres prendas
    // (filipina, camisa, delantal) cuelgan en el tercio inferior, con
    // pared vacia arriba. Sin recorte previo, `cover` a 512x288 (16:9)
    // reduciria por ancho y dejaria una franja de ~384 px de alto por
    // recortar -- position:'attention' podria centrarse en la pared en vez
    // de en la ropa, y aun acertando, en un correo de 600 px de ancho la
    // pieza entera mediria unos 800 px de alto: se comeria la primera
    // pantalla completa.
    // Recorte manual: 1792x1344 (4:3, la misma proporcion que las otras
    // dos fuentes), alineado al borde inferior (top=2400-1344=1056) para
    // quedarse con las tres prendas colgadas y descartar la pared vacia de
    // arriba. Los valores salen de inspeccionar la imagen a ojo, no de un
    // calculo generico -- si se regenera el PNG de origen, hay que
    // revisarlos de nuevo.
    crop: { left: 0, top: 1056, width: 1792, height: 1344 },
  },
  { id: 'seccion-telas', plantilla: 'seguimiento_1' },
  { id: 'seccion-bordado', plantilla: 'seguimiento_2' },
  // seguimiento_3 (la de cierre) no lleva imagen a proposito, igual que no
  // lleva boton -- ver el comentario en su propio .html.
];

const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`;

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  let antes = 0;
  let despues = 0;

  for (const { id, crop } of ASIGNACIONES) {
    const src = join(SRC_DIR, `${id}.webp`);
    if (!existsSync(src)) {
      console.error(`falta el origen: ${src}`);
      process.exit(1);
    }
    const out = join(OUT_DIR, `${id}.jpg`);

    let pipeline = sharp(src);
    if (crop) pipeline = pipeline.extract(crop);

    await pipeline
      .resize({ width: WIDTH, height: HEIGHT, fit: 'cover', position: 'attention' })
      // El JPEG no tiene canal alfa -- si el WebP de origen trajera
      // transparencia, sharp la volveria negro sin este flatten. Ninguna
      // de las tres fuentes la trae, pero dejarlo puesto es gratis y evita
      // sorpresas si algun dia se suma una que si.
      .flatten({ background: '#FFFFFF' })
      .jpeg({ quality: QUALITY, mozjpeg: true })
      .toFile(out);

    const a = statSync(src).size;
    const d = statSync(out).size;
    antes += a;
    despues += d;
    console.log(`${id.padEnd(32)} ${kb(a).padStart(10)} (webp sitio) → ${kb(d).padStart(9)} (jpg correo)`);
  }

  console.log(`\nTotal generado: ${kb(despues)} (${ASIGNACIONES.length} imagenes, ${WIDTH}x${HEIGHT})`);
}

// Mismo motivo que en scripts/optimize-images.mjs: pathToFileURL
// percent-encodea la ruta (hay espacios en el path de este repo) igual que
// import.meta.url: una comparacion contra `file://${argv[1]}` sin encodear
// nunca matchea y main() no correria nunca.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
