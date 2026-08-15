import sharp from 'sharp';
import { readdirSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SRC_DIR = join(process.cwd(), 'IMÁGENES');
const GEN_DIR = join(process.cwd(), 'IMAGENES-GENERADAS');
const OUT_DIR = join(process.cwd(), 'public', 'images');
const MAX_WIDTH = 2400;
// El hero va a sangre en pantallas anchas: necesita más resolución que una
// foto de catálogo, y por eso lleva su propio límite.
const MAX_WIDTH_HERO = 3200;
const QUALITY = 80;

export const SOURCES = [
  { file: 'Generated Image August 11, 2026 - 4_04PM.jpg', id: 'camisas-columbia' },
  { file: 'Generated Image August 11, 2026 - 4_05PM.jpg', id: 'set-medicos' },
  { file: 'Generated Image August 11, 2026 - 4_07PM.jpg', id: 'camisas-industriales-reflectivo' },
  { file: 'Generated Image August 11, 2026 - 4_08PM.jpg', id: 'playeras-pantalones-industriales' },
  { file: 'Generated Image August 11, 2026 - 4_25PM.jpg', id: 'pantalones-denim-reflectivo' },
  { file: 'Generated Image August 11, 2026 - 4_38PM.jpg', id: 'polos-tejido-plano' },
  { file: 'Generated Image August 11, 2026 - 4_40PM.jpg', id: 'deportivas' },
  { file: 'Generated Image August 11, 2026 - 4_41PM.jpg', id: 'chalecos-corporativos' },
  { file: 'Generated Image August 11, 2026 - 4_42PM.jpg', id: 'chaquetas-ejecutivas' },
  { file: 'Generated Image August 11, 2026 - 4_48PM.jpg', id: 'planta-bordado' },
  { file: 'Generated Image August 11, 2026 - 5_59PM.jpg', id: 'cocina-linea-completa' },
  { file: 'Generated Image August 11, 2026 - 6_07PM.jpg', id: 'cocina-filipinas' },
  { file: 'Generated Image August 13, 2026 - 2_06PM.jpg', id: 'cocina-gorros-pantalones' },
  { file: 'Generated Image August 13, 2026 - 2_08PM.jpg', id: 'corporativo-camisas-pantalones' },
];

// Imágenes generadas con Nano Banana Pro a partir de las fotos reales de
// producto. Viven en su propia carpeta para no mezclarse con los originales
// del cliente, y como aquéllos, no se versionan: sólo su salida optimizada.
export const GENERADAS = [
  { file: 'hero-tela.png', id: 'hero-tela', hero: true },
  { file: 'seccion-telas.png', id: 'seccion-telas' },
  { file: 'seccion-uniformes.png', id: 'seccion-uniformes' },
  { file: 'seccion-hogar.png', id: 'seccion-hogar' },
  { file: 'seccion-bordado.png', id: 'seccion-bordado' },
  { file: 'seccion-muestras.png', id: 'seccion-muestras' },
  // Regeneradas a partir de las capturas del deck del fabricante: se les
  // quitó el marco verde de la presentación y el texto que se había colado.
  { file: 'planta-bodega.png', id: 'planta-bodega' },
  { file: 'planta-confeccion.png', id: 'planta-confeccion' },
  { file: 'planta-corte.png', id: 'planta-corte' },
  { file: 'planta-diseno.png', id: 'planta-diseno' },
  { file: 'planta-bordado.png', id: 'planta-bordado' },
];

const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`;

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const disponibles = new Set(readdirSync(SRC_DIR));
  const faltantes = SOURCES.filter((s) => !disponibles.has(s.file));
  if (faltantes.length > 0) {
    console.error('Faltan archivos de origen:');
    for (const f of faltantes) console.error(`  ${f.file}`);
    process.exit(1);
  }

  let antes = 0;
  let despues = 0;

  for (const { file, id } of SOURCES) {
    const src = join(SRC_DIR, file);
    const out = join(OUT_DIR, `${id}.webp`);

    await sharp(src)
      .rotate()
      .resize({ width: MAX_WIDTH, withoutEnlargement: true })
      .webp({ quality: QUALITY })
      .toFile(out);

    const a = statSync(src).size;
    const d = statSync(out).size;
    antes += a;
    despues += d;
    console.log(`${id.padEnd(36)} ${kb(a).padStart(10)} → ${kb(d).padStart(9)}`);
  }

  for (const { file, id, hero } of GENERADAS) {
    const src = join(GEN_DIR, file);
    if (!existsSync(src)) {
      console.log(`${id.padEnd(36)} (sin origen, se omite)`);
      continue;
    }
    const out = join(OUT_DIR, `${id}.webp`);
    await sharp(src)
      .rotate()
      .resize({ width: hero ? MAX_WIDTH_HERO : MAX_WIDTH, withoutEnlargement: true })
      .webp({ quality: QUALITY })
      .toFile(out);

    const a = statSync(src).size;
    const d = statSync(out).size;
    antes += a;
    despues += d;
    console.log(`${id.padEnd(36)} ${kb(a).padStart(10)} → ${kb(d).padStart(9)}`);
  }

  const ahorro = ((1 - despues / antes) * 100).toFixed(1);
  console.log(`\nTotal ${kb(antes)} → ${kb(despues)} (${ahorro} % menos)`);
}

// pathToFileURL percent-encodes the path (spaces, etc.) the same way
// import.meta.url does; a plain `file://${process.argv[1]}` template
// literal does not, so on paths with spaces (like this repo's) it would
// never match and main() would silently never run.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
