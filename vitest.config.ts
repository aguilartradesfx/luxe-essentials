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
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
      // `server-only` lanza incondicionalmente al importarse fuera de la
      // condición `react-server` que pone el bundler de Next.js — que es
      // justo el punto: convertir en error de build que un componente de
      // cliente arrastre `catalogo.ts`/`escalas.ts`/`calcular.ts` (I5). Pero
      // Vitest no es ese bundler: las pruebas corren en Node/jsdom sin esa
      // condición, así que sin este alias hasta la prueba más legítima de
      // `calcular()` reventaría con el mismo error que la protección busca
      // detectar en el navegador. Se apunta al `empty.js` que el propio
      // paquete `server-only` distribuye para esto (es el archivo al que
      // resuelve la condición `react-server` en producción).
      'server-only': fileURLToPath(new URL('./node_modules/server-only/empty.js', import.meta.url)),
    },
  },
});
