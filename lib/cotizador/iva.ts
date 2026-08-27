// Tasa general de IVA en Costa Rica. Vive en su propio módulo, separado de
// `escalas.ts` a propósito: ese archivo trae `ESCALAS`, la estructura de
// descuentos por volumen de Luxe (información comercial), y `IVA_GENERAL` es
// un dato público que no tiene por qué viajar pegado a ella.
//
// `lib/validation.ts` importa este módulo, no `escalas.ts`. Antes lo hacía
// desde `escalas.ts` — inofensivo mientras solo lo consumieran rutas de
// servidor, pero el primer componente `'use client'` que trajera un esquema
// de `lib/validation.ts` habría arrastrado `ESCALAS` al paquete del
// navegador en silencio, repitiendo la fuga que motivó la Tarea 8. Ver
// revisión de la Tarea 8, ronda 3.
export const IVA_GENERAL = 0.13;
