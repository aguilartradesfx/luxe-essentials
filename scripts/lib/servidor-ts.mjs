// Puente para que un script suelto (`.mjs`, Node sin bundler) pueda importar
// piezas reales de `lib/` escritas en TypeScript/TSX con `import 'server-only'`
// — como `renderizarCotizacion` (lib/cotizador/documento.tsx) o `guardarPdf`
// (lib/cotizador/almacen.ts). Un `.mjs` no puede importar un `.ts` directo
// (Node no transforma JSX ni tipos), y reescribir esa lógica en JS plano —
// como sí se hizo con lib/cotizador/credenciales.mjs, ver el comentario ahí —
// serviría de poco acá: documento.tsx es 400+ líneas de JSX con fuentes
// embebidas, y una segunda implementación del PDF de muestra dejaría de
// representar al PDF real que ve un hotel. En cambio, este módulo usa `vite`
// —ya una dependencia de desarrollo, por `vitest`— para levantar el mismo
// pipeline de transformación (JSX + alias) que usa `tests/panel-documento.
// test.ts` bajo `@vitest-environment node`, pero fuera de Vitest: los
// scripts de `scripts/` no son pruebas y no deben vivir bajo `tests/`.
//
// El alias de `server-only` → `empty.js` es una copia exacta del que trae
// `vitest.config.ts`, con el mismo comentario aplicando acá: sin él, cargar
// `documento.tsx`/`almacen.ts`/`lib/supabase/server.ts` fuera del bundler de
// Next.js explota con el error que ese paquete lanza a propósito.
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('../../', import.meta.url));

let servidorPromesa;

function obtenerServidor() {
  if (!servidorPromesa) {
    servidorPromesa = createServer({
      configFile: false,
      root: RAIZ,
      plugins: [react()],
      resolve: {
        alias: {
          '@': RAIZ,
          'server-only': fileURLToPath(new URL('../../node_modules/server-only/empty.js', import.meta.url)),
        },
      },
      server: { middlewareMode: true, hmr: false },
      appType: 'custom',
      // Los scripts corren una vez y se cierran: no hace falta que Vite
      // escriba nada a `node_modules/.vite`.
      cacheDir: undefined,
    });
  }
  return servidorPromesa;
}

// `especificador` en la misma forma que usa el resto del código de verdad,
// p. ej. '@/lib/cotizador/documento' — el mismo alias que ve Next.js.
export async function cargarModuloServidor(especificador) {
  const servidor = await obtenerServidor();
  return servidor.ssrLoadModule(especificador);
}

// Hay que cerrarlo al final del script: mientras el servidor de Vite sigue
// vivo, el proceso de Node no termina solo.
export async function cerrarServidorTs() {
  if (!servidorPromesa) return;
  const servidor = await servidorPromesa;
  await servidor.close();
}
