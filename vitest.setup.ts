import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Sin `test.globals: true` en vitest.config.ts, RTL no registra su limpieza
// automática entre pruebas: el DOM de un `render()` sobrevive al siguiente
// `it()` dentro del mismo archivo. Pasó inadvertido hasta ahora porque
// ningún test anterior llamaba a render() más de una vez con contenido que
// colisionara en las mismas queries.
afterEach(() => {
  cleanup();
});
