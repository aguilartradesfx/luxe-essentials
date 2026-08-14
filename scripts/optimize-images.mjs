import sharp from 'sharp';
import { readdirSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SRC_DIR = join(process.cwd(), 'IMÁGENES');
const OUT_DIR = join(process.cwd(), 'public', 'images');
const MAX_WIDTH = 2400;
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
