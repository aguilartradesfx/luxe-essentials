# Luxe Essentials — Landing Fase 1 — Plan de Implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publicar en Vercel una landing B2B de una sola página para Luxe Essentials que capture cotizaciones en Supabase y las sincronice a GoHighLevel.

**Architecture:** Next.js con App Router. Todas las secciones son componentes de servidor sin estado que leen su texto de `content/copy.ts` y sus imágenes de `content/media.ts`. El único componente cliente es el formulario. El envío pasa por un route handler que escribe en Supabase antes de llamar a GHL, de modo que un fallo de GHL nunca pierde el lead. El aspecto de vidrio lo produce un solo componente con dos variantes.

**Tech Stack:** Next.js 16.3.1, React 19.2.8, TypeScript, Tailwind CSS 4.3.3, Supabase (`@supabase/supabase-js` 2.112.3), Zod 4.4.3, sharp 0.35.3, Vitest 4.1.10 + Testing Library. Node 24.14.0.

**Spec:** `docs/superpowers/specs/2026-08-13-luxe-landing-fase1-design.md`

## Global Constraints

- **Idioma:** todo el texto de cara al usuario en español. Ninguna cadena visible se escribe inline en un componente; todas viven en `content/copy.ts`.
- **Paleta, sin alterar:** navy `#2F4156`, teal `#567C8D`, sky `#C8D9E6`, beige `#F5EFEB`, white `#FFFFFF`. Fondo base derivado `--bg-deep` `#1A2634`.
- **Botón primario:** relleno beige con texto navy. Nunca relleno teal con texto claro (3.9:1, reprueba AA).
- **Contraste mínimo:** AA. Beige sobre navy ~8.3:1, sky sobre navy ~6.3:1.
- **Texto nunca sobre blur puro.** Siempre dentro de una capa con relleno.
- **Prefijo `LUXE_` en las variables de GHL.** `LUXE_GHL_API_KEY` y `LUXE_GHL_LOCATION_ID`. No renombrar: el shell del usuario exporta un `GHL_LOCATION_ID` global que las pisaría.
- **Secretos sólo en servidor.** `SUPABASE_SERVICE_ROLE_KEY`, `LUXE_GHL_API_KEY` y `LUXE_GHL_LOCATION_ID` no se importan nunca desde un componente cliente ni llevan prefijo `NEXT_PUBLIC_`.
- **`.env.local` y `IMÁGENES/` no se versionan.** Ya están en `.gitignore`.
- **Sin peticiones a dominios externos** en tiempo de render: fuentes self-hosted vía `next/font`, cero servicios de placeholder.
- **Sin precios en el sitio.** El catálogo BDE es lista de distribuidor y cambia.
- **No usar el CLI de Vercel sin `--token` explícito.** La sesión local del CLI apunta a otra cuenta.

---

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `app/layout.tsx` | Fuentes, metadata, fondo global |
| `app/page.tsx` | Composición de secciones |
| `app/globals.css` | Tokens de marca en `@theme`, estilos base |
| `app/api/lead/route.ts` | Recepción del formulario, sólo servidor |
| `components/ui/GlassCard.tsx` | Superficie de vidrio, variantes `dark` y `plate` |
| `components/ui/Figure.tsx` | Imagen del manifest o marcador si está pendiente |
| `components/ui/Button.tsx` | Botón primario y secundario |
| `components/background/AuroraBackground.tsx` | Manchas desenfocadas del fondo |
| `components/sections/*.tsx` | Una por sección de la página |
| `components/QuoteForm.tsx` | Único componente cliente |
| `content/copy.ts` | Todo el texto visible |
| `content/media.ts` | Manifest de imágenes |
| `lib/validation.ts` | Esquema Zod del formulario |
| `lib/ghl.ts` | Cliente de GoHighLevel |
| `lib/supabase/server.ts` | Cliente con service role |
| `scripts/optimize-images.mjs` | JPEG originales → WebP en `public/images/` |
| `scripts/db.mjs` | Aplicación de migraciones SQL |
| `scripts/ghl-discover.mjs` | Descubre versión de API, pipelines y campos |
| `supabase/migrations/0001_leads.sql` | Tabla `leads` |

---

## Task 1: Andamiaje del proyecto y tooling de pruebas

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `vitest.config.ts`, `vitest.setup.ts`, `app/globals.css`, `app/layout.tsx`, `app/page.tsx`
- Test: `tests/smoke.test.tsx`

**Interfaces:**
- Consumes: nada.
- Produces: alias `@/*` hacia la raíz del proyecto; script `npm test` (Vitest); tokens CSS `--color-navy`, `--color-teal`, `--color-sky`, `--color-beige`, `--color-bg-deep`, `--glass-fill`, `--plate-fill`, `--glass-border`; fuentes exportadas por `app/layout.tsx` como variables CSS `--font-display` y `--font-sans`.

- [ ] **Step 1: Crear el proyecto**

Los materiales de origen (PDFs, `LOGO.svg`, `IMÁGENES/`, `docs/`) ya están en la raíz. `create-next-app` exige directorio vacío, así que se inicializa en su lugar:

```bash
npm init -y
npm pkg set name="luxe-essentials" private=true type="module"
npm i next@16.3.1 react@19.2.8 react-dom@19.2.8 @supabase/supabase-js@2.112.3 zod@4.4.3
npm i -D typescript@5 @types/node @types/react @types/react-dom \
  tailwindcss@4.3.3 @tailwindcss/postcss@4.3.3 \
  vitest@4.1.10 @vitejs/plugin-react@6.0.5 jsdom@30.0.1 \
  @testing-library/react@16.3.2 @testing-library/jest-dom@6 \
  sharp@0.35.3 pg@8 dotenv@17
npm pkg set scripts.dev="next dev" scripts.build="next build" scripts.start="next start" scripts.test="vitest run" scripts.images="node scripts/optimize-images.mjs"
```

- [ ] **Step 2: Configuración base**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "ES2022"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

`postcss.config.mjs`:

```js
export default { plugins: { '@tailwindcss/postcss': {} } };
```

`next.config.ts`:

```ts
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  images: { formats: ['image/avif', 'image/webp'] },
};

export default nextConfig;
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./', import.meta.url)) },
  },
});
```

`vitest.setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 3: Tokens de marca**

`app/globals.css`. Los valores vienen del spec §4.1 y no se alteran:

```css
@import "tailwindcss";

@theme {
  --color-navy: #2F4156;
  --color-teal: #567C8D;
  --color-sky: #C8D9E6;
  --color-beige: #F5EFEB;
  --color-bg-deep: #1A2634;

  --font-display: var(--font-playfair), ui-serif, Georgia, serif;
  --font-sans: var(--font-inter), ui-sans-serif, system-ui, sans-serif;
}

:root {
  --glass-fill: rgba(255, 255, 255, 0.08);
  --plate-fill: rgba(245, 239, 235, 0.92);
  --glass-border: rgba(255, 255, 255, 0.15);
  --glass-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
}

html {
  scroll-behavior: smooth;
}

body {
  background-color: var(--color-bg-deep);
  color: var(--color-beige);
  font-family: var(--font-sans);
  -webkit-font-smoothing: antialiased;
}

:focus-visible {
  outline: 2px solid var(--color-sky);
  outline-offset: 3px;
}

@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

- [ ] **Step 4: Escribir la prueba de humo (falla)**

`tests/smoke.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import Home from '@/app/page';

describe('página principal', () => {
  it('presenta la marca en un encabezado de primer nivel', () => {
    render(<Home />);
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1).toBeInTheDocument();
  });

  it('tiene exactamente un h1', () => {
    const { container } = render(<Home />);
    expect(container.querySelectorAll('h1')).toHaveLength(1);
  });
});
```

- [ ] **Step 5: Ejecutar la prueba y verificar que falla**

Run: `npm test`
Expected: FAIL — no existe `app/page.tsx`.

- [ ] **Step 6: Implementar layout y página mínima**

`app/layout.tsx`:

```tsx
import type { Metadata } from 'next';
import { Playfair_Display, Inter } from 'next/font/google';
import './globals.css';

const playfair = Playfair_Display({
  subsets: ['latin'],
  variable: '--font-playfair',
  display: 'swap',
});

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Luxe Essentials',
  description: 'Manufactura textil con planta propia en Guatemala.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={`${playfair.variable} ${inter.variable}`}>
      <body>{children}</body>
    </html>
  );
}
```

`app/page.tsx`:

```tsx
export default function Home() {
  return (
    <main>
      <h1 className="font-[family-name:var(--font-display)] text-4xl">Luxe Essentials</h1>
    </main>
  );
}
```

- [ ] **Step 7: Ejecutar la prueba y verificar que pasa**

Run: `npm test`
Expected: PASS, 2 pruebas.

- [ ] **Step 8: Verificar que el proyecto compila**

Run: `npm run build`
Expected: compilación exitosa.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: andamiaje Next.js con tokens de marca y Vitest"
```

---

## Task 2: Optimización de las fotografías

**Files:**
- Create: `scripts/optimize-images.mjs`
- Test: `tests/images.test.ts`

**Interfaces:**
- Consumes: `IMÁGENES/*.jpg` (14 archivos, no versionados).
- Produces: `public/images/<id>.webp` para los 14 `id` del spec §7.2. La tabla `SOURCES` exportada por el script es la referencia de mapeo.

- [ ] **Step 1: Escribir la prueba (falla)**

`tests/images.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SOURCES } from '@/scripts/optimize-images.mjs';

const DIR = join(process.cwd(), 'public', 'images');

describe('imágenes optimizadas', () => {
  it('genera un webp por cada imagen de origen', () => {
    for (const { id } of SOURCES) {
      expect(existsSync(join(DIR, `${id}.webp`)), `falta ${id}.webp`).toBe(true);
    }
  });

  it('mantiene el peso total por debajo de 8 MB', () => {
    const total = SOURCES.reduce((sum, { id }) => sum + statSync(join(DIR, `${id}.webp`)).size, 0);
    expect(total).toBeLessThan(8 * 1024 * 1024);
  });

  it('no repite identificadores', () => {
    const ids = SOURCES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
```

- [ ] **Step 2: Ejecutar y verificar que falla**

Run: `npx vitest run tests/images.test.ts`
Expected: FAIL — no existe `scripts/optimize-images.mjs`.

- [ ] **Step 3: Implementar el script**

`scripts/optimize-images.mjs`. El mapeo es explícito para que no dependa del orden del directorio:

```js
import sharp from 'sharp';
import { readdirSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

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

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
```

`.rotate()` sin argumentos aplica la orientación EXIF y de paso descarta los metadatos, que sharp no copia salvo que se le pida.

- [ ] **Step 4: Ejecutar el script**

Run: `npm run images`
Expected: 14 líneas con el peso antes y después, y un total muy por debajo de 8 MB.

- [ ] **Step 5: Ejecutar la prueba y verificar que pasa**

Run: `npx vitest run tests/images.test.ts`
Expected: PASS, 3 pruebas.

- [ ] **Step 6: Inspeccionar dos resultados a ojo**

Abrir `public/images/set-medicos.webp` y `public/images/cocina-linea-completa.webp`. Ambas contienen prendas blancas sobre fondo blanco: confirmar que la prenda sigue distinguiéndose del fondo. Si aparecen bandas o pérdida de detalle, subir `QUALITY` a 85 y repetir.

- [ ] **Step 7: Commit**

```bash
git add scripts/optimize-images.mjs tests/images.test.ts public/images
git commit -m "feat: optimizar las 14 fotografías a WebP"
```

---

## Task 3: Manifest de medios y componente Figure

**Files:**
- Create: `content/media.ts`, `components/ui/Figure.tsx`
- Test: `tests/media.test.tsx`

**Interfaces:**
- Consumes: `public/images/<id>.webp` de la Task 2.
- Produces: `getMedia(id: MediaId): MediaEntry`, el tipo `MediaId`, y `<Figure id={...} priority?={boolean} className?={string} sizes?={string} />`.

- [ ] **Step 1: Escribir la prueba (falla)**

`tests/media.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MEDIA, getMedia } from '@/content/media';
import { Figure } from '@/components/ui/Figure';

describe('manifest de medios', () => {
  it('da texto alternativo a toda entrada, incluidas las pendientes', () => {
    for (const entry of MEDIA) {
      expect(entry.alt.trim().length, `${entry.id} sin alt`).toBeGreaterThan(0);
    }
  });

  it('respalda con archivo toda entrada no pendiente', () => {
    for (const entry of MEDIA.filter((e) => !e.pending)) {
      const ruta = join(process.cwd(), 'public', 'images', `${entry.id}.webp`);
      expect(existsSync(ruta), `falta ${entry.id}.webp`).toBe(true);
    }
  });

  it('falla ruidosamente ante un identificador desconocido', () => {
    // @ts-expect-error identificador inexistente a propósito
    expect(() => getMedia('no-existe')).toThrow();
  });
});

describe('Figure', () => {
  it('rinde la imagen con su alt cuando el archivo existe', () => {
    render(<Figure id="planta-bordado" />);
    expect(screen.getByAltText(getMedia('planta-bordado').alt)).toBeInTheDocument();
  });

  it('rinde un marcador con el brief cuando la entrada está pendiente', () => {
    render(<Figure id="hogar-cama-vestida" />);
    expect(screen.getByRole('img', { name: getMedia('hogar-cama-vestida').alt })).toBeInTheDocument();
    expect(screen.getByText(/Pendiente/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Ejecutar y verificar que falla**

Run: `npx vitest run tests/media.test.tsx`
Expected: FAIL — no existe `content/media.ts`.

- [ ] **Step 3: Implementar el manifest**

`content/media.ts`:

```ts
export type MediaRatio = '16:9' | '4:3' | '3:4' | '1:1';

export type MediaEntry = {
  id: string;
  ratio: MediaRatio;
  alt: string;
  brief: string;
  pending?: true;
};

export const MEDIA = [
  {
    id: 'corporativo-camisas-pantalones',
    ratio: '16:9',
    alt: 'Hombre y mujer con camisa y pantalón corporativo, junto a camisas en gris, rojo, azul marino y blanco',
    brief: 'Camisas y pantalones corporativos con modelos',
  },
  {
    id: 'planta-bordado',
    ratio: '16:9',
    alt: 'Operarias trabajando en máquinas bordadoras industriales de cabezales múltiples',
    brief: 'Área de bordado en operación',
  },
  {
    id: 'cocina-linea-completa',
    ratio: '16:9',
    alt: 'Filipinas negra y blanca, delantal, gorro de chef, gorra, polo y pantalones de cocina',
    brief: 'Línea completa de uniformes de cocina',
  },
  {
    id: 'cocina-filipinas',
    ratio: '16:9',
    alt: 'Filipinas de chef en negro, blanco, con vivo rosado, roja y de denim',
    brief: 'Variantes de filipina',
  },
  {
    id: 'cocina-gorros-pantalones',
    ratio: '16:9',
    alt: 'Gorra negra, gorros de chef y pantalón de cocina con estampado pied-de-poule',
    brief: 'Gorros, gorras y pantalones de chef',
  },
  {
    id: 'camisas-columbia',
    ratio: '16:9',
    alt: 'Camisa tipo Columbia en caqui, con variantes en azul marino, negro, gris, verde olivo y vinotinto',
    brief: 'Camisas tipo Columbia',
  },
  {
    id: 'camisas-industriales-reflectivo',
    ratio: '16:9',
    alt: 'Camisas industriales con cinta reflectiva amarilla, en negro, azul marino, arena, gris y blanco',
    brief: 'Camisas industriales con reflectivo',
  },
  {
    id: 'playeras-pantalones-industriales',
    ratio: '16:9',
    alt: 'Playera manga larga azul marino y pantalón cargo negro, ambos con cinta reflectiva',
    brief: 'Playeras y pantalones industriales',
  },
  {
    id: 'pantalones-denim-reflectivo',
    ratio: '16:9',
    alt: 'Pantalones de denim azul con cinta reflectiva amarilla en las piernas',
    brief: 'Pantalones de denim con reflectivo',
  },
  {
    id: 'polos-tejido-plano',
    ratio: '16:9',
    alt: 'Polo azul marino de frente y espalda, con muestrario de colores en interlock, warp piqué y piqué',
    brief: 'Polos de tejido plano y muestrario',
  },
  {
    id: 'deportivas',
    ratio: '16:9',
    alt: 'Hoodie celeste, sudadera de cuarto de zipper, hoodie amarillo, vestido deportivo y blusa sin mangas',
    brief: 'Prendas deportivas',
  },
  {
    id: 'chalecos-corporativos',
    ratio: '16:9',
    alt: 'Chaleco ejecutivo y chaleco enguatado en azul marino, de frente y espalda',
    brief: 'Chalecos corporativos',
  },
  {
    id: 'chaquetas-ejecutivas',
    ratio: '16:9',
    alt: 'Chaquetas ejecutivas con cierre frontal en blanco, azul marino y negro',
    brief: 'Chaquetas ejecutivas',
  },
  {
    id: 'set-medicos',
    ratio: '16:9',
    alt: 'Sets de médico de manga corta con pantalón, en negro, blanco y azul marino',
    brief: 'Sets de médicos',
  },
  {
    id: 'hogar-cama-vestida',
    ratio: '3:4',
    alt: 'Cama vestida con set de sábanas y cubrecama de la línea de hogar',
    brief: 'Cama vestida con sábanas y cubrecama',
    pending: true,
  },
] as const satisfies readonly MediaEntry[];

export type MediaId = (typeof MEDIA)[number]['id'];

const INDEX = new Map(MEDIA.map((e) => [e.id, e]));

export function getMedia(id: MediaId): MediaEntry {
  const entry = INDEX.get(id);
  if (!entry) throw new Error(`Imagen desconocida en el manifest: ${id}`);
  return entry;
}

export const RATIO_CSS: Record<MediaRatio, string> = {
  '16:9': '16 / 9',
  '4:3': '4 / 3',
  '3:4': '3 / 4',
  '1:1': '1 / 1',
};
```

Añadir entradas con `pending: true` conforme lleguen las fotos de planta. La entrada de hogar ya está declarada para que la sección no quede sin marcador.

- [ ] **Step 4: Implementar Figure**

`components/ui/Figure.tsx`:

```tsx
import Image from 'next/image';
import { getMedia, RATIO_CSS, type MediaId } from '@/content/media';

type FigureProps = {
  id: MediaId;
  priority?: boolean;
  className?: string;
  sizes?: string;
};

export function Figure({ id, priority = false, className = '', sizes = '100vw' }: FigureProps) {
  const entry = getMedia(id);
  const style = { aspectRatio: RATIO_CSS[entry.ratio] };

  if (entry.pending) {
    return (
      <div
        role="img"
        aria-label={entry.alt}
        style={style}
        className={`relative grid place-items-center overflow-hidden rounded-2xl border border-[var(--glass-border)] bg-gradient-to-br from-navy via-teal to-navy ${className}`}
      >
        <div className="px-6 text-center">
          <p className="text-xs uppercase tracking-[0.2em] text-sky/80">Pendiente de fotografía</p>
          <p className="mt-2 font-[family-name:var(--font-display)] text-lg text-beige">{entry.brief}</p>
        </div>
      </div>
    );
  }

  return (
    <div style={style} className={`relative overflow-hidden rounded-2xl ${className}`}>
      <Image
        src={`/images/${entry.id}.webp`}
        alt={entry.alt}
        fill
        sizes={sizes}
        priority={priority}
        className="object-cover"
      />
    </div>
  );
}
```

- [ ] **Step 5: Ejecutar las pruebas y verificar que pasan**

Run: `npx vitest run tests/media.test.tsx`
Expected: PASS, 5 pruebas.

- [ ] **Step 6: Commit**

```bash
git add content/media.ts components/ui/Figure.tsx tests/media.test.tsx
git commit -m "feat: manifest de medios y componente Figure"
```

---

## Task 4: Primitivas visuales — vidrio, fondo y botones

**Files:**
- Create: `components/ui/GlassCard.tsx`, `components/ui/Button.tsx`, `components/background/AuroraBackground.tsx`
- Modify: `app/globals.css`
- Test: `tests/ui.test.tsx`

**Interfaces:**
- Consumes: tokens CSS de la Task 1.
- Produces: `<GlassCard variant="dark" | "plate" as?={ElementType}>`, `<Button variant="primary" | "secondary" href?={string}>`, `<AuroraBackground />`.

- [ ] **Step 1: Escribir la prueba (falla)**

`tests/ui.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { GlassCard } from '@/components/ui/GlassCard';
import { Button } from '@/components/ui/Button';
import { AuroraBackground } from '@/components/background/AuroraBackground';

describe('GlassCard', () => {
  it('rinde su contenido', () => {
    render(<GlassCard>contenido</GlassCard>);
    expect(screen.getByText('contenido')).toBeInTheDocument();
  });

  it('usa el relleno oscuro por defecto', () => {
    const { container } = render(<GlassCard>x</GlassCard>);
    expect(container.firstElementChild).toHaveClass('bg-[var(--glass-fill)]');
  });

  it('usa la placa clara en la variante plate', () => {
    const { container } = render(<GlassCard variant="plate">x</GlassCard>);
    expect(container.firstElementChild).toHaveClass('bg-[var(--plate-fill)]');
  });
});

describe('Button', () => {
  it('el primario va beige con texto navy, nunca teal de fondo', () => {
    const { container } = render(<Button>Cotizar</Button>);
    const el = container.firstElementChild!;
    expect(el).toHaveClass('bg-beige');
    expect(el).toHaveClass('text-navy');
    expect(el.className).not.toMatch(/bg-teal/);
  });

  it('rinde un enlace cuando recibe href', () => {
    render(<Button href="#cotizacion">Cotizar</Button>);
    expect(screen.getByRole('link', { name: 'Cotizar' })).toHaveAttribute('href', '#cotizacion');
  });

  it('rinde un botón cuando no recibe href', () => {
    render(<Button>Enviar</Button>);
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeInTheDocument();
  });
});

describe('AuroraBackground', () => {
  it('queda fuera del árbol de accesibilidad', () => {
    const { container } = render(<AuroraBackground />);
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });
});
```

- [ ] **Step 2: Ejecutar y verificar que falla**

Run: `npx vitest run tests/ui.test.tsx`
Expected: FAIL — no existen los componentes.

- [ ] **Step 3: Implementar GlassCard**

`components/ui/GlassCard.tsx`:

```tsx
import type { ElementType, ReactNode } from 'react';

const BASE =
  'rounded-2xl border border-[var(--glass-border)] shadow-[var(--glass-shadow)] backdrop-blur-xl';

const VARIANTS = {
  dark: 'bg-[var(--glass-fill)] text-beige',
  plate: 'bg-[var(--plate-fill)] text-navy',
} as const;

type GlassCardProps = {
  children: ReactNode;
  variant?: keyof typeof VARIANTS;
  as?: ElementType;
  className?: string;
  // El resto pasa tal cual al elemento: `aria-label`, `id`, etc.
  [prop: string]: unknown;
};

export function GlassCard({
  children,
  variant = 'dark',
  as: Tag = 'div',
  className = '',
  ...rest
}: GlassCardProps) {
  return (
    <Tag className={`${BASE} ${VARIANTS[variant]} ${className}`} {...rest}>
      {children}
    </Tag>
  );
}
```

- [ ] **Step 4: Implementar Button**

`components/ui/Button.tsx`:

```tsx
import Link from 'next/link';
import type { ReactNode } from 'react';

const BASE =
  'inline-flex items-center justify-center rounded-full px-7 py-3 text-sm font-medium tracking-wide transition-colors disabled:opacity-60 disabled:cursor-not-allowed';

// El primario es beige sobre navy (~8.3:1). Beige sobre teal da 3.9:1 y reprobaría AA.
const VARIANTS = {
  primary: 'bg-beige text-navy hover:bg-white',
  secondary: 'border border-sky/40 bg-white/5 text-beige backdrop-blur-md hover:bg-white/10',
} as const;

type ButtonProps = {
  children: ReactNode;
  variant?: keyof typeof VARIANTS;
  href?: string;
  type?: 'button' | 'submit';
  disabled?: boolean;
  className?: string;
};

export function Button({
  children,
  variant = 'primary',
  href,
  type = 'button',
  disabled = false,
  className = '',
}: ButtonProps) {
  const cls = `${BASE} ${VARIANTS[variant]} ${className}`;
  if (href) {
    return (
      <Link href={href} className={cls}>
        {children}
      </Link>
    );
  }
  return (
    <button type={type} disabled={disabled} className={cls}>
      {children}
    </button>
  );
}
```

- [ ] **Step 5: Implementar AuroraBackground**

`components/background/AuroraBackground.tsx`:

```tsx
export function AuroraBackground() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div className="absolute -left-40 -top-40 h-[38rem] w-[38rem] rounded-full bg-teal/40 blur-[120px] motion-safe:animate-[aurora-a_28s_ease-in-out_infinite]" />
      <div className="absolute -right-40 top-1/3 h-[34rem] w-[34rem] rounded-full bg-sky/25 blur-[130px] motion-safe:animate-[aurora-b_34s_ease-in-out_infinite]" />
      <div className="absolute bottom-[-12rem] left-1/3 h-[30rem] w-[30rem] rounded-full bg-navy/70 blur-[110px] motion-safe:animate-[aurora-c_40s_ease-in-out_infinite]" />
    </div>
  );
}
```

Añadir al final de `app/globals.css`:

```css
@keyframes aurora-a {
  0%, 100% { transform: translate3d(0, 0, 0) scale(1); }
  50%      { transform: translate3d(6rem, 4rem, 0) scale(1.15); }
}
@keyframes aurora-b {
  0%, 100% { transform: translate3d(0, 0, 0) scale(1.1); }
  50%      { transform: translate3d(-5rem, 3rem, 0) scale(1); }
}
@keyframes aurora-c {
  0%, 100% { transform: translate3d(0, 0, 0) scale(1); }
  50%      { transform: translate3d(4rem, -4rem, 0) scale(1.2); }
}
```

`motion-safe:` ya deja las manchas quietas cuando el sistema pide movimiento reducido; la regla global de `prefers-reduced-motion` de la Task 1 es la segunda red.

- [ ] **Step 6: Ejecutar las pruebas y verificar que pasan**

Run: `npx vitest run tests/ui.test.tsx`
Expected: PASS, 7 pruebas.

- [ ] **Step 7: Commit**

```bash
git add components/ui components/background app/globals.css tests/ui.test.tsx
git commit -m "feat: vidrio en dos variantes, botones y fondo aurora"
```

---

## Task 5: Copy centralizado, cabecera y hero

**Files:**
- Create: `content/copy.ts`, `components/sections/Header.tsx`, `components/sections/Hero.tsx`, `public/brand/logo-light.svg`
- Modify: `app/page.tsx`
- Test: `tests/hero.test.tsx`

**Interfaces:**
- Consumes: `Figure`, `GlassCard`, `Button`.
- Produces: `copy` (objeto con las claves `nav`, `hero`, `capacidad`, `cifras`, `lineas`, `proceso`, `personalizacion`, `formulario`, `footer`), `<Header />`, `<Hero />`.

- [ ] **Step 1: Generar el logotipo para fondo oscuro**

`LOGO.svg` es negro sólido. Crear `public/brand/logo-light.svg` copiándolo y añadiendo `fill="#F5EFEB"` al elemento `<svg>`, ya que los `<path>` no declaran `fill` propio y heredan:

```bash
mkdir -p public/brand
sed 's|<svg |<svg fill="#F5EFEB" |' LOGO.svg > public/brand/logo-light.svg
cp LOGO.svg public/brand/logo-dark.svg
```

Verificar abriendo `public/brand/logo-light.svg` en el navegador sobre fondo oscuro. Si algún trazo sigue negro, es que declara `fill` propio: en ese caso reemplazar también `fill="#000000"` y `fill="#000"` por `fill="#F5EFEB"`.

- [ ] **Step 2: Escribir la prueba (falla)**

`tests/hero.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Hero } from '@/components/sections/Hero';
import { copy } from '@/content/copy';

describe('Hero', () => {
  it('pone el título en el único h1', () => {
    render(<Hero />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(copy.hero.titulo);
  });

  it('lleva el CTA principal al formulario', () => {
    render(<Hero />);
    expect(screen.getByRole('link', { name: copy.hero.ctaPrimario })).toHaveAttribute(
      'href',
      '#cotizacion',
    );
  });

  it('muestra los cuatro atributos del deck', () => {
    render(<Hero />);
    expect(copy.hero.atributos).toHaveLength(4);
    for (const attr of copy.hero.atributos) {
      expect(screen.getByText(attr)).toBeInTheDocument();
    }
  });
});
```

- [ ] **Step 3: Ejecutar y verificar que falla**

Run: `npx vitest run tests/hero.test.tsx`
Expected: FAIL — no existe `content/copy.ts`.

- [ ] **Step 4: Escribir el copy**

`content/copy.ts`. Este archivo es la única fuente de texto visible del sitio:

```ts
export const copy = {
  marca: 'Luxe Essentials',

  nav: {
    enlaces: [
      { href: '#capacidad', texto: 'Capacidad' },
      { href: '#lineas', texto: 'Líneas' },
      { href: '#proceso', texto: 'Proceso' },
    ],
    cta: 'Cotizar',
  },

  hero: {
    titulo: 'Fabricamos lo que tu operación viste y usa todos los días.',
    subtitulo:
      'Planta propia en Guatemala. Diseño, corte, bordado, auditoría de calidad y empaque bajo un mismo techo, con capacidad para producción industrial.',
    ctaPrimario: 'Solicitar cotización',
    ctaSecundario: 'Conocer nuestras líneas',
    atributos: [
      'Diseño personalizado',
      'Calidad garantizada',
      'Confección industrial',
      'Imagen que representa',
    ],
  },

  capacidad: {
    titulo: 'Una planta completa, no un intermediario',
    parrafos: [
      'Contamos con departamento propio de corte y diseño: podemos imprimir o desarrollar nuestros propios trazos, o trabajar sobre los que tu marca ya tiene.',
      'La operación integra auditoría de calidad, logística, bodega de accesorios, bordado, bodega de telas y de producto terminado, empaque y un área de carga para contenedores.',
    ],
  },

  cifras: [
    { valor: '250', etiqueta: 'operarios en planta' },
    { valor: '4', etiqueta: 'contenedores cargando a la vez' },
    { valor: '8', etiqueta: 'áreas productivas integradas' },
  ],

  lineas: {
    titulo: 'Dos líneas, una misma planta',
    items: [
      {
        id: 'uniformes',
        nombre: 'Uniformes',
        marca: 'The Chef’s Store',
        descripcion:
          'Uniformes industriales y corporativos para cocinas, industria, salud, oficina y equipos de campo.',
        categorias: [
          'Filipinas ejecutiva, clásica y premium',
          'Gorros de chef y gorras',
          'Camisas tipo Columbia',
          'Camisas industriales con reflectivo',
          'Playeras y pantalones industriales',
          'Pantalones de denim',
          'Polos de tejido plano',
          'Prendas deportivas',
          'Chalecos corporativos',
          'Chaquetas ejecutivas',
          'Sets de médicos',
        ],
      },
      {
        id: 'hogar',
        nombre: 'Textiles de hogar',
        marca: 'Bodega del Edredón',
        descripcion:
          'Ropa de cama y textiles para el hogar, para distribución y para proyectos de hotelería.',
        categorias: [
          'Almohadas',
          'Sets de sábanas de 200 a 600 hilos',
          'Fundas e insertos de duvet',
          'Cubrecamas y edredones',
          'Toallas y accesorios de baño',
          'Línea infantil',
          'Maternidad y bebé',
          'Protectores y accesorios',
        ],
      },
    ],
    galeriaTitulo: 'Algunas de nuestras prendas',
  },

  proceso: {
    titulo: 'De la tela al contenedor',
    pasos: [
      { nombre: 'Diseño y patronaje', detalle: 'Trazos propios o los de tu marca.' },
      { nombre: 'Corte', detalle: 'Departamento propio, sin subcontratar.' },
      { nombre: 'Confección', detalle: 'Producción industrial en línea.' },
      { nombre: 'Bordado y personalización', detalle: 'Tu logo aplicado en planta.' },
      { nombre: 'Auditoría de calidad', detalle: 'Revisión antes de empaque.' },
      { nombre: 'Empaque', detalle: 'Listo para distribución.' },
      { nombre: 'Carga y logística', detalle: 'Hasta cuatro contenedores a la vez.' },
    ],
  },

  personalizacion: {
    titulo: 'Tu marca, aplicada en planta',
    descripcion:
      'Bordado, serigrafía, DTF y sublimación, además de colores, tallas y trazos a la medida de tu equipo.',
    tecnicas: ['Bordado', 'Serigrafía', 'DTF', 'Sublimación'],
  },

  formulario: {
    titulo: 'Solicita tu cotización',
    descripcion: 'Cuéntanos qué necesitas y te respondemos con una propuesta.',
    campos: {
      nombre: 'Nombre',
      empresa: 'Empresa',
      email: 'Correo',
      telefono: 'Teléfono o WhatsApp',
      linea: 'Línea de interés',
      cantidad: 'Cantidad aproximada',
      mensaje: 'Cuéntanos más',
    },
    opcionesLinea: [
      { valor: 'uniformes', texto: 'Uniformes' },
      { valor: 'hogar', texto: 'Textiles de hogar' },
      { valor: 'ambas', texto: 'Ambas' },
    ],
    enviar: 'Enviar solicitud',
    enviando: 'Enviando…',
    exitoTitulo: 'Recibimos tu solicitud',
    exitoDetalle: 'Te contactamos para afinar cantidades y tiempos de entrega.',
    errorGeneral: 'No pudimos enviar tu solicitud. Intenta de nuevo en un momento.',
  },

  footer: {
    // Datos pendientes de confirmar con el cliente (spec §10).
    contactoTitulo: 'Contacto',
    telefono: 'Pendiente de confirmar',
    email: 'Pendiente de confirmar',
    direccion: 'Guatemala',
    derechos: 'Luxe Essentials. Todos los derechos reservados.',
  },
} as const;
```

- [ ] **Step 5: Implementar Header y Hero**

`components/sections/Header.tsx`:

```tsx
import Image from 'next/image';
import { copy } from '@/content/copy';
import { Button } from '@/components/ui/Button';

export function Header() {
  return (
    <header className="sticky top-0 z-50 border-b border-white/10 bg-bg-deep/70 backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Image src="/brand/logo-light.svg" alt={copy.marca} width={104} height={97} priority />
        <nav aria-label="Principal" className="hidden gap-8 md:flex">
          {copy.nav.enlaces.map((e) => (
            <a key={e.href} href={e.href} className="text-sm text-sky hover:text-beige">
              {e.texto}
            </a>
          ))}
        </nav>
        <Button href="#cotizacion" className="px-5 py-2 text-xs">
          {copy.nav.cta}
        </Button>
      </div>
    </header>
  );
}
```

`components/sections/Hero.tsx`:

```tsx
import { copy } from '@/content/copy';
import { Button } from '@/components/ui/Button';
import { GlassCard } from '@/components/ui/GlassCard';
import { Figure } from '@/components/ui/Figure';

export function Hero() {
  return (
    <section className="mx-auto max-w-6xl px-6 pb-20 pt-16 md:pt-24">
      <div className="grid items-center gap-12 md:grid-cols-2">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-4xl leading-tight text-beige md:text-5xl">
            {copy.hero.titulo}
          </h1>
          <p className="mt-6 max-w-xl text-lg text-sky">{copy.hero.subtitulo}</p>
          <div className="mt-9 flex flex-wrap gap-4">
            <Button href="#cotizacion">{copy.hero.ctaPrimario}</Button>
            <Button href="#lineas" variant="secondary">
              {copy.hero.ctaSecundario}
            </Button>
          </div>
        </div>
        <Figure
          id="corporativo-camisas-pantalones"
          priority
          sizes="(min-width: 768px) 50vw, 100vw"
        />
      </div>

      <ul className="mt-16 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {copy.hero.atributos.map((attr) => (
          <GlassCard key={attr} as="li" className="px-5 py-4">
            <span className="text-sm text-beige">{attr}</span>
          </GlassCard>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 6: Componer la página**

`app/page.tsx`:

```tsx
import { AuroraBackground } from '@/components/background/AuroraBackground';
import { Header } from '@/components/sections/Header';
import { Hero } from '@/components/sections/Hero';

export default function Home() {
  return (
    <>
      <AuroraBackground />
      <Header />
      <main>
        <Hero />
      </main>
    </>
  );
}
```

- [ ] **Step 7: Ejecutar las pruebas y verificar que pasan**

Run: `npm test`
Expected: PASS. La prueba de humo de la Task 1 sigue verde porque el hero aporta el único `h1`.

- [ ] **Step 8: Revisar en el navegador**

Run: `npm run dev` y abrir `http://localhost:3000`.
Verificar: el logotipo se ve claro sobre el fondo, las manchas del fondo se mueven, el texto se lee cómodamente y la foto del hero no aparece como recorte blanco duro.

- [ ] **Step 9: Commit**

```bash
git add content/copy.ts components/sections public/brand app/page.tsx tests/hero.test.tsx
git commit -m "feat: copy centralizado, cabecera y hero"
```

---

## Task 6: Secciones de capacidad, cifras, líneas y galería

**Files:**
- Create: `components/sections/Capacidad.tsx`, `components/sections/Cifras.tsx`, `components/sections/Lineas.tsx`
- Modify: `app/page.tsx`
- Test: `tests/secciones.test.tsx`

**Interfaces:**
- Consumes: `copy`, `GlassCard`, `Figure`, `MEDIA`.
- Produces: `<Capacidad />`, `<Cifras />`, `<Lineas />`. `Lineas` expone el ancla `#lineas`.

- [ ] **Step 1: Escribir la prueba (falla)**

`tests/secciones.test.tsx`:

```tsx
import { render, screen, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Capacidad } from '@/components/sections/Capacidad';
import { Cifras } from '@/components/sections/Cifras';
import { Lineas } from '@/components/sections/Lineas';
import { copy } from '@/content/copy';

describe('Capacidad', () => {
  it('muestra todos sus párrafos', () => {
    render(<Capacidad />);
    for (const p of copy.capacidad.parrafos) {
      expect(screen.getByText(p)).toBeInTheDocument();
    }
  });
});

describe('Cifras', () => {
  it('muestra las tres cifras con su etiqueta', () => {
    render(<Cifras />);
    for (const c of copy.cifras) {
      expect(screen.getByText(c.valor)).toBeInTheDocument();
      expect(screen.getByText(c.etiqueta)).toBeInTheDocument();
    }
  });
});

describe('Lineas', () => {
  it('presenta las dos líneas con sus categorías', () => {
    render(<Lineas />);
    for (const linea of copy.lineas.items) {
      const tarjeta = screen.getByRole('article', { name: linea.nombre });
      for (const cat of linea.categorias) {
        expect(within(tarjeta).getByText(cat)).toBeInTheDocument();
      }
    }
  });

  it('no publica precios', () => {
    const { container } = render(<Lineas />);
    expect(container.textContent).not.toMatch(/Q\s?\d/);
  });

  it('expone el ancla de navegación', () => {
    const { container } = render(<Lineas />);
    expect(container.querySelector('#lineas')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Ejecutar y verificar que falla**

Run: `npx vitest run tests/secciones.test.tsx`
Expected: FAIL — no existen las secciones.

- [ ] **Step 3: Implementar Capacidad y Cifras**

`components/sections/Capacidad.tsx`:

```tsx
import { copy } from '@/content/copy';
import { Figure } from '@/components/ui/Figure';

export function Capacidad() {
  return (
    <section id="capacidad" className="mx-auto max-w-6xl px-6 py-20">
      <div className="grid items-center gap-12 md:grid-cols-2">
        <Figure id="planta-bordado" sizes="(min-width: 768px) 50vw, 100vw" />
        <div>
          <h2 className="font-[family-name:var(--font-display)] text-3xl text-beige md:text-4xl">
            {copy.capacidad.titulo}
          </h2>
          {copy.capacidad.parrafos.map((p) => (
            <p key={p} className="mt-5 text-sky">
              {p}
            </p>
          ))}
        </div>
      </div>
    </section>
  );
}
```

`components/sections/Cifras.tsx`:

```tsx
import { copy } from '@/content/copy';
import { GlassCard } from '@/components/ui/GlassCard';

export function Cifras() {
  return (
    <section className="mx-auto max-w-6xl px-6 pb-20">
      <ul className="grid gap-6 sm:grid-cols-3">
        {copy.cifras.map((c) => (
          <GlassCard key={c.etiqueta} as="li" className="px-8 py-10 text-center">
            <p className="font-[family-name:var(--font-display)] text-5xl text-beige">{c.valor}</p>
            <p className="mt-3 text-sm text-sky">{c.etiqueta}</p>
          </GlassCard>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 4: Implementar Lineas con la galería**

`components/sections/Lineas.tsx`. La galería usa la variante `plate` porque son tomas de producto sobre fondo blanco:

```tsx
import { copy } from '@/content/copy';
import { GlassCard } from '@/components/ui/GlassCard';
import { Figure } from '@/components/ui/Figure';
import { getMedia, type MediaId } from '@/content/media';

const GALERIA: MediaId[] = [
  'cocina-filipinas',
  'cocina-gorros-pantalones',
  'camisas-columbia',
  'camisas-industriales-reflectivo',
  'playeras-pantalones-industriales',
  'pantalones-denim-reflectivo',
  'polos-tejido-plano',
  'deportivas',
  'chalecos-corporativos',
  'chaquetas-ejecutivas',
  'set-medicos',
];

const IMAGEN_LINEA = {
  uniformes: 'cocina-linea-completa',
  hogar: 'hogar-cama-vestida',
} as const satisfies Record<string, MediaId>;

export function Lineas() {
  return (
    <section id="lineas" className="mx-auto max-w-6xl px-6 py-20">
      <h2 className="font-[family-name:var(--font-display)] text-3xl text-beige md:text-4xl">
        {copy.lineas.titulo}
      </h2>

      <div className="mt-12 grid gap-8 md:grid-cols-2">
        {copy.lineas.items.map((linea) => (
          <GlassCard key={linea.id} as="article" aria-label={linea.nombre} className="p-8">
            <Figure
              id={IMAGEN_LINEA[linea.id]}
              className="mb-7"
              sizes="(min-width: 768px) 50vw, 100vw"
            />
            <p className="text-xs uppercase tracking-[0.2em] text-sky/80">{linea.marca}</p>
            <h3 className="mt-2 font-[family-name:var(--font-display)] text-2xl text-beige">
              {linea.nombre}
            </h3>
            <p className="mt-3 text-sky">{linea.descripcion}</p>
            <ul className="mt-6 space-y-2">
              {linea.categorias.map((cat) => (
                <li key={cat} className="flex gap-3 text-sm text-beige/90">
                  <span aria-hidden="true" className="text-teal">
                    —
                  </span>
                  {cat}
                </li>
              ))}
            </ul>
          </GlassCard>
        ))}
      </div>

      <h3 className="mt-20 font-[family-name:var(--font-display)] text-2xl text-beige">
        {copy.lineas.galeriaTitulo}
      </h3>
      <ul className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {GALERIA.map((id) => (
          <GlassCard key={id} as="li" variant="plate" className="overflow-hidden p-3">
            <Figure id={id} sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw" />
            <p className="px-2 pb-1 pt-3 text-sm font-medium text-navy">{getMedia(id).brief}</p>
          </GlassCard>
        ))}
      </ul>
    </section>
  );
}
```

**Nota de la Task 4 del spec §8.2:** al ver esto en el navegador, probar añadir `mix-blend-mode: multiply` a la imagen de la galería para fundir el fondo blanco con la placa beige. Si `set-medicos` (scrubs blancos) pierde definición, descartar el modo de fusión y dejar la placa plana. Ambas salidas son aceptables.

- [ ] **Step 5: Componer en la página**

Modificar `app/page.tsx` para añadir dentro de `<main>`, después de `<Hero />`:

```tsx
<Capacidad />
<Cifras />
<Lineas />
```

con sus importaciones correspondientes.

- [ ] **Step 6: Ejecutar las pruebas y verificar que pasan**

Run: `npm test`
Expected: PASS, todas las suites.

- [ ] **Step 7: Revisar en el navegador y decidir el modo de fusión**

Run: `npm run dev`
Verificar la galería: que las once tomas se lean como fichas de catálogo y no como recortes. Aplicar la decisión del paso 4.

- [ ] **Step 8: Commit**

```bash
git add components/sections app/page.tsx tests/secciones.test.tsx
git commit -m "feat: secciones de capacidad, cifras, líneas y galería"
```

---

## Task 7: Secciones de proceso, personalización y pie

**Files:**
- Create: `components/sections/Proceso.tsx`, `components/sections/Personalizacion.tsx`, `components/sections/Footer.tsx`
- Modify: `app/page.tsx`
- Test: `tests/proceso.test.tsx`

**Interfaces:**
- Consumes: `copy`, `GlassCard`, `Figure`.
- Produces: `<Proceso />` (ancla `#proceso`), `<Personalizacion />`, `<Footer />`.

- [ ] **Step 1: Escribir la prueba (falla)**

`tests/proceso.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Proceso } from '@/components/sections/Proceso';
import { Personalizacion } from '@/components/sections/Personalizacion';
import { Footer } from '@/components/sections/Footer';
import { copy } from '@/content/copy';

describe('Proceso', () => {
  it('lista los siete pasos en orden', () => {
    render(<Proceso />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(copy.proceso.pasos.length);
    copy.proceso.pasos.forEach((paso, i) => {
      expect(items[i]).toHaveTextContent(paso.nombre);
    });
  });

  it('numera cada paso', () => {
    render(<Proceso />);
    expect(screen.getByText('01')).toBeInTheDocument();
    expect(screen.getByText('07')).toBeInTheDocument();
  });
});

describe('Personalizacion', () => {
  it('nombra las cuatro técnicas', () => {
    render(<Personalizacion />);
    for (const t of copy.personalizacion.tecnicas) {
      expect(screen.getByText(t)).toBeInTheDocument();
    }
  });
});

describe('Footer', () => {
  it('es un contentinfo con el año actual', () => {
    render(<Footer />);
    const pie = screen.getByRole('contentinfo');
    expect(pie).toHaveTextContent(String(new Date().getFullYear()));
  });
});
```

- [ ] **Step 2: Ejecutar y verificar que falla**

Run: `npx vitest run tests/proceso.test.tsx`
Expected: FAIL — no existen las secciones.

- [ ] **Step 3: Implementar Proceso**

`components/sections/Proceso.tsx`. Sólo un paso tiene fotografía; los otros seis son tarjetas tipográficas, por la decisión del spec §5.5:

```tsx
import { copy } from '@/content/copy';
import { GlassCard } from '@/components/ui/GlassCard';

export function Proceso() {
  return (
    <section id="proceso" className="mx-auto max-w-6xl px-6 py-20">
      <h2 className="font-[family-name:var(--font-display)] text-3xl text-beige md:text-4xl">
        {copy.proceso.titulo}
      </h2>
      <ol className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {copy.proceso.pasos.map((paso, i) => (
          <GlassCard key={paso.nombre} as="li" className="p-6">
            <span className="font-[family-name:var(--font-display)] text-2xl text-teal">
              {String(i + 1).padStart(2, '0')}
            </span>
            <h3 className="mt-3 text-base font-medium text-beige">{paso.nombre}</h3>
            <p className="mt-2 text-sm text-sky">{paso.detalle}</p>
          </GlassCard>
        ))}
      </ol>
    </section>
  );
}
```

- [ ] **Step 4: Implementar Personalizacion y Footer**

`components/sections/Personalizacion.tsx`:

```tsx
import { copy } from '@/content/copy';
import { GlassCard } from '@/components/ui/GlassCard';

export function Personalizacion() {
  return (
    <section className="mx-auto max-w-6xl px-6 pb-20">
      <GlassCard className="p-10 md:p-14">
        <h2 className="font-[family-name:var(--font-display)] text-3xl text-beige md:text-4xl">
          {copy.personalizacion.titulo}
        </h2>
        <p className="mt-5 max-w-2xl text-sky">{copy.personalizacion.descripcion}</p>
        <ul className="mt-8 flex flex-wrap gap-3">
          {copy.personalizacion.tecnicas.map((t) => (
            <li
              key={t}
              className="rounded-full border border-sky/30 px-5 py-2 text-sm text-beige"
            >
              {t}
            </li>
          ))}
        </ul>
      </GlassCard>
    </section>
  );
}
```

`components/sections/Footer.tsx`:

```tsx
import Image from 'next/image';
import { copy } from '@/content/copy';

export function Footer() {
  return (
    <footer className="border-t border-white/10 bg-black/20">
      <div className="mx-auto grid max-w-6xl gap-10 px-6 py-14 sm:grid-cols-2">
        <div>
          <Image src="/brand/logo-light.svg" alt={copy.marca} width={88} height={82} />
          <p className="mt-5 max-w-xs text-sm text-sky">
            {copy.lineas.items.map((l) => l.nombre).join(' · ')}
          </p>
        </div>
        <div>
          <h2 className="text-sm font-medium text-beige">{copy.footer.contactoTitulo}</h2>
          <ul className="mt-4 space-y-2 text-sm text-sky">
            <li>{copy.footer.telefono}</li>
            <li>{copy.footer.email}</li>
            <li>{copy.footer.direccion}</li>
          </ul>
        </div>
      </div>
      <div className="border-t border-white/10 px-6 py-6 text-center text-xs text-sky/70">
        © {new Date().getFullYear()} {copy.footer.derechos}
      </div>
    </footer>
  );
}
```

- [ ] **Step 5: Componer en la página**

Añadir `<Proceso />` y `<Personalizacion />` dentro de `<main>` tras `<Lineas />`, y `<Footer />` después de `</main>`.

- [ ] **Step 6: Ejecutar las pruebas y verificar que pasan**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add components/sections app/page.tsx tests/proceso.test.tsx
git commit -m "feat: secciones de proceso, personalización y pie"
```

---

## Task 8: Tabla de leads en Supabase

**Files:**
- Create: `supabase/migrations/0001_leads.sql`, `scripts/db.mjs`
- Modify: `package.json`
- Test: verificación manual contra la base

**Interfaces:**
- Consumes: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_DATABASE_PASSWORD` de `.env.local`.
- Produces: tabla `public.leads` con las columnas del spec §6.4. Comando `node scripts/db.mjs migrate`.

- [ ] **Step 1: Escribir la migración**

`supabase/migrations/0001_leads.sql`:

```sql
create table if not exists public.leads (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  nombre         text not null,
  empresa        text,
  email          text not null,
  telefono       text,
  linea          text not null check (linea in ('uniformes','hogar','ambas')),
  cantidad       text,
  mensaje        text,
  fuente         text not null default 'landing',
  utm            jsonb,
  ghl_contact_id text,
  ghl_synced_at  timestamptz,
  ghl_error      text
);

alter table public.leads enable row level security;

-- Sin políticas: sólo el service role escribe, desde el route handler.

create index if not exists leads_created_at_idx on public.leads (created_at desc);

-- Cola de reintento: leads que no llegaron a GHL.
create index if not exists leads_pendientes_ghl_idx
  on public.leads (created_at desc)
  where ghl_contact_id is null;
```

- [ ] **Step 2: Escribir el runner de migraciones**

`scripts/db.mjs`:

```js
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import 'dotenv/config';

const DIR = join(process.cwd(), 'supabase', 'migrations');

function connectionString() {
  if (process.env.SUPABASE_DB_URL) return process.env.SUPABASE_DB_URL;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const password = process.env.SUPABASE_DATABASE_PASSWORD;
  if (!url || !password) {
    throw new Error('Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_DATABASE_PASSWORD.');
  }
  const ref = new URL(url).hostname.split('.')[0];
  return `postgresql://postgres:${encodeURIComponent(password)}@db.${ref}.supabase.co:5432/postgres`;
}

async function migrate() {
  const client = new pg.Client({
    connectionString: connectionString(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  await client.query(`
    create table if not exists public._migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const { rows } = await client.query('select name from public._migrations');
  const aplicadas = new Set(rows.map((r) => r.name));
  const archivos = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

  for (const archivo of archivos) {
    if (aplicadas.has(archivo)) {
      console.log(`· ${archivo} (ya aplicada)`);
      continue;
    }
    const sql = readFileSync(join(DIR, archivo), 'utf8');
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query('insert into public._migrations (name) values ($1)', [archivo]);
      await client.query('commit');
      console.log(`✓ ${archivo}`);
    } catch (err) {
      await client.query('rollback');
      throw new Error(`Falló ${archivo}: ${err.message}`);
    }
  }

  await client.end();
}

const comando = process.argv[2];
if (comando !== 'migrate') {
  console.error('Uso: node scripts/db.mjs migrate');
  process.exit(1);
}
await migrate();
```

Añadir el script:

```bash
npm pkg set scripts.db:migrate="node scripts/db.mjs migrate"
```

- [ ] **Step 3: Aplicar la migración**

Run: `npm run db:migrate`
Expected: `✓ 0001_leads.sql`.

Si la conexión falla por resolución de host, el proyecto usa el pooler en lugar del host directo. Tomar la cadena de conexión desde el panel de Supabase (Project Settings → Database → Connection string → URI) y exportarla como `SUPABASE_DB_URL` en `.env.local`; el script la prefiere sobre la derivada.

- [ ] **Step 4: Verificar la tabla**

```bash
node -e "
import('pg').then(async ({default: pg}) => {
  const {default: dotenv} = await import('dotenv'); dotenv.config({path:'.env.local'});
  const c = new pg.Client({connectionString: process.env.SUPABASE_DB_URL, ssl:{rejectUnauthorized:false}});
  await c.connect();
  const r = await c.query(\"select column_name from information_schema.columns where table_name='leads' order by ordinal_position\");
  console.log(r.rows.map(x=>x.column_name).join(', '));
  await c.end();
});
"
```

Expected: las 14 columnas del spec.

- [ ] **Step 5: Commit**

```bash
git add supabase scripts/db.mjs package.json
git commit -m "feat: tabla leads en Supabase con runner de migraciones"
```

---

## Task 9: Validación del formulario

**Files:**
- Create: `lib/validation.ts`
- Test: `tests/validation.test.ts`

**Interfaces:**
- Consumes: `zod`.
- Produces: `leadSchema`, `LINEAS`, y el tipo `LeadInput` con los campos `nombre`, `empresa`, `email`, `telefono`, `linea`, `cantidad`, `mensaje`, `utm`.

- [ ] **Step 1: Escribir la prueba (falla)**

`tests/validation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { leadSchema } from '@/lib/validation';

const valido = {
  nombre: 'Ana Pérez',
  email: 'ana@empresa.com',
  linea: 'uniformes',
};

describe('leadSchema', () => {
  it('acepta el mínimo requerido', () => {
    expect(leadSchema.safeParse(valido).success).toBe(true);
  });

  it('rechaza un correo inválido', () => {
    const r = leadSchema.safeParse({ ...valido, email: 'ana-arroba-empresa' });
    expect(r.success).toBe(false);
  });

  it('rechaza un nombre de una sola letra', () => {
    expect(leadSchema.safeParse({ ...valido, nombre: 'A' }).success).toBe(false);
  });

  it('rechaza una línea fuera del catálogo', () => {
    expect(leadSchema.safeParse({ ...valido, linea: 'muebles' }).success).toBe(false);
  });

  it('acepta cadenas vacías en los campos opcionales', () => {
    const r = leadSchema.safeParse({ ...valido, empresa: '', telefono: '', mensaje: '' });
    expect(r.success).toBe(true);
  });

  it('recorta los espacios del nombre', () => {
    const r = leadSchema.safeParse({ ...valido, nombre: '  Ana Pérez  ' });
    expect(r.success && r.data.nombre).toBe('Ana Pérez');
  });

  it('rechaza un mensaje desmedido', () => {
    const r = leadSchema.safeParse({ ...valido, mensaje: 'x'.repeat(2001) });
    expect(r.success).toBe(false);
  });

  it('conserva los parámetros utm', () => {
    const r = leadSchema.safeParse({ ...valido, utm: { utm_source: 'meta' } });
    expect(r.success && r.data.utm).toEqual({ utm_source: 'meta' });
  });
});
```

- [ ] **Step 2: Ejecutar y verificar que falla**

Run: `npx vitest run tests/validation.test.ts`
Expected: FAIL — no existe `lib/validation.ts`.

- [ ] **Step 3: Implementar el esquema**

`lib/validation.ts`. Zod 4: `z.email()` es una función de primer nivel, y `z.record` exige clave y valor:

```ts
import { z } from 'zod';

export const LINEAS = ['uniformes', 'hogar', 'ambas'] as const;

const opcional = (max: number) => z.string().trim().max(max).optional();

export const leadSchema = z.object({
  nombre: z.string().trim().min(2, 'Escribe tu nombre completo.').max(120),
  empresa: opcional(120),
  email: z.email('Escribe un correo válido.'),
  telefono: opcional(40),
  linea: z.enum(LINEAS),
  cantidad: opcional(80),
  mensaje: opcional(2000),
  utm: z.record(z.string(), z.string()).optional(),
});

export type LeadInput = z.infer<typeof leadSchema>;
```

- [ ] **Step 4: Ejecutar las pruebas y verificar que pasan**

Run: `npx vitest run tests/validation.test.ts`
Expected: PASS, 8 pruebas.

- [ ] **Step 5: Commit**

```bash
git add lib/validation.ts tests/validation.test.ts
git commit -m "feat: validación del formulario de cotización"
```

---

## Task 10: Descubrimiento y cliente de GoHighLevel

**Files:**
- Create: `scripts/ghl-discover.mjs`, `lib/ghl.ts`
- Test: `tests/ghl.test.ts`

**Interfaces:**
- Consumes: `LeadInput` de la Task 9; `LUXE_GHL_API_KEY`, `LUXE_GHL_LOCATION_ID`.
- Produces: `upsertContact(lead, deps): Promise<GhlResult>` donde `GhlResult = { ok: true; contactId: string } | { ok: false; error: string }` y `deps = { apiKey, locationId, fetchImpl? }`.

- [ ] **Step 1: Escribir el script de descubrimiento**

No se puede asumir si la llave es v1 o v2: cambian el host, las cabeceras y la forma del cuerpo. `scripts/ghl-discover.mjs`:

```js
import { config } from 'dotenv';

// `import 'dotenv/config'` sólo lee `.env`. Las credenciales de este
// proyecto viven en `.env.local`, así que hay que pedirlo explícitamente.
config({ path: '.env.local' });
config();

const apiKey = process.env.LUXE_GHL_API_KEY;
const locationId = process.env.LUXE_GHL_LOCATION_ID;

if (!apiKey || !locationId) {
  console.error('Faltan LUXE_GHL_API_KEY o LUXE_GHL_LOCATION_ID en .env.local');
  process.exit(1);
}

async function probar(nombre, url, headers) {
  try {
    const res = await fetch(url, { headers });
    const texto = await res.text();
    console.log(`\n=== ${nombre} → ${res.status} ===`);
    console.log(texto.slice(0, 600));
    return res.ok;
  } catch (err) {
    console.log(`\n=== ${nombre} → error de red: ${err.message} ===`);
    return false;
  }
}

const v2 = {
  Authorization: `Bearer ${apiKey}`,
  Version: '2021-07-28',
  Accept: 'application/json',
};

const okV2 = await probar('v2 · location', `https://services.leadconnectorhq.com/locations/${locationId}`, v2);

if (okV2) {
  await probar(
    'v2 · pipelines',
    `https://services.leadconnectorhq.com/opportunities/pipelines?locationId=${locationId}`,
    v2,
  );
  await probar(
    'v2 · custom fields',
    `https://services.leadconnectorhq.com/locations/${locationId}/customFields`,
    v2,
  );
} else {
  await probar('v1 · contacts', 'https://rest.gohighlevel.com/v1/contacts/?limit=1', {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
  });
}
```

- [ ] **Step 2: Ejecutar el descubrimiento y anotar el resultado**

Run: `node scripts/ghl-discover.mjs`

Anotar en el commit cuál de las dos APIs respondió 200. Si respondió v2, anotar también si hay pipelines disponibles. **Si sólo responde v1**, la implementación del paso 4 cambia de host y de cuerpo; el resto del plan no se ve afectado porque `upsertContact` mantiene su firma.

- [ ] **Step 3: Escribir la prueba (falla)**

`tests/ghl.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { upsertContact } from '@/lib/ghl';

const lead = {
  nombre: 'Ana María Pérez',
  email: 'ana@empresa.com',
  telefono: '+502 5555 5555',
  empresa: 'Hotel Real',
  linea: 'uniformes' as const,
  cantidad: '300 piezas',
  mensaje: 'Filipinas bordadas',
};

const deps = { apiKey: 'llave', locationId: 'ubicacion' };

function respuesta(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response);
}

describe('upsertContact', () => {
  it('devuelve el id del contacto creado', async () => {
    const fetchImpl = respuesta({ contact: { id: 'abc123' } });
    const r = await upsertContact(lead, { ...deps, fetchImpl });
    expect(r).toEqual({ ok: true, contactId: 'abc123' });
  });

  it('acepta también la forma plana de la respuesta', async () => {
    const fetchImpl = respuesta({ id: 'xyz789' });
    const r = await upsertContact(lead, { ...deps, fetchImpl });
    expect(r).toEqual({ ok: true, contactId: 'xyz789' });
  });

  it('parte el nombre en nombre y apellidos', async () => {
    const fetchImpl = respuesta({ contact: { id: 'a' } });
    await upsertContact(lead, { ...deps, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.firstName).toBe('Ana');
    expect(body.lastName).toBe('María Pérez');
  });

  it('etiqueta el contacto con la línea de interés', async () => {
    const fetchImpl = respuesta({ contact: { id: 'a' } });
    await upsertContact(lead, { ...deps, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.tags).toContain('linea-uniformes');
    expect(body.tags).toContain('luxe-web');
  });

  it('manda la cabecera de versión y el bearer', async () => {
    const fetchImpl = respuesta({ contact: { id: 'a' } });
    await upsertContact(lead, { ...deps, fetchImpl });
    const headers = fetchImpl.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe('Bearer llave');
    expect(headers.Version).toBe('2021-07-28');
  });

  it('informa el error sin lanzar cuando la API rechaza', async () => {
    const fetchImpl = respuesta({ message: 'no autorizado' }, 401);
    const r = await upsertContact(lead, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/401/);
  });

  it('informa el error sin lanzar cuando la red falla', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('sin conexión'));
    const r = await upsertContact(lead, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/sin conexión/);
  });
});
```

- [ ] **Step 4: Ejecutar y verificar que falla**

Run: `npx vitest run tests/ghl.test.ts`
Expected: FAIL — no existe `lib/ghl.ts`.

- [ ] **Step 5: Implementar el cliente**

`lib/ghl.ts`. Nunca lanza: el llamador necesita seguir su curso y registrar el error:

```ts
import type { LeadInput } from '@/lib/validation';

const BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';

export type GhlResult = { ok: true; contactId: string } | { ok: false; error: string };

type Deps = {
  apiKey: string;
  locationId: string;
  fetchImpl?: typeof fetch;
};

function partirNombre(completo: string) {
  const partes = completo.trim().split(/\s+/);
  return { firstName: partes[0] ?? '', lastName: partes.slice(1).join(' ') || undefined };
}

export async function upsertContact(lead: LeadInput, deps: Deps): Promise<GhlResult> {
  const { apiKey, locationId, fetchImpl = fetch } = deps;
  const { firstName, lastName } = partirNombre(lead.nombre);

  const body = {
    locationId,
    firstName,
    lastName,
    email: lead.email,
    phone: lead.telefono || undefined,
    companyName: lead.empresa || undefined,
    source: 'Landing Luxe Essentials',
    tags: ['landing', 'luxe-web', `linea-${lead.linea}`],
  };

  try {
    const res = await fetchImpl(`${BASE}/contacts/upsert`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Version: VERSION,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });

    const texto = await res.text();
    if (!res.ok) {
      return { ok: false, error: `GHL ${res.status}: ${texto.slice(0, 300)}` };
    }

    const datos = JSON.parse(texto) as { contact?: { id?: string }; id?: string };
    const contactId = datos.contact?.id ?? datos.id;
    if (!contactId) {
      return { ok: false, error: `GHL respondió sin id de contacto: ${texto.slice(0, 300)}` };
    }
    return { ok: true, contactId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

Si el paso 2 determinó que la llave es v1, cambiar `BASE` a `https://rest.gohighlevel.com/v1`, la ruta a `/contacts/`, quitar la cabecera `Version` y sustituir `companyName` por `companyName` dentro de `customField`. La firma y el tipo de retorno no cambian, así que las pruebas siguen siendo válidas salvo la de la cabecera de versión, que se elimina.

- [ ] **Step 6: Ejecutar las pruebas y verificar que pasan**

Run: `npx vitest run tests/ghl.test.ts`
Expected: PASS, 7 pruebas.

- [ ] **Step 7: Commit**

```bash
git add lib/ghl.ts scripts/ghl-discover.mjs tests/ghl.test.ts
git commit -m "feat: cliente de GoHighLevel con descubrimiento de API"
```

---

## Task 11: Route handler de recepción del lead

**Files:**
- Create: `lib/supabase/server.ts`, `app/api/lead/route.ts`
- Test: `tests/api-lead.test.ts`

**Interfaces:**
- Consumes: `leadSchema`, `upsertContact`.
- Produces: `POST /api/lead`. Respuestas: `201 { ok: true }`, `400 { ok: false, errores }`, `500 { ok: false, error }`.

- [ ] **Step 1: Escribir la prueba (falla)**

`tests/api-lead.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const insert = vi.fn();
const update = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      insert: (fila: unknown) => {
        insert(fila);
        return { select: () => ({ single: async () => ({ data: { id: 'fila-1' }, error: null }) }) };
      },
      update: (campos: unknown) => {
        update(campos);
        return { eq: async () => ({ error: null }) };
      },
    }),
  }),
}));

const upsertContact = vi.fn();
vi.mock('@/lib/ghl', () => ({ upsertContact: (...a: unknown[]) => upsertContact(...a) }));

const { POST } = await import('@/app/api/lead/route');

const cuerpo = {
  nombre: 'Ana Pérez',
  email: 'ana@empresa.com',
  linea: 'uniformes',
};

function peticion(body: unknown) {
  return new Request('http://localhost/api/lead', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  insert.mockClear();
  update.mockClear();
  upsertContact.mockReset();
  process.env.LUXE_GHL_API_KEY = 'llave';
  process.env.LUXE_GHL_LOCATION_ID = 'ubicacion';
});

describe('POST /api/lead', () => {
  it('rechaza un cuerpo inválido con 400 y no toca la base', async () => {
    const res = await POST(peticion({ ...cuerpo, email: 'no-es-correo' }));
    expect(res.status).toBe(400);
    expect(insert).not.toHaveBeenCalled();
  });

  it('guarda en Supabase antes de llamar a GHL', async () => {
    const orden: string[] = [];
    insert.mockImplementation(() => orden.push('supabase'));
    upsertContact.mockImplementation(async () => {
      orden.push('ghl');
      return { ok: true, contactId: 'c1' };
    });

    await POST(peticion(cuerpo));
    expect(orden).toEqual(['supabase', 'ghl']);
  });

  it('devuelve 201 y registra el id de GHL cuando todo sale bien', async () => {
    upsertContact.mockResolvedValue({ ok: true, contactId: 'c1' });
    const res = await POST(peticion(cuerpo));
    expect(res.status).toBe(201);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ ghl_contact_id: 'c1', ghl_error: null }),
    );
  });

  it('sigue devolviendo 201 y anota el error cuando GHL falla', async () => {
    upsertContact.mockResolvedValue({ ok: false, error: 'GHL 401' });
    const res = await POST(peticion(cuerpo));

    expect(res.status).toBe(201);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ ghl_error: 'GHL 401' }));
  });
});
```

La cuarta prueba es la que sostiene la decisión del spec §6.3: el lead ya está a salvo, así que el usuario no debe ver un error.

- [ ] **Step 2: Ejecutar y verificar que falla**

Run: `npx vitest run tests/api-lead.test.ts`
Expected: FAIL — no existe el route handler.

- [ ] **Step 3: Implementar el cliente de Supabase**

`lib/supabase/server.ts`:

```ts
import 'server-only';
import { createClient } from '@supabase/supabase-js';

export function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Faltan las credenciales de Supabase en el servidor.');

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
```

```bash
npm i server-only
```

`server-only` hace que la compilación falle si algún componente cliente importa este módulo. Es la red que sostiene la restricción global de secretos.

- [ ] **Step 4: Implementar el route handler**

`app/api/lead/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { leadSchema } from '@/lib/validation';
import { supabaseAdmin } from '@/lib/supabase/server';
import { upsertContact } from '@/lib/ghl';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  let crudo: unknown;
  try {
    crudo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo ilegible.' }, { status: 400 });
  }

  const parsed = leadSchema.safeParse(crudo);
  if (!parsed.success) {
    // `.issues` es estable entre versiones de Zod; `.flatten()` está en desuso en Zod 4.
    const errores = Object.fromEntries(
      parsed.error.issues.map((i) => [i.path.join('.') || '_', i.message]),
    );
    return NextResponse.json({ ok: false, errores }, { status: 400 });
  }

  const lead = parsed.data;
  const db = supabaseAdmin();

  // Primero la base: si GHL falla después, el lead no se pierde.
  const { data: fila, error: errorInsert } = await db
    .from('leads')
    .insert({
      nombre: lead.nombre,
      empresa: lead.empresa || null,
      email: lead.email,
      telefono: lead.telefono || null,
      linea: lead.linea,
      cantidad: lead.cantidad || null,
      mensaje: lead.mensaje || null,
      utm: lead.utm ?? null,
    })
    .select()
    .single();

  if (errorInsert || !fila) {
    return NextResponse.json(
      { ok: false, error: 'No pudimos guardar tu solicitud.' },
      { status: 500 },
    );
  }

  const resultado = await upsertContact(lead, {
    apiKey: process.env.LUXE_GHL_API_KEY ?? '',
    locationId: process.env.LUXE_GHL_LOCATION_ID ?? '',
  });

  await db
    .from('leads')
    .update(
      resultado.ok
        ? { ghl_contact_id: resultado.contactId, ghl_synced_at: new Date().toISOString(), ghl_error: null }
        : { ghl_error: resultado.error },
    )
    .eq('id', fila.id);

  if (!resultado.ok) {
    console.error('[lead] GHL falló, lead guardado en Supabase:', fila.id, resultado.error);
  }

  return NextResponse.json({ ok: true }, { status: 201 });
}
```

- [ ] **Step 5: Ejecutar las pruebas y verificar que pasan**

Run: `npx vitest run tests/api-lead.test.ts`
Expected: PASS, 4 pruebas.

- [ ] **Step 6: Commit**

```bash
git add lib/supabase app/api tests/api-lead.test.ts package.json
git commit -m "feat: route handler que guarda el lead antes de sincronizar a GHL"
```

---

## Task 12: Formulario de cotización

**Files:**
- Create: `components/QuoteForm.tsx`, `components/sections/Cotizacion.tsx`
- Modify: `app/page.tsx`
- Test: `tests/quote-form.test.tsx`

**Interfaces:**
- Consumes: `copy.formulario`, `POST /api/lead`, `Button`, `GlassCard`.
- Produces: `<QuoteForm />` (cliente) y `<Cotizacion />` (ancla `#cotizacion`).

- [ ] **Step 1: Escribir la prueba (falla)**

`tests/quote-form.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QuoteForm } from '@/components/QuoteForm';
import { copy } from '@/content/copy';

beforeEach(() => {
  vi.restoreAllMocks();
});

async function llenarMinimo(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(copy.formulario.campos.nombre), 'Ana Pérez');
  await user.type(screen.getByLabelText(copy.formulario.campos.email), 'ana@empresa.com');
  await user.selectOptions(screen.getByLabelText(copy.formulario.campos.linea), 'uniformes');
}

describe('QuoteForm', () => {
  it('asocia una etiqueta a cada campo', () => {
    render(<QuoteForm />);
    for (const etiqueta of Object.values(copy.formulario.campos)) {
      expect(screen.getByLabelText(new RegExp(etiqueta))).toBeInTheDocument();
    }
  });

  it('muestra la confirmación tras un envío exitoso', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 201 }),
    );
    const user = userEvent.setup();
    render(<QuoteForm />);
    await llenarMinimo(user);
    await user.click(screen.getByRole('button', { name: copy.formulario.enviar }));

    await waitFor(() => {
      expect(screen.getByText(copy.formulario.exitoTitulo)).toBeInTheDocument();
    });
  });

  it('muestra el error por campo que devuelve el servidor', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ ok: false, errores: { email: 'Escribe un correo válido.' } }),
        { status: 400 },
      ),
    );
    const user = userEvent.setup();
    render(<QuoteForm />);
    await llenarMinimo(user);
    await user.click(screen.getByRole('button', { name: copy.formulario.enviar }));

    const error = await screen.findByText('Escribe un correo válido.');
    expect(error).toBeInTheDocument();
    // El campo queda asociado a su mensaje para lectores de pantalla.
    expect(screen.getByLabelText(copy.formulario.campos.email)).toHaveAttribute(
      'aria-describedby',
      error.id,
    );
  });

  it('no muestra el error genérico de servidor ante un 400 de validación', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, errores: { email: 'Escribe un correo válido.' } }), {
        status: 400,
      }),
    );
    const user = userEvent.setup();
    render(<QuoteForm />);
    await llenarMinimo(user);
    await user.click(screen.getByRole('button', { name: copy.formulario.enviar }));

    await screen.findByText('Escribe un correo válido.');
    expect(screen.queryByText(copy.formulario.errorGeneral)).not.toBeInTheDocument();
  });

  it('muestra el mensaje de error cuando el servidor falla', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false }), { status: 500 }),
    );
    const user = userEvent.setup();
    render(<QuoteForm />);
    await llenarMinimo(user);
    await user.click(screen.getByRole('button', { name: copy.formulario.enviar }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(copy.formulario.errorGeneral);
    });
  });

  it('desactiva el botón mientras envía', async () => {
    let resolver: (r: Response) => void = () => {};
    vi.spyOn(globalThis, 'fetch').mockReturnValue(
      new Promise<Response>((r) => {
        resolver = r;
      }),
    );
    const user = userEvent.setup();
    render(<QuoteForm />);
    await llenarMinimo(user);
    await user.click(screen.getByRole('button', { name: copy.formulario.enviar }));

    expect(await screen.findByRole('button', { name: copy.formulario.enviando })).toBeDisabled();
    resolver(new Response(JSON.stringify({ ok: true }), { status: 201 }));
  });
});
```

```bash
npm i -D @testing-library/user-event@14
```

- [ ] **Step 2: Ejecutar y verificar que falla**

Run: `npx vitest run tests/quote-form.test.tsx`
Expected: FAIL — no existe `components/QuoteForm.tsx`.

- [ ] **Step 3: Implementar el formulario**

Primero, añadir a `content/copy.ts`, dentro de `formulario`, junto a `errorGeneral`:

```ts
    errorValidacion: 'Revisa los campos marcados.',
```

El spec §5.7 pide cinco estados de UI, y «error de validación» es uno de ellos: distinto de
«error de servidor» porque la acción del visitante es distinta —corregir un campo, no
reintentar más tarde—. Los mensajes por campo llegan del esquema del servidor en la respuesta
400; este texto sólo los encabeza.

`components/QuoteForm.tsx`:

```tsx
'use client';

import { useState, type FormEvent } from 'react';
import { copy } from '@/content/copy';
import { Button } from '@/components/ui/Button';

type Estado = 'reposo' | 'enviando' | 'exito' | 'invalido' | 'error';

const CAMPO =
  'mt-2 w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-beige placeholder:text-sky/50 focus:border-sky focus:outline-none';

const CAMPO_INVALIDO = 'border-beige';

function utmDeLaUrl(): Record<string, string> | undefined {
  if (typeof window === 'undefined') return undefined;
  const params = new URLSearchParams(window.location.search);
  const utm: Record<string, string> = {};
  for (const [k, v] of params) {
    if (k.startsWith('utm_')) utm[k] = v;
  }
  return Object.keys(utm).length > 0 ? utm : undefined;
}

export function QuoteForm() {
  const [estado, setEstado] = useState<Estado>('reposo');
  const [errores, setErrores] = useState<Record<string, string>>({});
  const c = copy.formulario;

  async function enviar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEstado('enviando');
    setErrores({});

    const datos = Object.fromEntries(new FormData(event.currentTarget));

    try {
      const res = await fetch('/api/lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...datos, utm: utmDeLaUrl() }),
      });

      if (res.ok) {
        setEstado('exito');
        return;
      }

      // 400 trae los mensajes por campo que produjo el esquema del servidor.
      if (res.status === 400) {
        const cuerpo = await res.json().catch(() => null);
        setErrores(cuerpo?.errores ?? {});
        setEstado('invalido');
        return;
      }

      setEstado('error');
    } catch {
      setEstado('error');
    }
  }

  // El navegador no valida (el formulario lleva `noValidate`): así los
  // mensajes salen siempre del esquema, en español, y no del idioma del
  // navegador de cada visitante.
  const marca = (campo: string) =>
    errores[campo]
      ? { 'aria-invalid': true, 'aria-describedby': `err-${campo}`, className: `${CAMPO} ${CAMPO_INVALIDO}` }
      : { className: CAMPO };

  function ErrorCampo({ campo }: { campo: string }) {
    if (!errores[campo]) return null;
    return (
      <p id={`err-${campo}`} role="alert" className="mt-2 text-sm text-beige">
        {errores[campo]}
      </p>
    );
  }

  if (estado === 'exito') {
    return (
      <div role="status" className="py-10 text-center">
        <p className="font-[family-name:var(--font-display)] text-2xl text-beige">
          {c.exitoTitulo}
        </p>
        <p className="mt-3 text-sky">{c.exitoDetalle}</p>
      </div>
    );
  }

  return (
    <form onSubmit={enviar} noValidate className="grid gap-5 sm:grid-cols-2">
      <label className="block">
        <span className="text-sm text-sky">{c.campos.nombre}</span>
        <input name="nombre" {...marca('nombre')} />
        <ErrorCampo campo="nombre" />
      </label>

      <label className="block">
        <span className="text-sm text-sky">{c.campos.empresa}</span>
        <input name="empresa" {...marca('empresa')} />
        <ErrorCampo campo="empresa" />
      </label>

      <label className="block">
        <span className="text-sm text-sky">{c.campos.email}</span>
        <input name="email" type="email" {...marca('email')} />
        <ErrorCampo campo="email" />
      </label>

      <label className="block">
        <span className="text-sm text-sky">{c.campos.telefono}</span>
        <input name="telefono" type="tel" {...marca('telefono')} />
        <ErrorCampo campo="telefono" />
      </label>

      <label className="block">
        <span className="text-sm text-sky">{c.campos.linea}</span>
        <select name="linea" defaultValue="" {...marca('linea')}>
          <option value="" disabled />
          {c.opcionesLinea.map((o) => (
            <option key={o.valor} value={o.valor} className="bg-navy">
              {o.texto}
            </option>
          ))}
        </select>
        <ErrorCampo campo="linea" />
      </label>

      <label className="block">
        <span className="text-sm text-sky">{c.campos.cantidad}</span>
        <input name="cantidad" {...marca('cantidad')} />
        <ErrorCampo campo="cantidad" />
      </label>

      <label className="block sm:col-span-2">
        <span className="text-sm text-sky">{c.campos.mensaje}</span>
        <textarea name="mensaje" rows={4} {...marca('mensaje')} />
        <ErrorCampo campo="mensaje" />
      </label>

      {estado === 'invalido' && (
        <p role="alert" className="text-sm text-beige sm:col-span-2">
          {c.errorValidacion}
        </p>
      )}

      {estado === 'error' && (
        <p role="alert" className="text-sm text-beige sm:col-span-2">
          {c.errorGeneral}
        </p>
      )}

      <div className="sm:col-span-2">
        <Button type="submit" disabled={estado === 'enviando'}>
          {estado === 'enviando' ? c.enviando : c.enviar}
        </Button>
      </div>
    </form>
  );
}
```

- [ ] **Step 4: Implementar la sección que lo envuelve**

`components/sections/Cotizacion.tsx`:

```tsx
import { copy } from '@/content/copy';
import { GlassCard } from '@/components/ui/GlassCard';
import { QuoteForm } from '@/components/QuoteForm';

export function Cotizacion() {
  return (
    <section id="cotizacion" className="mx-auto max-w-3xl px-6 py-20">
      <GlassCard className="p-8 md:p-12">
        <h2 className="font-[family-name:var(--font-display)] text-3xl text-beige md:text-4xl">
          {copy.formulario.titulo}
        </h2>
        <p className="mt-4 text-sky">{copy.formulario.descripcion}</p>
        <div className="mt-10">
          <QuoteForm />
        </div>
      </GlassCard>
    </section>
  );
}
```

Añadir `<Cotizacion />` en `app/page.tsx` como última sección de `<main>`.

- [ ] **Step 5: Ejecutar las pruebas y verificar que pasan**

Run: `npm test`
Expected: PASS, todas las suites.

- [ ] **Step 6: Probar el flujo completo contra los servicios reales**

Run: `npm run dev`, llenar el formulario y enviarlo.

Verificar los dos lados:
1. Una fila nueva en la tabla `leads` de Supabase.
2. Un contacto nuevo en GHL con las etiquetas `landing`, `luxe-web` y `linea-…`.

Si GHL no recibe nada, consultar la columna `ghl_error` de esa fila: ahí está la razón exacta.

- [ ] **Step 7: Commit**

```bash
git add components app/page.tsx tests/quote-form.test.tsx package.json
git commit -m "feat: formulario de cotización con sus cuatro estados"
```

---

## Task 13: Metadata, imagen social y repaso de accesibilidad

**Files:**
- Create: `app/metadata.ts`, `app/icon.svg`, `app/opengraph-image.tsx`, `.env.example`
- Modify: `app/layout.tsx`
- Test: `tests/a11y.test.tsx`

**Interfaces:**
- Consumes: `copy`, `public/brand/logo-dark.svg`.
- Produces: metadata completa, favicon e imagen Open Graph generada.

- [ ] **Step 1: Escribir la prueba (falla)**

`tests/a11y.test.tsx`:

```tsx
import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import Home from '@/app/page';
// Desde `app/metadata.ts`, no desde `app/layout.tsx`: el layout importa
// `next/font/google`, que sólo funciona dentro del compilador de Next.
import { siteMetadata as metadata } from '@/app/metadata';

describe('estructura de la página', () => {
  it('tiene un solo h1', () => {
    const { container } = render(<Home />);
    expect(container.querySelectorAll('h1')).toHaveLength(1);
  });

  it('no salta de h1 a h3 sin h2 intermedio', () => {
    const { container } = render(<Home />);
    const niveles = [...container.querySelectorAll('h1,h2,h3')].map((h) =>
      Number(h.tagName[1]),
    );
    for (let i = 1; i < niveles.length; i++) {
      expect(niveles[i] - niveles[i - 1]).toBeLessThanOrEqual(1);
    }
  });

  it('da texto alternativo a toda imagen', () => {
    const { container } = render(<Home />);
    for (const img of container.querySelectorAll('img')) {
      expect(img.getAttribute('alt')).toBeTruthy();
    }
  });
});

describe('metadata', () => {
  it('declara título, descripción y openGraph', () => {
    expect(metadata.title).toBeTruthy();
    expect(metadata.description).toBeTruthy();
    expect(metadata.openGraph).toBeTruthy();
  });

  it('declara metadataBase para resolver las urls absolutas', () => {
    expect(metadata.metadataBase).toBeTruthy();
  });
});
```

- [ ] **Step 2: Ejecutar y verificar que falla**

Run: `npx vitest run tests/a11y.test.tsx`
Expected: FAIL — la metadata todavía no declara `openGraph` ni `metadataBase`.

- [ ] **Step 3: Completar la metadata en su propio módulo**

Crear `app/metadata.ts`. Vive aparte del layout para que las pruebas puedan importarlo sin
arrastrar `next/font/google`:

```ts
import type { Metadata } from 'next';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';

export const siteMetadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'Luxe Essentials — Manufactura textil en Guatemala',
    template: '%s · Luxe Essentials',
  },
  description:
    'Planta propia en Guatemala: uniformes industriales y corporativos, y textiles de hogar. Diseño, corte, bordado y empaque bajo un mismo techo.',
  openGraph: {
    type: 'website',
    locale: 'es_GT',
    url: SITE_URL,
    siteName: 'Luxe Essentials',
    title: 'Luxe Essentials — Manufactura textil en Guatemala',
    description:
      'Uniformes industriales y corporativos, y textiles de hogar, fabricados en planta propia.',
  },
  robots: { index: true, follow: true },
};
```

En `app/layout.tsx`, borrar el objeto `metadata` que puso la Task 1 y reexportar este:

```tsx
export { siteMetadata as metadata } from '@/app/metadata';
```

La importación de `Metadata` en el layout ya no hace falta; quitarla.

- [ ] **Step 4: Generar favicon e imagen social**

`app/icon.svg` lleva sólo el monograma, no el logotipo completo: a 64 px la palabra
«ESSENTIALS» es ilegible.

`LOGO.svg` tiene 13 `<path>` sin `fill` propio. Los nueve primeros (coordenada inicial
y ≈ 278–429) dibujan el logotipo; los **cuatro últimos** (y ≈ 108–218) son el monograma. El
recorte cuadrado que lo encuadra es `viewBox="123 5 240 240"`, ya verificado.

```bash
{
  echo '<svg xmlns="http://www.w3.org/2000/svg" viewBox="123 5 240 240" width="64" height="64">'
  echo '<rect x="123" y="5" width="240" height="240" fill="#2F4156"/>'
  echo '<g fill="#F5EFEB">'
  grep -o '<path d="M231\.23,217\.87[^/]*/>\|<path d="M231\.31,108\.15[^/]*/>\|<path d="M254,110\.46[^/]*/>\|<path d="M253\.74,108\.02[^/]*/>' LOGO.svg
  echo '</g></svg>'
} > app/icon.svg
```

Verificar que el archivo contiene exactamente cuatro `<path>`:

```bash
grep -c '<path' app/icon.svg   # debe imprimir 4
```

Abrirlo en el navegador: debe verse el monograma claro sobre un cuadrado navy, con margen
parejo. Si aparece descentrado, es que `LOGO.svg` cambió; recalcular el `viewBox` a partir de
la caja que ocupan esos cuatro trazos.

`app/opengraph-image.tsx`:

```tsx
import { ImageResponse } from 'next/og';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Luxe Essentials — Manufactura textil en Guatemala';

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: 80,
          background: 'linear-gradient(135deg, #1A2634 0%, #2F4156 55%, #567C8D 100%)',
        }}
      >
        <div style={{ fontSize: 30, letterSpacing: 12, color: '#C8D9E6' }}>LUXE ESSENTIALS</div>
        <div style={{ fontSize: 62, color: '#F5EFEB', marginTop: 28, lineHeight: 1.15 }}>
          Manufactura textil con planta propia en Guatemala
        </div>
      </div>
    ),
    size,
  );
}
```

- [ ] **Step 5: Escribir `.env.example`**

Nombres sin valores, para que quien clone sepa qué necesita:

```bash
NEXT_PUBLIC_SITE_URL=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_DATABASE_PASSWORD=
SUPABASE_DB_URL=
LUXE_GHL_API_KEY=
LUXE_GHL_LOCATION_ID=
```

- [ ] **Step 6: Ejecutar las pruebas y verificar que pasan**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Repaso manual de accesibilidad**

Run: `npm run dev`

Verificar:
1. Recorrer toda la página con Tab: el foco es visible en cada control sobre el fondo oscuro.
2. Activar «Reducir movimiento» en el sistema y recargar: las manchas del fondo quedan quietas.
3. Reducir la ventana a 360 px de ancho: nada desborda horizontalmente.

- [ ] **Step 8: Commit**

```bash
git add app tests/a11y.test.tsx .env.example
git commit -m "feat: metadata, favicon, imagen social y repaso de accesibilidad"
```

---

## Task 14: Repositorio en GitHub y despliegue en Vercel

**Files:**
- Create: `README.md`
- Modify: ninguno

**Interfaces:**
- Consumes: `GITHUB_ACCESS_TOKEN`, `VERCEL_ACCESS_TOKEN` y el resto de variables de `.env.local`.
- Produces: repositorio remoto, proyecto en Vercel con sus variables y despliegue en producción.

- [ ] **Step 1: Verificar que no se filtra ningún secreto**

```bash
git check-ignore -v .env.local && echo "env ignorado"
git log --all --oneline -- .env.local | head -1
grep -rIl "eyJ" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.next . || echo "sin tokens JWT en el árbol"
```

Expected: `.env.local` ignorado, sin historial, y ningún archivo versionado con tokens.

**Si algo aparece aquí, detenerse y limpiarlo antes de continuar.** Un push publica el historial completo.

- [ ] **Step 2: Escribir el README**

`README.md`:

````markdown
# Luxe Essentials — Landing

Landing B2B de captación de cotizaciones. Next.js, Supabase y GoHighLevel.

## Puesta en marcha

```bash
npm install
cp .env.example .env.local   # y rellenar los valores
npm run db:migrate
npm run images               # requiere IMÁGENES/ con los originales
npm run dev
```

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor de desarrollo |
| `npm test` | Pruebas con Vitest |
| `npm run images` | Optimiza `IMÁGENES/` a `public/images/` |
| `npm run db:migrate` | Aplica las migraciones de `supabase/migrations/` |
| `node scripts/ghl-discover.mjs` | Diagnostica la conexión con GoHighLevel |

## Dónde tocar qué

- **Texto del sitio:** `content/copy.ts`. No hay texto visible en los componentes.
- **Imágenes:** `content/media.ts` declara cada una. Para añadir una pendiente, colocar el
  archivo en `public/images/<id>.webp` y quitar `pending: true` de su entrada.
- **Fotografía pendiente:** toda la línea de hogar y seis de los siete pasos de proceso.

## Leads

Cada envío se guarda en `public.leads` y luego se sincroniza a GoHighLevel. Si GHL falla, la
fila queda con `ghl_error` poblado y el lead sigue recuperable:

```sql
select id, created_at, email, ghl_error from public.leads where ghl_contact_id is null;
```
````

- [ ] **Step 3: Crear el repositorio en GitHub por API**

```bash
set -a; source .env.local; set +a

curl -sS -X POST https://api.github.com/user/repos \
  -H "Authorization: Bearer $GITHUB_ACCESS_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -d '{"name":"luxe-essentials","private":true,"description":"Landing de Luxe Essentials"}' \
  | grep -E '"(full_name|ssh_url|clone_url)"'
```

- [ ] **Step 4: Publicar**

```bash
git add README.md && git commit -m "docs: README del proyecto"
git remote add origin "https://x-access-token:${GITHUB_ACCESS_TOKEN}@github.com/<owner>/luxe-essentials.git"
git push -u origin main
git remote set-url origin "https://github.com/<owner>/luxe-essentials.git"
```

La última línea quita el token de la configuración del repositorio, donde quedaría en claro.

- [ ] **Step 5: Crear el proyecto en Vercel por API**

```bash
curl -sS -X POST https://api.vercel.com/v11/projects \
  -H "Authorization: Bearer $VERCEL_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "luxe-essentials",
    "framework": "nextjs",
    "gitRepository": { "type": "github", "repo": "<owner>/luxe-essentials" }
  }'
```

**Si responde error de repositorio no encontrado o de permisos**, la integración de GitHub no está instalada en esa cuenta de Vercel. Dos salidas, en este orden:

1. Instalar la integración desde el panel de Vercel y repetir el comando.
2. Desplegar con el CLI pasando el token explícito, que ignora la sesión local y usa la cuenta del token: `npx vercel@latest --token "$VERCEL_ACCESS_TOKEN" --yes --prod`.

- [ ] **Step 6: Cargar las variables de entorno**

Todas menos `GITHUB_ACCESS_TOKEN` y `VERCEL_ACCESS_TOKEN`, que no pertenecen al runtime:

```bash
PROJECT_ID="<id devuelto en el paso 5>"

for VAR in NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY \
           SUPABASE_SERVICE_ROLE_KEY LUXE_GHL_API_KEY LUXE_GHL_LOCATION_ID; do
  VALUE=$(grep "^${VAR}=" .env.local | cut -d= -f2- | xargs)
  TYPE=$([ "${VAR#NEXT_PUBLIC_}" != "$VAR" ] && echo plain || echo encrypted)
  curl -sS -X POST "https://api.vercel.com/v10/projects/${PROJECT_ID}/env" \
    -H "Authorization: Bearer $VERCEL_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"key\":\"$VAR\",\"value\":\"$VALUE\",\"type\":\"$TYPE\",\"target\":[\"production\",\"preview\",\"development\"]}" \
    -o /dev/null -w "$VAR → %{http_code}\n"
done
```

`NEXT_PUBLIC_SITE_URL` se carga después del paso 7, cuando ya se conoce el dominio.

- [ ] **Step 7: Desplegar y verificar**

Disparar el despliegue con un push vacío si Vercel quedó enlazado al repositorio:

```bash
git commit --allow-empty -m "chore: disparar despliegue" && git push
```

Verificar en el sitio publicado:

1. La página carga con el fondo navy, las manchas en movimiento y el logotipo claro.
2. Las catorce fotografías se ven, sin recortes blancos duros.
3. Un envío real del formulario devuelve la confirmación.
4. Aparece la fila en Supabase y el contacto en GHL.

- [ ] **Step 8: Cargar `NEXT_PUBLIC_SITE_URL` y redesplegar**

Con el dominio ya asignado, repetir el `curl` del paso 6 para `NEXT_PUBLIC_SITE_URL` y volver a desplegar, para que la metadata Open Graph resuelva URLs absolutas.

- [ ] **Step 9: Commit final**

```bash
git add -A && git commit -m "chore: cierre de la fase 1" && git push
```

---

## Verificación final contra los criterios de aceptación del spec

Recorrer los ocho criterios de §11 del spec y confirmar cada uno:

- [ ] Desplegada en Vercel desde un repositorio de GitHub creado por API, en la cuenta de los tokens entregados.
- [ ] Un envío crea fila en `public.leads` y contacto etiquetado en GHL.
- [ ] Un fallo de GHL deja `ghl_error` poblado y aun así confirma éxito al usuario. Comprobable poniendo temporalmente una `LUXE_GHL_API_KEY` inválida en desarrollo.
- [ ] Ninguna credencial de servidor en el bundle del cliente. Comprobable con `grep -r "service_role" .next/static/ || echo limpio`.
- [ ] Las catorce imágenes optimizadas pesan menos de 8 MB en total, y las pendientes muestran marcador.
- [ ] Los contrastes de §4.2 se cumplen. Comprobable con Lighthouse o el inspector del navegador.
- [ ] Usable con teclado y respeta `prefers-reduced-motion`.
- [ ] Todo el texto visible reside en `content/copy.ts`.
