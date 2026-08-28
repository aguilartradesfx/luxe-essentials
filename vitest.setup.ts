import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Sin `test.globals: true` en vitest.config.ts, RTL no registra su limpieza
// automática entre pruebas: el DOM de un `render()` sobrevive al siguiente
// `it()` dentro del mismo archivo. Pasó inadvertido hasta ahora porque
// ningún test anterior llamaba a render() más de una vez con contenido que
// colisionara en las mismas queries.
//
// Ronda de correcciones 1 (Tarea 9): `sessionStorage` (jsdom) tampoco se
// limpia solo entre pruebas del mismo archivo — es el mismo objeto global
// durante todo el archivo. `Panel.tsx` guarda ahí el token anti-CSRF de la
// sesión; sin este `clear()`, un token escrito por una prueba sobrevivía a
// la siguiente y debilitaba justo lo que esas pruebas necesitan verificar
// (que la pantalla lo haya guardado ELLA, no que ya estuviera ahí de antes).
// Guardado tras `typeof`: algunos archivos de prueba fijan
// `@vitest-environment node` (p. ej. tests/panel-documento.test.ts), donde
// no existe `sessionStorage` en absoluto.
afterEach(() => {
  cleanup();
  if (typeof sessionStorage !== 'undefined') sessionStorage.clear();
});
