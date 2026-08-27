# Cotizador — plan de implementación

> **Para agentes ejecutores:** SUB-SKILL REQUERIDA: usar `superpowers:subagent-driven-development`
> (recomendado) o `superpowers:executing-plans` para implementar tarea por tarea. Los pasos
> usan casillas (`- [ ]`) para seguimiento.

**Objetivo:** que un vendedor de Luxe arme una cotización con precios y descuentos
correctos, la envíe al cliente, y quede en GoHighLevel para seguimiento — sin construir un
panel de administrador.

**Arquitectura:** un motor de precios puro y exhaustivamente probado (`lib/cotizador/`),
una pantalla de armado tras clave, y un adaptador que crea el Estimate nativo de
GoHighLevel. GoHighLevel almacena, envía, genera el PDF y lleva el seguimiento; Supabase
solo guarda registro de auditoría y la cola de borradores.

**Stack:** Next.js 16 (App Router), React 19, TypeScript, Zod 4, Supabase, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-26-cotizaciones-design.md`

## Restricciones globales

- **Dinero en enteros.** Colones sin decimales. Nunca `float` para precios ni totales.
- **Redondeo:** medio hacia arriba, sobre el **precio unitario ya descontado**. El subtotal
  de línea es ese unitario × cantidad, nunca al revés.
- **La cotización no menciona método de pago** ni ofrece pagar en línea. Requisito
  explícito de Luxe.
- **Adaptadores de red nunca lanzan.** Devuelven `{ ok: false, error }` y aceptan
  `fetchImpl` inyectable. Patrón ya establecido en `lib/ghl.ts` y `lib/agente/acciones.ts`.
- **Idioma:** identificadores, comentarios y textos de prueba en español, como el resto del
  repositorio.
- **Tasa de IVA es un campo**, por defecto `0.13`. Nunca una constante dentro del cálculo.
- **Primero Supabase, después GoHighLevel.** Nunca al revés.
- Cada tarea termina con `npm test` en verde y un commit.

## Mapa de archivos

| Archivo | Responsabilidad |
|---|---|
| `lib/cotizador/tipos.ts` | Tipos compartidos. Sin lógica. |
| `lib/cotizador/catalogo.ts` | Los 70 SKUs y las 6 escalas. Solo datos. |
| `lib/cotizador/calcular.ts` | Función pura. Sin red, sin base de datos. |
| `lib/cotizador/ghl.ts` | Estimate y Opportunity en GoHighLevel. |
| `lib/cotizador/borrador.ts` | Registra la intención que captura el agente. |
| `lib/validation.ts` (modificar) | Esquema Zod de la petición de cotización. |
| `app/api/cotizacion/route.ts` | Endpoint de cálculo y envío, tras clave. |
| `app/api/cotizacion/borradores/route.ts` | Lista la cola de borradores, tras clave. |
| `app/cotizador/page.tsx` + `Cotizador.tsx` | Pantalla de armado. |
| `supabase/migrations/0005_cotizaciones.sql` | Tabla de registro. |
| `scripts/verificar-estimate-ghl.mjs` | Sonda contra GoHighLevel. |
| `scripts/generar-catalogo.mjs` | Genera `catalogo.ts` desde los `.xlsx`. |

---

### Tarea 1: Verificar que el Estimate sale sin cobro

Es la única tarea que puede invalidar el enfoque completo. Va primero y no escribe código
de producción.

**Archivos:**
- Crear: `scripts/verificar-estimate-ghl.mjs`
- Crear: `docs/ghl-estimate-payload.md`

**Interfaces:**
- Consume: `LUXE_GHL_API_KEY` y `LUXE_GHL_LOCATION_ID` de `.env.local`.
- Produce: `docs/ghl-estimate-payload.md` con el cuerpo exacto que GoHighLevel acepta. La
  Tarea 7 lo implementa contra ese documento.

> **Cuidado: esto escribe en el CRM de producción.** El script crea un Estimate de prueba,
> imprime la respuesta y **lo borra**. No lo envíes a ningún correo real.

- [ ] **Paso 1: Escribir la sonda**

```javascript
// scripts/verificar-estimate-ghl.mjs
// Crea un Estimate de prueba en GoHighLevel, imprime lo que devuelve y lo borra.
// Objetivo: confirmar que se puede emitir sin pasarela de pago.
// Ejecutar con: node --env-file=.env.local scripts/verificar-estimate-ghl.mjs

const apiKey = process.env.LUXE_GHL_API_KEY;
const locationId = process.env.LUXE_GHL_LOCATION_ID;
if (!apiKey || !locationId) {
  console.error('Faltan LUXE_GHL_API_KEY o LUXE_GHL_LOCATION_ID');
  process.exit(1);
}

const BASE = 'https://services.leadconnectorhq.com';
const cabeceras = {
  Authorization: `Bearer ${apiKey}`,
  Version: '2021-07-28',
  'Content-Type': 'application/json',
  Accept: 'application/json',
};

const cuerpo = {
  altId: locationId,
  altType: 'location',
  name: 'PRUEBA — borrar',
  currency: 'CRC',
  liveMode: false,
  businessDetails: { name: 'Luxe Essentials' },
  contactDetails: {
    id: null,
    name: 'Prueba Automatizada',
    email: 'prueba@example.invalid',
  },
  items: [
    {
      name: 'Filipina tradicional manga corta',
      currency: 'CRC',
      amount: 15500,
      qty: 24,
    },
  ],
  discount: { type: 'percentage', value: 5 },
  issueDate: '2026-08-26',
  expiryDate: '2026-09-25',
};

const res = await fetch(`${BASE}/invoices/estimate`, {
  method: 'POST',
  headers: cabeceras,
  body: JSON.stringify(cuerpo),
});
const texto = await res.text();
console.log(`POST /invoices/estimate -> ${res.status}`);
console.log(texto.slice(0, 2000));

if (!res.ok) process.exit(1);

const creado = JSON.parse(texto);
const id = creado._id ?? creado.id;
console.log('\nRevisar en la respuesta de arriba:');
console.log('  - ¿hay algún campo de pasarela, paymentMethods o "pay now"?');
console.log('  - ¿qué trae liveMode?');
console.log('  - ¿el estimateNumber viene asignado?');

if (id) {
  const del = await fetch(`${BASE}/invoices/estimate/${id}?altId=${locationId}&altType=location`, {
    method: 'DELETE',
    headers: cabeceras,
  });
  console.log(`\nDELETE estimate ${id} -> ${del.status}`);
}
```

- [ ] **Paso 2: Ejecutar la sonda**

Ejecutar: `node --env-file=.env.local scripts/verificar-estimate-ghl.mjs`

Esperado: `POST /invoices/estimate -> 200` o `201`, seguido del JSON del Estimate creado y
un `DELETE ... -> 200`.

Si devuelve `401` o `403`, al Private Integration le falta el scope `invoices/estimate.write`.
Agregarlo en GoHighLevel (Settings → Private Integrations) y repetir.

- [ ] **Paso 3: Documentar el hallazgo**

Escribir `docs/ghl-estimate-payload.md` con: el cuerpo exacto que aceptó, la respuesta
completa, y la respuesta a las tres preguntas que imprime el script. Si el Estimate obliga
a una pasarela de pago, **parar y avisar** — el enfoque del spec necesita revisión.

- [ ] **Paso 4: Commit**

```bash
git add scripts/verificar-estimate-ghl.mjs docs/ghl-estimate-payload.md
git commit -m "chore(cotizador): sonda del Estimate de GoHighLevel"
```

---

### Tarea 2: Tipos y escalas de descuento

**Archivos:**
- Crear: `lib/cotizador/tipos.ts`
- Crear: `lib/cotizador/escalas.ts`
- Test: `tests/cotizador-escalas.test.ts`

**Interfaces:**
- Produce: los tipos `Talla`, `Linea`, `GrupoDescuento`, `Escala`, `Sku`, `LineaEntrada`,
  `LineaCalculada`, `Cotizacion`; las constantes `ESCALAS` y `IVA_GENERAL`; y la función
  `escalonDe(cantidad: number, escala: Escala): Escalon`.

- [ ] **Paso 1: Escribir los tipos**

```typescript
// lib/cotizador/tipos.ts

export const TALLAS = ['king', 'queen', 'doble', 'imperial'] as const;
export type Talla = (typeof TALLAS)[number];

// OJO: `lib/validation.ts` ya exporta un `LINEAS` distinto —con 'ambas'— para
// el formulario de leads. Este es el del catálogo y lleva otro nombre a
// propósito: dos exports homónimos con significados distintos es una trampa.
export const LINEAS_CATALOGO = ['uniformes', 'hogar'] as const;
export type LineaCatalogo = (typeof LINEAS_CATALOGO)[number];

// Los grupos que acumulan cantidad para el descuento. Un SKU pertenece a
// exactamente uno, y las cantidades solo se suman dentro del mismo grupo.
export const GRUPOS = [
  'uniformes',
  'sets-cama',
  'fundas-insertos',
  'toallas',
  'bata',
  'almohadas',
] as const;
export type GrupoDescuento = (typeof GRUPOS)[number];

export type Escalon = { desde: number; pct: number };

export type Escala = {
  grupo: GrupoDescuento;
  etiqueta: string;
  // Cómo se llama la unidad al explicarle el descuento al vendedor:
  // "16 sets → 10%" se lee mejor que "16 unidades → 10%".
  unidad: string;
  // Ordenados de mayor a menor `desde`. `escalonDe` devuelve el primero
  // que alcanza, así que el orden es parte del contrato.
  escalones: Escalon[];
};

export type Sku = {
  id: string;
  linea: LineaCatalogo;
  grupo: GrupoDescuento;
  // Agrupación visual en la pantalla y en la cotización. No afecta el cálculo.
  familia: string;
  nombre: string;
  talla?: Talla;
  precioLista: number;
  // Qué trae el juego, desglosado. Solo los sets de cama lo llevan: sin esto,
  // un hotel lee "set de 600 hilos king ₡90.000" y no sabe qué recibe.
  contenido?: string[];
};

export type LineaEntrada = { skuId: string; cantidad: number };

export type LineaCalculada = {
  skuId: string;
  nombre: string;
  contenido?: string[];
  cantidad: number;
  precioLista: number;
  descuentoPct: number;
  precioUnitario: number;
  subtotal: number;
  grupo: GrupoDescuento;
  // Por qué se aplicó este descuento, en texto. La pantalla lo muestra para
  // que el vendedor detecte una escala mal configurada antes de enviar.
  motivo: string;
};

export type Cotizacion = {
  lineas: LineaCalculada[];
  subtotal: number;
  ahorro: number;
  tasaIva: number;
  iva: number;
  total: number;
  bordadoEspecial: boolean;
};
```

- [ ] **Paso 2: Escribir la prueba que falla**

```typescript
// tests/cotizador-escalas.test.ts
import { describe, it, expect } from 'vitest';
import { ESCALAS, escalonDe } from '@/lib/cotizador/escalas';
import { GRUPOS } from '@/lib/cotizador/tipos';

const uniformes = ESCALAS.uniformes;
const sets = ESCALAS['sets-cama'];

describe('escalonDe', () => {
  it('no descuenta por debajo del primer umbral', () => {
    expect(escalonDe(23, uniformes)).toEqual({ desde: 0, pct: 0 });
  });

  it('aplica el 5% justo en el umbral', () => {
    expect(escalonDe(24, uniformes)).toEqual({ desde: 24, pct: 5 });
  });

  it('mantiene el 5% hasta el último valor antes del siguiente escalón', () => {
    expect(escalonDe(47, uniformes)).toEqual({ desde: 24, pct: 5 });
  });

  it('aplica el 10% justo en el segundo umbral', () => {
    expect(escalonDe(48, uniformes)).toEqual({ desde: 48, pct: 10 });
  });

  it('mantiene el 10% muy por encima del umbral', () => {
    expect(escalonDe(5000, uniformes)).toEqual({ desde: 48, pct: 10 });
  });

  it('cantidad cero no descuenta', () => {
    expect(escalonDe(0, uniformes)).toEqual({ desde: 0, pct: 0 });
  });

  it('usa los umbrales propios de cada grupo', () => {
    expect(escalonDe(10, sets)).toEqual({ desde: 10, pct: 5 });
    expect(escalonDe(15, sets)).toEqual({ desde: 10, pct: 5 });
    expect(escalonDe(16, sets)).toEqual({ desde: 16, pct: 10 });
  });
});

describe('ESCALAS', () => {
  it('cubre los seis grupos', () => {
    for (const g of GRUPOS) expect(ESCALAS[g]).toBeDefined();
  });

  it('lleva los umbrales confirmados por Luxe el 2026-08-26', () => {
    const esperado: Record<string, [number, number]> = {
      uniformes: [24, 48],
      'sets-cama': [10, 16],
      'fundas-insertos': [12, 24],
      toallas: [24, 48],
      bata: [24, 48],
      almohadas: [12, 24],
    };
    for (const [grupo, [cinco, diez]] of Object.entries(esperado)) {
      expect(escalonDe(cinco, ESCALAS[grupo as keyof typeof ESCALAS]).pct).toBe(5);
      expect(escalonDe(diez, ESCALAS[grupo as keyof typeof ESCALAS]).pct).toBe(10);
    }
  });

  it('tiene los escalones ordenados de mayor a menor', () => {
    for (const g of GRUPOS) {
      const desdes = ESCALAS[g].escalones.map((e) => e.desde);
      expect(desdes).toEqual([...desdes].sort((a, b) => b - a));
    }
  });
});
```

- [ ] **Paso 3: Ejecutar y ver que falla**

Ejecutar: `npx vitest run tests/cotizador-escalas.test.ts`
Esperado: FALLA — no existe `@/lib/cotizador/escalas`.

- [ ] **Paso 4: Escribir la implementación mínima**

```typescript
// lib/cotizador/escalas.ts
import type { Escala, Escalon, GrupoDescuento } from '@/lib/cotizador/tipos';

// Tasa general de IVA en Costa Rica. Es el valor por defecto, no una constante
// del cálculo: hay ventas a tasa reducida y `calcular` recibe la tasa como dato.
export const IVA_GENERAL = 0.13;

// Confirmadas por Luxe el 2026-08-26. Los seis grupos usan el mismo algoritmo
// y solo cambian los números; por eso son datos y no código.
export const ESCALAS: Record<GrupoDescuento, Escala> = {
  uniformes: {
    grupo: 'uniformes',
    etiqueta: 'Uniformes',
    unidad: 'prendas',
    escalones: [
      { desde: 48, pct: 10 },
      { desde: 24, pct: 5 },
    ],
  },
  'sets-cama': {
    grupo: 'sets-cama',
    etiqueta: 'Sets de cama',
    unidad: 'sets',
    escalones: [
      { desde: 16, pct: 10 },
      { desde: 10, pct: 5 },
    ],
  },
  'fundas-insertos': {
    grupo: 'fundas-insertos',
    etiqueta: 'Fundas e insertos',
    unidad: 'unidades',
    escalones: [
      { desde: 24, pct: 10 },
      { desde: 12, pct: 5 },
    ],
  },
  toallas: {
    grupo: 'toallas',
    etiqueta: 'Toallas',
    unidad: 'unidades',
    escalones: [
      { desde: 48, pct: 10 },
      { desde: 24, pct: 5 },
    ],
  },
  // Grupo propio a propósito. Luxe: "no, las batas solamente tienen descuento
  // si compran 24 y 48 uds. no se pueden unificar." Se muestra junto a las
  // toallas en la pantalla, pero no acumula con ellas.
  bata: {
    grupo: 'bata',
    etiqueta: 'Batas',
    unidad: 'unidades',
    escalones: [
      { desde: 48, pct: 10 },
      { desde: 24, pct: 5 },
    ],
  },
  almohadas: {
    grupo: 'almohadas',
    etiqueta: 'Almohadas',
    unidad: 'paquetes',
    escalones: [
      { desde: 24, pct: 10 },
      { desde: 12, pct: 5 },
    ],
  },
};

const SIN_DESCUENTO: Escalon = { desde: 0, pct: 0 };

export function escalonDe(cantidad: number, escala: Escala): Escalon {
  for (const escalon of escala.escalones) {
    if (cantidad >= escalon.desde) return escalon;
  }
  return SIN_DESCUENTO;
}
```

- [ ] **Paso 5: Ejecutar y ver que pasa**

Ejecutar: `npx vitest run tests/cotizador-escalas.test.ts`
Esperado: PASA, 10 pruebas.

- [ ] **Paso 6: Commit**

```bash
git add lib/cotizador/tipos.ts lib/cotizador/escalas.ts tests/cotizador-escalas.test.ts
git commit -m "feat(cotizador): tipos y las seis escalas de descuento"
```

---

### Tarea 3: Motor de cálculo

El corazón del sistema. Función pura: sin red, sin base de datos, sin GoHighLevel.

**Archivos:**
- Crear: `lib/cotizador/calcular.ts`
- Test: `tests/cotizador-calcular.test.ts`

**Interfaces:**
- Consume: de la Tarea 2, los tipos y `ESCALAS`/`escalonDe`/`IVA_GENERAL`.
- Produce: `calcular(entradas: LineaEntrada[], skus: Sku[], opciones?: OpcionesCalculo): Cotizacion`
  donde `OpcionesCalculo = { tasaIva?: number; bordadoEspecial?: boolean }`.

- [ ] **Paso 1: Escribir la prueba que falla**

```typescript
// tests/cotizador-calcular.test.ts
import { describe, it, expect } from 'vitest';
import { calcular } from '@/lib/cotizador/calcular';
import type { Sku } from '@/lib/cotizador/tipos';

// Catálogo de prueba: no depende de los precios reales de Luxe, para que un
// cambio de lista no rompa las pruebas del motor.
const SKUS: Sku[] = [
  { id: 'uni-a', linea: 'uniformes', grupo: 'uniformes', familia: 'Filipinas', nombre: 'Filipina A', precioLista: 10000 },
  { id: 'uni-b', linea: 'uniformes', grupo: 'uniformes', familia: 'Pantalones', nombre: 'Pantalón B', precioLista: 20000 },
  { id: 'set-k', linea: 'hogar', grupo: 'sets-cama', familia: 'Sets 600', nombre: 'Set 600 king', talla: 'king', precioLista: 90000, contenido: ['1 cubrecama', '1 sábana', '2 sobrefundas'] },
  { id: 'set-q', linea: 'hogar', grupo: 'sets-cama', familia: 'Sets 600', nombre: 'Set 600 queen', talla: 'queen', precioLista: 85000 },
  { id: 'set-d', linea: 'hogar', grupo: 'sets-cama', familia: 'Sets 600', nombre: 'Set 600 doble', talla: 'doble', precioLista: 78000 },
  { id: 'toa-a', linea: 'hogar', grupo: 'toallas', familia: 'Toallas 680', nombre: 'Toalla de baño', precioLista: 10500 },
  { id: 'bata', linea: 'hogar', grupo: 'bata', familia: 'Toallas', nombre: 'Bata blanca', precioLista: 25000 },
  { id: 'impar', linea: 'uniformes', grupo: 'uniformes', familia: 'Prueba', nombre: 'Precio impar', precioLista: 15550 },
];

describe('calcular', () => {
  it('sin líneas devuelve una cotización en cero', () => {
    const c = calcular([], SKUS);
    expect(c.lineas).toEqual([]);
    expect(c.subtotal).toBe(0);
    expect(c.iva).toBe(0);
    expect(c.total).toBe(0);
  });

  it('no descuenta por debajo del umbral', () => {
    const c = calcular([{ skuId: 'uni-a', cantidad: 23 }], SKUS);
    expect(c.lineas[0].descuentoPct).toBe(0);
    expect(c.lineas[0].precioUnitario).toBe(10000);
    expect(c.subtotal).toBe(230000);
    expect(c.ahorro).toBe(0);
  });

  it('acumula cantidades entre productos del mismo grupo', () => {
    // El ejemplo textual de Luxe: 10 + 30 + 8 = 48 prendas -> 10%,
    // aunque ninguna línea llegue por su cuenta a 24.
    const c = calcular(
      [
        { skuId: 'uni-a', cantidad: 30 },
        { skuId: 'uni-b', cantidad: 10 },
        { skuId: 'impar', cantidad: 8 },
      ],
      SKUS,
    );
    for (const linea of c.lineas) expect(linea.descuentoPct).toBe(10);
  });

  it('reproduce el ejemplo de sets que dio Luxe', () => {
    // 10 king + 3 queen + 3 doble = 16 sets -> 10%
    const c = calcular(
      [
        { skuId: 'set-k', cantidad: 10 },
        { skuId: 'set-q', cantidad: 3 },
        { skuId: 'set-d', cantidad: 3 },
      ],
      SKUS,
    );
    for (const linea of c.lineas) expect(linea.descuentoPct).toBe(10);
    expect(c.lineas[0].precioUnitario).toBe(81000);
  });

  it('no mezcla grupos: la bata no acumula con las toallas', () => {
    const c = calcular(
      [
        { skuId: 'toa-a', cantidad: 23 },
        { skuId: 'bata', cantidad: 1 },
      ],
      SKUS,
    );
    // 23 + 1 = 24 sería 5% si acumularan. No acumulan.
    expect(c.lineas.find((l) => l.skuId === 'toa-a')!.descuentoPct).toBe(0);
    expect(c.lineas.find((l) => l.skuId === 'bata')!.descuentoPct).toBe(0);
  });

  it('aplica escalas distintas a grupos distintos en la misma cotización', () => {
    const c = calcular(
      [
        { skuId: 'uni-a', cantidad: 24 },
        { skuId: 'set-k', cantidad: 16 },
      ],
      SKUS,
    );
    expect(c.lineas.find((l) => l.skuId === 'uni-a')!.descuentoPct).toBe(5);
    expect(c.lineas.find((l) => l.skuId === 'set-k')!.descuentoPct).toBe(10);
  });

  it('redondea el precio unitario y el subtotal es unitario por cantidad', () => {
    // 15550 * 0.95 = 14772,5 -> 14773 (medio hacia arriba)
    const c = calcular([{ skuId: 'impar', cantidad: 24 }], SKUS);
    expect(c.lineas[0].precioUnitario).toBe(14773);
    expect(c.lineas[0].subtotal).toBe(14773 * 24);
    expect(Number.isInteger(c.subtotal)).toBe(true);
  });

  it('calcula el IVA sobre el subtotal ya descontado', () => {
    const c = calcular([{ skuId: 'uni-a', cantidad: 24 }], SKUS);
    expect(c.subtotal).toBe(9500 * 24);
    expect(c.iva).toBe(Math.round(9500 * 24 * 0.13));
    expect(c.total).toBe(c.subtotal + c.iva);
  });

  it('acepta una tasa de IVA distinta de la general', () => {
    const c = calcular([{ skuId: 'uni-a', cantidad: 10 }], SKUS, { tasaIva: 0.01 });
    expect(c.tasaIva).toBe(0.01);
    expect(c.iva).toBe(Math.round(100000 * 0.01));
  });

  it('con tasa cero no suma IVA', () => {
    const c = calcular([{ skuId: 'uni-a', cantidad: 10 }], SKUS, { tasaIva: 0 });
    expect(c.iva).toBe(0);
    expect(c.total).toBe(c.subtotal);
  });

  it('reporta el ahorro frente al precio de lista', () => {
    const c = calcular([{ skuId: 'uni-a', cantidad: 24 }], SKUS);
    expect(c.ahorro).toBe(10000 * 24 - 9500 * 24);
  });

  it('explica por qué se aplicó cada descuento', () => {
    const c = calcular([{ skuId: 'uni-a', cantidad: 48 }], SKUS);
    expect(c.lineas[0].motivo).toBe('48 prendas en Uniformes → 10%');
  });

  it('arrastra el contenido del set para imprimirlo', () => {
    const c = calcular([{ skuId: 'set-k', cantidad: 1 }], SKUS);
    expect(c.lineas[0].contenido).toEqual(['1 cubrecama', '1 sábana', '2 sobrefundas']);
  });

  it('marca el bordado especial cuando se pide', () => {
    const c = calcular([{ skuId: 'uni-a', cantidad: 1 }], SKUS, { bordadoEspecial: true });
    expect(c.bordadoEspecial).toBe(true);
  });

  it('lanza si un sku no existe en el catálogo', () => {
    expect(() => calcular([{ skuId: 'fantasma', cantidad: 1 }], SKUS)).toThrow(/fantasma/);
  });

  it('lanza si la cantidad no es un entero positivo', () => {
    expect(() => calcular([{ skuId: 'uni-a', cantidad: 0 }], SKUS)).toThrow(/cantidad/i);
    expect(() => calcular([{ skuId: 'uni-a', cantidad: 1.5 }], SKUS)).toThrow(/cantidad/i);
    expect(() => calcular([{ skuId: 'uni-a', cantidad: -3 }], SKUS)).toThrow(/cantidad/i);
  });

  it('suma las cantidades cuando el mismo sku aparece dos veces', () => {
    const c = calcular(
      [
        { skuId: 'uni-a', cantidad: 12 },
        { skuId: 'uni-a', cantidad: 12 },
      ],
      SKUS,
    );
    expect(c.lineas).toHaveLength(1);
    expect(c.lineas[0].cantidad).toBe(24);
    expect(c.lineas[0].descuentoPct).toBe(5);
  });
});
```

- [ ] **Paso 2: Ejecutar y ver que falla**

Ejecutar: `npx vitest run tests/cotizador-calcular.test.ts`
Esperado: FALLA — no existe `@/lib/cotizador/calcular`.

- [ ] **Paso 3: Escribir la implementación**

```typescript
// lib/cotizador/calcular.ts
import { ESCALAS, escalonDe, IVA_GENERAL } from '@/lib/cotizador/escalas';
import type {
  Cotizacion,
  GrupoDescuento,
  LineaCalculada,
  LineaEntrada,
  Sku,
} from '@/lib/cotizador/tipos';

export type OpcionesCalculo = {
  tasaIva?: number;
  bordadoEspecial?: boolean;
};

// Medio hacia arriba. `Math.round` ya lo hace para positivos, y aquí no hay
// negativos: un precio o una cantidad negativos se rechazan antes de llegar.
function redondear(valor: number): number {
  return Math.round(valor);
}

export function calcular(
  entradas: LineaEntrada[],
  skus: Sku[],
  opciones: OpcionesCalculo = {},
): Cotizacion {
  const tasaIva = opciones.tasaIva ?? IVA_GENERAL;
  const porId = new Map(skus.map((s) => [s.id, s]));

  // Se fusionan las entradas repetidas antes de calcular. Si el mismo SKU
  // llega dos veces con 12 y 12, son 24 para el descuento: tratarlas como dos
  // líneas de 12 dejaría al cliente sin el 5% que le corresponde.
  const cantidades = new Map<string, number>();
  const orden: string[] = [];
  for (const entrada of entradas) {
    if (!porId.has(entrada.skuId)) {
      throw new Error(`SKU desconocido en el catálogo: ${entrada.skuId}`);
    }
    if (!Number.isInteger(entrada.cantidad) || entrada.cantidad <= 0) {
      throw new Error(
        `Cantidad inválida para ${entrada.skuId}: ${entrada.cantidad}. Debe ser un entero positivo.`,
      );
    }
    if (!cantidades.has(entrada.skuId)) orden.push(entrada.skuId);
    cantidades.set(entrada.skuId, (cantidades.get(entrada.skuId) ?? 0) + entrada.cantidad);
  }

  // Total por grupo. Es lo que define el escalón: las cantidades acumulan
  // dentro del grupo y nunca entre grupos.
  const porGrupo = new Map<GrupoDescuento, number>();
  for (const [skuId, cantidad] of cantidades) {
    const grupo = porId.get(skuId)!.grupo;
    porGrupo.set(grupo, (porGrupo.get(grupo) ?? 0) + cantidad);
  }

  const lineas: LineaCalculada[] = [];
  let subtotal = 0;
  let bruto = 0;

  for (const skuId of orden) {
    const sku = porId.get(skuId)!;
    const cantidad = cantidades.get(skuId)!;
    const escala = ESCALAS[sku.grupo];
    const totalDelGrupo = porGrupo.get(sku.grupo)!;
    const escalon = escalonDe(totalDelGrupo, escala);

    // El redondeo va sobre el unitario, no sobre el total de la línea: la
    // cotización imprime ambos, y si se redondeara el total, el unitario
    // impreso por la cantidad no daría el total impreso.
    const precioUnitario = redondear(sku.precioLista * (1 - escalon.pct / 100));
    const subtotalLinea = precioUnitario * cantidad;

    lineas.push({
      skuId: sku.id,
      nombre: sku.nombre,
      contenido: sku.contenido,
      cantidad,
      precioLista: sku.precioLista,
      descuentoPct: escalon.pct,
      precioUnitario,
      subtotal: subtotalLinea,
      grupo: sku.grupo,
      motivo:
        escalon.pct === 0
          ? `${totalDelGrupo} ${escala.unidad} en ${escala.etiqueta} → sin descuento`
          : `${totalDelGrupo} ${escala.unidad} en ${escala.etiqueta} → ${escalon.pct}%`,
    });

    subtotal += subtotalLinea;
    bruto += sku.precioLista * cantidad;
  }

  const iva = redondear(subtotal * tasaIva);

  return {
    lineas,
    subtotal,
    ahorro: bruto - subtotal,
    tasaIva,
    iva,
    total: subtotal + iva,
    bordadoEspecial: opciones.bordadoEspecial ?? false,
  };
}
```

- [ ] **Paso 4: Ejecutar y ver que pasa**

Ejecutar: `npx vitest run tests/cotizador-calcular.test.ts`
Esperado: PASA, 17 pruebas.

- [ ] **Paso 5: Ejecutar la suite completa**

Ejecutar: `npm test`
Esperado: todo verde. Nada de lo anterior se tocó, así que ninguna prueba existente debe
cambiar de estado.

- [ ] **Paso 6: Commit**

```bash
git add lib/cotizador/calcular.ts tests/cotizador-calcular.test.ts
git commit -m "feat(cotizador): motor de calculo con descuento por grupo"
```

---

### Tarea 4: Catálogo de 70 SKUs

**Archivos:**
- Crear: `scripts/generar-catalogo.mjs`
- Crear: `lib/cotizador/catalogo.ts` (generado, luego commiteado)
- Test: `tests/cotizador-catalogo.test.ts`

**Interfaces:**
- Consume: los tipos de la Tarea 2 y los `.xlsx` de `precios/`.
- Produce: `CATALOGO: Sku[]` con 70 entradas, y `buscarSku(id: string): Sku | undefined`.

El catálogo se **genera** desde los `.xlsx` en vez de transcribirse a mano: 70 precios
copiados a dedo es una errata garantizada. El `.ts` generado se commitea y es la fuente de
verdad; el script existe para la próxima lista de precios.

Las cuatro correcciones de `precios/README.md` se aplican explícitamente en el script.

- [ ] **Paso 1: Escribir el generador**

```javascript
// scripts/generar-catalogo.mjs
// Genera lib/cotizador/catalogo.ts desde precios/*.xlsx.
// Requiere: pip3 install openpyxl (solo para desarrollo, no es dependencia del proyecto).
// Ejecutar: node scripts/generar-catalogo.mjs
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const PY = `
import json, openpyxl
u = openpyxl.load_workbook("precios/uniformes-2026.xlsx", data_only=True).worksheets[0]
c = openpyxl.load_workbook("precios/ropa-de-cama-2026.xlsx", data_only=True).worksheets[0]
def celdas(ws):
    return [[ws.cell(r,col).value for col in range(1,5)] for r in range(1, ws.max_row+1)]
print(json.dumps({"uniformes": celdas(u), "cama": celdas(c)}))
`;
const datos = JSON.parse(execFileSync('python3', ['-c', PY], { encoding: 'utf8' }));

const slug = (s) =>
  s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const skus = [];

// --- Uniformes: filas 7 a 28, un grupo único ---
for (const [nombre, lista] of datos.uniformes.slice(6, 28).map((f) => [f[0], f[1]])) {
  if (typeof lista !== 'number') continue;
  const limpio = String(nombre).trim();
  skus.push({
    id: `uni-${slug(limpio)}`, linea: 'uniformes', grupo: 'uniformes',
    familia: 'Uniformes', nombre: limpio.toLowerCase(), precioLista: lista,
  });
}

// --- Ropa de cama ---
const CONTENIDO_2 = ['1 cubrecama', '1 sábana', '2 sobrefundas'];
const CONTENIDO_1 = ['1 cubrecama', '1 sábana', '1 sobrefunda'];
const contenidoDe = (talla) => (talla === 'imperial' ? CONTENIDO_1 : CONTENIDO_2);

const fila = (n) => datos.cama[n - 1];
const nom = (n) => String(fila(n)[0] ?? '').trim();
const precio = (n) => fila(n)[1];

// Sets: filas 7-10, 12-15, 17-20, 22-25. Familia por conteo de hilos.
for (const [hilos, desde] of [[600, 7], [400, 12], [300, 17], [200, 22]]) {
  for (let r = desde; r < desde + 4; r++) {
    const talla = nom(r);
    skus.push({
      id: `set-${hilos}-${talla}`, linea: 'hogar', grupo: 'sets-cama',
      familia: `Sets de cama ${hilos} hilos`,
      nombre: `set de ${hilos} hilos ${talla}`, talla,
      precioLista: precio(r), contenido: contenidoDe(talla),
    });
  }
}

// Fundas e insertos: filas 28-31, 33-36, 38-41, 43-46. Un solo grupo.
for (const [familia, desde] of [
  ['Fundas de duvet 300 hilos', 28], ['Fundas de duvet rayadas 200 hilos', 33],
  ['Insertos de duvet', 38], ['Pillow tops', 43],
]) {
  for (let r = desde; r < desde + 4; r++) {
    const nombre = nom(r);
    skus.push({
      id: slug(nombre), linea: 'hogar', grupo: 'fundas-insertos',
      familia, nombre, talla: nombre.split(' ').pop(), precioLista: precio(r),
    });
  }
}

// Toallas: 680gm filas 51-54, 460gm 58-61, 360gm 65-68.
// Se omiten las filas 55, 62 y 69: Luxe confirmó que la toalla de pie es una
// sola, sin gramaje. Se agrega aparte, más abajo.
for (const [gramaje, desde] of [[680, 51], [460, 58], [360, 65]]) {
  for (let r = desde; r < desde + 4; r++) {
    const nombre = nom(r);
    skus.push({
      id: `toalla-${gramaje}-${slug(nombre.replace('toalla de ', '').replace('toalla ', ''))}`,
      linea: 'hogar', grupo: 'toallas', familia: `Toallas ${gramaje} gm`,
      nombre: `${nombre} ${gramaje} gm`, precioLista: precio(r),
    });
  }
}
skus.push({
  id: 'toalla-de-pie', linea: 'hogar', grupo: 'toallas',
  familia: 'Toallas', nombre: 'toalla de pie', precioLista: 5000,
});

// Bata: fila 48. Grupo propio.
skus.push({
  id: 'bata-blanca', linea: 'hogar', grupo: 'bata', familia: 'Toallas',
  nombre: 'bata blanca talla única', precioLista: precio(48),
});

// Almohadas: filas 72-73. El precio es por paquete.
for (const r of [72, 73]) {
  const nombre = nom(r).replace(/\s+/g, ' ');
  skus.push({
    id: `almohada-${slug(nombre)}`, linea: 'hogar', grupo: 'almohadas',
    familia: 'Almohadas', nombre, precioLista: precio(r),
  });
}

// --- Correcciones confirmadas por Luxe, posteriores al archivo ---
// Detalle en precios/README.md. El archivo trae la facial y la de mano
// invertidas en 680gm; con la corrección la facial queda más barata que la de
// mano en los tres gramajes, que es el patrón coherente.
const corregir = (id, precioLista) => {
  const sku = skus.find((s) => s.id === id);
  if (!sku) throw new Error(`No se encontró para corregir: ${id}`);
  sku.precioLista = precioLista;
};
corregir('toalla-680-facial', 3000);
corregir('toalla-680-mano', 3500);

if (skus.length !== 70) {
  throw new Error(`Se esperaban 70 SKUs y salieron ${skus.length}`);
}

const cabecera = `// GENERADO por scripts/generar-catalogo.mjs desde precios/*.xlsx.
// No editar a mano: la próxima regeneración lo pisa. Para cambiar un precio,
// se corrige el .xlsx (o el bloque de correcciones del script) y se regenera.
//
// Incluye las correcciones que Luxe confirmó por escrito y que no están en el
// archivo. Ver precios/README.md antes de cargar una lista nueva.
import type { Sku } from '@/lib/cotizador/tipos';

export const CATALOGO: Sku[] = `;

const pie = `;

const PORID = new Map(CATALOGO.map((s) => [s.id, s]));

export function buscarSku(id: string): Sku | undefined {
  return PORID.get(id);
}
`;

writeFileSync('lib/cotizador/catalogo.ts', cabecera + JSON.stringify(skus, null, 2) + pie);
console.log(`Escritos ${skus.length} SKUs en lib/cotizador/catalogo.ts`);
```

- [ ] **Paso 2: Escribir la prueba de integridad**

```typescript
// tests/cotizador-catalogo.test.ts
import { describe, it, expect } from 'vitest';
import { CATALOGO, buscarSku } from '@/lib/cotizador/catalogo';
import { ESCALAS } from '@/lib/cotizador/escalas';
import { GRUPOS, TALLAS, LINEAS_CATALOGO } from '@/lib/cotizador/tipos';

describe('CATALOGO', () => {
  it('tiene los 70 SKUs', () => {
    expect(CATALOGO).toHaveLength(70);
  });

  it('reparte los SKUs por grupo como confirmó Luxe', () => {
    const conteo: Record<string, number> = {};
    for (const s of CATALOGO) conteo[s.grupo] = (conteo[s.grupo] ?? 0) + 1;
    expect(conteo).toEqual({
      uniformes: 22,
      'sets-cama': 16,
      'fundas-insertos': 16,
      toallas: 13,
      bata: 1,
      almohadas: 2,
    });
  });

  it('no repite ids', () => {
    const ids = CATALOGO.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('usa solo grupos, líneas y tallas conocidos', () => {
    for (const s of CATALOGO) {
      expect(GRUPOS).toContain(s.grupo);
      expect(LINEAS_CATALOGO).toContain(s.linea);
      if (s.talla) expect(TALLAS).toContain(s.talla);
      expect(ESCALAS[s.grupo]).toBeDefined();
    }
  });

  it('tiene precios enteros y positivos', () => {
    for (const s of CATALOGO) {
      expect(Number.isInteger(s.precioLista)).toBe(true);
      expect(s.precioLista).toBeGreaterThan(0);
    }
  });

  it('desglosa el contenido de todos los sets de cama y de nada más', () => {
    for (const s of CATALOGO) {
      if (s.grupo === 'sets-cama') expect(s.contenido?.length).toBeGreaterThan(0);
      else expect(s.contenido).toBeUndefined();
    }
  });

  it('da 1 sobrefunda a imperial y 2 al resto', () => {
    for (const s of CATALOGO.filter((x) => x.grupo === 'sets-cama')) {
      const esperado = s.talla === 'imperial' ? '1 sobrefunda' : '2 sobrefundas';
      expect(s.contenido).toContain(esperado);
    }
  });

  it('lleva las correcciones que Luxe confirmó después del archivo', () => {
    expect(buscarSku('toalla-680-facial')!.precioLista).toBe(3000);
    expect(buscarSku('toalla-680-mano')!.precioLista).toBe(3500);
    expect(buscarSku('toalla-de-pie')!.precioLista).toBe(5000);
  });

  it('tiene una sola toalla de pie', () => {
    const pies = CATALOGO.filter((s) => s.nombre.includes('toalla de pie'));
    expect(pies).toHaveLength(1);
  });

  it('mantiene la facial más barata que la de mano en los tres gramajes', () => {
    for (const g of [680, 460, 360]) {
      const facial = buscarSku(`toalla-${g}-facial`)!;
      const mano = buscarSku(`toalla-${g}-mano`)!;
      expect(facial.precioLista).toBeLessThan(mano.precioLista);
    }
  });

  it('conserva precios de referencia del archivo', () => {
    expect(buscarSku('set-600-king')!.precioLista).toBe(90000);
    expect(buscarSku('inserto-de-duvet-king')!.precioLista).toBe(75000);
    expect(buscarSku('bata-blanca')!.precioLista).toBe(25000);
  });

  it('buscarSku devuelve undefined para un id inexistente', () => {
    expect(buscarSku('no-existe')).toBeUndefined();
  });
});
```

- [ ] **Paso 3: Ejecutar el generador**

Ejecutar: `python3 -c "import openpyxl" || pip3 install openpyxl`
Ejecutar: `node scripts/generar-catalogo.mjs`
Esperado: `Escritos 70 SKUs en lib/cotizador/catalogo.ts`

Si dice un número distinto de 70, el script lanza. Comparar los índices de fila del script
contra el `.xlsx` — probablemente Luxe insertó o quitó una fila.

- [ ] **Paso 4: Ejecutar las pruebas**

Ejecutar: `npx vitest run tests/cotizador-catalogo.test.ts`
Esperado: PASA, 12 pruebas.

- [ ] **Paso 5: Revisar el catálogo a ojo**

Ejecutar: `head -40 lib/cotizador/catalogo.ts`

Confirmar que los nombres se leen bien para un cliente. En particular, que los sets digan
"set de 600 hilos king" y no "sábana": es el hallazgo que motivó media ronda de preguntas.

- [ ] **Paso 6: Commit**

```bash
git add scripts/generar-catalogo.mjs lib/cotizador/catalogo.ts tests/cotizador-catalogo.test.ts
git commit -m "feat(cotizador): catalogo de 70 SKUs generado desde las listas de precios"
```

---

### Tarea 5: Migración de la tabla

**Archivos:**
- Crear: `supabase/migrations/0005_cotizaciones.sql`

**Interfaces:**
- Produce: la tabla `public.cotizaciones`, que consumen las Tareas 6 y 9.

- [ ] **Paso 1: Escribir la migración**

```sql
-- supabase/migrations/0005_cotizaciones.sql
-- Registro de cotizaciones. NO es la fuente de verdad del estado comercial:
-- eso vive en GoHighLevel. Aquí queda la auditoría (qué precios se enviaron y
-- cuándo) y la cola de borradores que deja el agente.

create table if not exists public.cotizaciones (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  origen          text not null check (origen in ('humano', 'agente')),
  estado          text not null check (estado in ('borrador', 'enviada', 'error')),

  contact_id      text,
  cliente         jsonb not null,
  -- El resultado del cálculo, no una referencia al catálogo. Una cotización de
  -- hace tres meses tiene que reimprimirse con los precios de ese día.
  lineas          jsonb not null,
  totales         jsonb not null,

  ghl_estimate_id text,
  ghl_error       text
);

-- La pantalla lista los borradores pendientes primero, y es la única consulta
-- que corre en cada carga.
create index if not exists cotizaciones_estado_fecha_idx
  on public.cotizaciones (estado, created_at desc);

alter table public.cotizaciones enable row level security;

-- Sin políticas: solo el service role escribe y lee, desde el servidor. Mismo
-- criterio que public.leads.
```

- [ ] **Paso 2: Aplicar la migración**

Ejecutar: `npm run db:migrate`
Esperado: aplica `0005_cotizaciones.sql` sin error.

- [ ] **Paso 3: Verificar que la tabla existe**

Ejecutar:
```bash
node --env-file=.env.local -e "
import('@supabase/supabase-js').then(async ({createClient}) => {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { error } = await db.from('cotizaciones').select('id').limit(1);
  console.log(error ? 'ERROR: ' + error.message : 'tabla cotizaciones accesible');
});"
```
Esperado: `tabla cotizaciones accesible`

- [ ] **Paso 4: Commit**

```bash
git add supabase/migrations/0005_cotizaciones.sql
git commit -m "feat(cotizador): tabla de cotizaciones"
```

---

### Tarea 6: Validación y endpoint

**Archivos:**
- Modificar: `lib/validation.ts`
- Crear: `app/api/cotizacion/route.ts`
- Test: `tests/api-cotizacion.test.ts`

**Interfaces:**
- Consume: `calcular` (Tarea 3), `CATALOGO` (Tarea 4), la tabla (Tarea 5).
- Produce: `cotizacionSchema` y `CotizacionInput` en `lib/validation.ts`; endpoint
  `POST /api/cotizacion`.

En esta tarea el endpoint **guarda en Supabase y devuelve el cálculo**, sin tocar
GoHighLevel. La Tarea 7 le agrega el Estimate. Así se puede probar el camino completo
antes de escribir en el CRM.

- [ ] **Paso 1: Escribir la prueba que falla**

```typescript
// tests/api-cotizacion.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const insertado: unknown[] = [];
vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      insert: (fila: unknown) => {
        insertado.push(fila);
        return {
          select: () => ({
            single: async () => ({ data: { id: 'cot-1', ...(fila as object) }, error: null }),
          }),
        };
      },
    }),
  }),
}));

const { POST } = await import('@/app/api/cotizacion/route');

function peticion(cuerpo: unknown) {
  return new Request('http://localhost/api/cotizacion', {
    method: 'POST',
    body: JSON.stringify(cuerpo),
  });
}

const valido = {
  clave: 'secreta',
  cliente: { nombre: 'Ana Pérez', empresa: 'Hotel Papagayo', email: 'ana@hotel.com' },
  lineas: [{ skuId: 'set-600-king', cantidad: 16 }],
};

describe('POST /api/cotizacion', () => {
  beforeEach(() => {
    insertado.length = 0;
    process.env.LUXE_TALLER_CLAVE = 'secreta';
  });

  it('rechaza sin clave', async () => {
    const res = await POST(peticion({ ...valido, clave: 'otra' }));
    expect(res.status).toBe(401);
  });

  it('rechaza un cuerpo que no es JSON', async () => {
    const res = await POST(
      new Request('http://localhost/api/cotizacion', { method: 'POST', body: 'no soy json' }),
    );
    expect(res.status).toBe(400);
  });

  it('rechaza un correo inválido', async () => {
    const res = await POST(peticion({ ...valido, cliente: { ...valido.cliente, email: 'roto' } }));
    expect(res.status).toBe(400);
  });

  it('rechaza una cotización sin líneas', async () => {
    const res = await POST(peticion({ ...valido, lineas: [] }));
    expect(res.status).toBe(400);
  });

  it('rechaza un sku que no existe', async () => {
    const res = await POST(peticion({ ...valido, lineas: [{ skuId: 'fantasma', cantidad: 1 }] }));
    expect(res.status).toBe(400);
  });

  it('devuelve el cálculo y guarda la fila', async () => {
    const res = await POST(peticion(valido));
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.ok).toBe(true);
    expect(cuerpo.cotizacion.lineas[0].descuentoPct).toBe(10);
    expect(insertado).toHaveLength(1);
  });

  it('acepta una tasa de IVA distinta', async () => {
    const res = await POST(peticion({ ...valido, tasaIva: 0.01 }));
    const cuerpo = await res.json();
    expect(cuerpo.cotizacion.tasaIva).toBe(0.01);
  });
});
```

- [ ] **Paso 2: Ejecutar y ver que falla**

Ejecutar: `npx vitest run tests/api-cotizacion.test.ts`
Esperado: FALLA — no existe `@/app/api/cotizacion/route`.

- [ ] **Paso 3: Añadir el esquema a `lib/validation.ts`**

```typescript
// Añadir al final de lib/validation.ts
import { z } from 'zod';

export const cotizacionSchema = z.object({
  clave: z.string().min(1),
  cliente: z.object({
    nombre: z.string().trim().min(1).max(120),
    empresa: z.string().trim().max(120).optional(),
    email: z.string().trim().pipe(z.email('Escribe un correo válido.')),
  }),
  lineas: z
    .array(
      z.object({
        skuId: z.string().min(1),
        cantidad: z.number().int().positive(),
      }),
    )
    .min(1),
  // Por defecto la tasa general. Se permite cualquier tasa entre 0 y 13%:
  // Costa Rica tiene reducidas, y Luxe todavía confirma cuáles le aplican.
  tasaIva: z.number().min(0).max(0.13).optional(),
  bordadoEspecial: z.boolean().optional(),
});

export type CotizacionInput = z.infer<typeof cotizacionSchema>;
```

- [ ] **Paso 4: Escribir el endpoint**

```typescript
// app/api/cotizacion/route.ts
import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { cotizacionSchema } from '@/lib/validation';
import { calcular } from '@/lib/cotizador/calcular';
import { CATALOGO } from '@/lib/cotizador/catalogo';
import { supabaseAdmin } from '@/lib/supabase/server';

export const runtime = 'nodejs';

// Mismo criterio que app/api/q7m4/route.ts: comparación en tiempo constante.
function claveValida(recibida: string): boolean {
  const esperada = process.env.LUXE_TALLER_CLAVE;
  if (!esperada) return false;
  const a = Buffer.from(recibida);
  const b = Buffer.from(esperada);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  let crudo: unknown;
  try {
    crudo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  const parseado = cotizacionSchema.safeParse(crudo);
  if (!parseado.success) {
    return NextResponse.json(
      { ok: false, error: parseado.error.issues[0]?.message ?? 'Datos inválidos.' },
      { status: 400 },
    );
  }
  const datos = parseado.data;

  if (!claveValida(datos.clave)) {
    return NextResponse.json({ ok: false, error: 'Clave incorrecta.' }, { status: 401 });
  }

  // `calcular` lanza si un SKU no existe o la cantidad es absurda. Eso es un
  // error del cliente, no del servidor: se traduce a 400 en vez de dejar que
  // reviente en 500.
  let cotizacion;
  try {
    cotizacion = calcular(datos.lineas, CATALOGO, {
      tasaIva: datos.tasaIva,
      bordadoEspecial: datos.bordadoEspecial,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'No se pudo calcular.' },
      { status: 400 },
    );
  }

  // Primero la base, después GoHighLevel (Tarea 7). Si el CRM falla, la
  // cotización sigue existiendo y es recuperable; al revés, el cliente tendría
  // una cotización que Luxe no registró.
  const { data, error } = await supabaseAdmin()
    .from('cotizaciones')
    .insert({
      origen: 'humano',
      estado: 'borrador',
      cliente: datos.cliente,
      lineas: cotizacion.lineas,
      totales: {
        subtotal: cotizacion.subtotal,
        ahorro: cotizacion.ahorro,
        tasaIva: cotizacion.tasaIva,
        iva: cotizacion.iva,
        total: cotizacion.total,
      },
    })
    .select()
    .single();

  if (error) {
    console.error('[cotizador] No se pudo guardar la cotización.', error.message);
    return NextResponse.json({ ok: false, error: 'No se pudo guardar.' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, id: data.id, cotizacion });
}
```

- [ ] **Paso 5: Ejecutar y ver que pasa**

Ejecutar: `npx vitest run tests/api-cotizacion.test.ts`
Esperado: PASA, 7 pruebas.

- [ ] **Paso 6: Suite completa y commit**

Ejecutar: `npm test`
Esperado: todo verde.

```bash
git add lib/validation.ts app/api/cotizacion/route.ts tests/api-cotizacion.test.ts
git commit -m "feat(cotizador): endpoint de calculo y registro"
```

---

### Tarea 7: Estimate en GoHighLevel

**Archivos:**
- Crear: `lib/cotizador/ghl.ts`
- Modificar: `app/api/cotizacion/route.ts`
- Test: `tests/cotizador-ghl.test.ts`

**Interfaces:**
- Consume: `Cotizacion` (Tarea 2), `docs/ghl-estimate-payload.md` (Tarea 1).
- Produce: `crearEstimate(p: ParamsEstimate, deps: DepsGhl): Promise<ResultadoEstimate>`
  con `ResultadoEstimate = { ok: true; estimateId: string; contactId: string; opportunityError?: string } | { ok: false; error: string }`.

> **Leer `docs/ghl-estimate-payload.md` antes de empezar.** La Tarea 1 sondeó la API real y
> encontró tres cosas que cambian este diseño:
>
> 1. **GoHighLevel recalcula los totales** a partir de `amount`, `qty`, `discount` y
>    `taxes`, y produce decimales (`333 × 1,13 = 376,29`). Delegarle el IVA o el descuento
>    haría que el total que ve el cliente no coincida con el de nuestro motor.
>    **Por eso el descuento va siempre en cero y el IVA viaja como una línea más**, con el
>    monto entero que ya calculó `calcular`. GoHighLevel solo suma; no decide nada.
> 2. **`contactDetails.id` es obligatorio** y la API no valida que el contacto exista. Usar
>    un id inventado crearía cotizaciones huérfanas, sin contacto al que hacerle
>    seguimiento — que es justo lo que este proyecto existe para lograr. Por eso, cuando no
>    llega un `contactId`, se resuelve dando de alta el contacto primero.
> 3. `title`, `frequencySettings.enabled` e `items[].type` son obligatorios, y el único
>    valor válido de `type` es `one_time` (`service` da 422).

- [ ] **Paso 1: Escribir la prueba que falla**

```typescript
// tests/cotizador-ghl.test.ts
import { describe, it, expect, vi } from 'vitest';
import { crearEstimate } from '@/lib/cotizador/ghl';
import type { Cotizacion } from '@/lib/cotizador/tipos';

const cotizacion: Cotizacion = {
  lineas: [
    {
      skuId: 'set-600-king', nombre: 'set de 600 hilos king',
      contenido: ['1 cubrecama', '1 sábana', '2 sobrefundas'],
      cantidad: 16, precioLista: 90000, descuentoPct: 10,
      precioUnitario: 81000, subtotal: 1296000, grupo: 'sets-cama',
      motivo: '16 sets en Sets de cama → 10%',
    },
  ],
  subtotal: 1296000, ahorro: 144000, tasaIva: 0.13, iva: 168480,
  total: 1464480, bordadoEspecial: false,
};

const params = {
  cotizacion,
  cliente: { nombre: 'Ana Pérez', empresa: 'Hotel Papagayo', email: 'ana@hotel.com' },
  contactId: 'contacto-1',
};
const deps = { apiKey: 'llave', locationId: 'ubicacion' };

function respuesta(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('crearEstimate', () => {
  it('deja el descuento en cero y manda el IVA como línea aparte', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(respuesta({ _id: 'est-1' }))
      .mockResolvedValueOnce(respuesta({ id: 'opp-1' }));
    await crearEstimate(params, { ...deps, fetchImpl });
    const cuerpo = JSON.parse(fetchImpl.mock.calls[0][1].body);

    // GoHighLevel recalcula: si le delegáramos el descuento o el IVA, el total
    // que ve el cliente no coincidiría con el que calculó nuestro motor.
    expect(cuerpo.discount).toEqual({ type: 'percentage', value: 0 });
    expect(cuerpo.items.some((i: { taxes?: unknown }) => i.taxes)).toBe(false);

    const iva = cuerpo.items[cuerpo.items.length - 1];
    expect(iva.name).toBe('IVA 13%');
    expect(iva.amount).toBe(168480);
    expect(iva.qty).toBe(1);
  });

  it('omite la línea de IVA cuando el cliente está exento', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(respuesta({ _id: 'est-1' }))
      .mockResolvedValueOnce(respuesta({ id: 'opp-1' }));
    const exento = { ...cotizacion, tasaIva: 0, iva: 0, total: cotizacion.subtotal };
    await crearEstimate({ ...params, cotizacion: exento }, { ...deps, fetchImpl });
    const cuerpo = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(cuerpo.items).toHaveLength(1);
    expect(cuerpo.items[0].name).not.toMatch(/IVA/);
  });

  it('manda los campos que la API exige', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(respuesta({ _id: 'est-1' }))
      .mockResolvedValueOnce(respuesta({ id: 'opp-1' }));
    await crearEstimate(params, { ...deps, fetchImpl });
    const cuerpo = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(cuerpo.title).toBeTruthy();
    expect(cuerpo.frequencySettings).toEqual({ enabled: false });
    expect(cuerpo.contactDetails.id).toBe('contacto-1');
    for (const item of cuerpo.items) expect(item.type).toBe('one_time');
  });

  it('da de alta el contacto cuando no llega uno', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(respuesta({ contact: { id: 'nuevo-1' } }))
      .mockResolvedValueOnce(respuesta({ _id: 'est-1' }))
      .mockResolvedValueOnce(respuesta({ id: 'opp-1' }));
    const r = await crearEstimate({ ...params, contactId: undefined }, { ...deps, fetchImpl });

    expect(fetchImpl.mock.calls[0][0]).toContain('/contacts/upsert');
    const cuerpoEstimate = JSON.parse(fetchImpl.mock.calls[1][1].body);
    // Un id inventado crearía una cotización huérfana, sin contacto al que
    // hacerle seguimiento.
    expect(cuerpoEstimate.contactDetails.id).toBe('nuevo-1');
    expect(r).toEqual({ ok: true, estimateId: 'est-1', contactId: 'nuevo-1' });
  });

  it('no crea el estimate si falla el alta del contacto', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ message: 'duplicado' }, 400));
    const r = await crearEstimate({ ...params, contactId: undefined }, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('devuelve el id del estimate creado', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(respuesta({ _id: 'est-1' }))
      .mockResolvedValueOnce(respuesta({ id: 'opp-1' }));
    const r = await crearEstimate(params, { ...deps, fetchImpl });
    expect(r).toEqual({ ok: true, estimateId: 'est-1', contactId: 'contacto-1' });
  });

  it('manda los montos en colones enteros', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(respuesta({ _id: 'est-1' }))
      .mockResolvedValueOnce(respuesta({ id: 'opp-1' }));
    await crearEstimate(params, { ...deps, fetchImpl });
    const cuerpo = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(cuerpo.currency).toBe('CRC');
    expect(cuerpo.items[0].amount).toBe(81000);
    expect(cuerpo.items[0].qty).toBe(16);
    expect(Number.isInteger(cuerpo.items[0].amount)).toBe(true);
  });

  it('nunca menciona método de pago', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(respuesta({ _id: 'est-1' }))
      .mockResolvedValueOnce(respuesta({ id: 'opp-1' }));
    await crearEstimate(params, { ...deps, fetchImpl });
    const cuerpo = fetchImpl.mock.calls[0][1].body as string;
    expect(cuerpo).not.toMatch(/paymentMethod|pasarela|payNow/i);
    // `discount` sí aparece, pero en cero: se comprueba en su propia prueba.
  });

  it('desglosa el contenido del set en la descripción', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(respuesta({ _id: 'est-1' }))
      .mockResolvedValueOnce(respuesta({ id: 'opp-1' }));
    await crearEstimate(params, { ...deps, fetchImpl });
    const cuerpo = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(cuerpo.items[0].description).toContain('1 cubrecama');
    expect(cuerpo.items[0].description).toContain('2 sobrefundas');
  });

  it('incluye la nota del bordado', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(respuesta({ _id: 'est-1' }))
      .mockResolvedValueOnce(respuesta({ id: 'opp-1' }));
    await crearEstimate(params, { ...deps, fetchImpl });
    const cuerpo = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(cuerpo.termsNotes).toMatch(/10 ?x ?10/);
  });

  it('devuelve el error de GoHighLevel sin lanzar', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ message: 'no autorizado' }, 401));
    const r = await crearEstimate(params, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('401');
  });

  it('no lanza si se cae la red', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const r = await crearEstimate(params, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('ECONNRESET');
  });

  it('un fallo de la Opportunity no invalida el estimate', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(respuesta({ _id: 'est-1' }))
      .mockResolvedValueOnce(respuesta({ message: 'pipeline no existe' }, 404));
    const r = await crearEstimate(params, { ...deps, fetchImpl });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.opportunityError).toContain('404');
  });
});
```

- [ ] **Paso 2: Ejecutar y ver que falla**

Ejecutar: `npx vitest run tests/cotizador-ghl.test.ts`
Esperado: FALLA — no existe `@/lib/cotizador/ghl`.

- [ ] **Paso 3: Escribir el adaptador**

```typescript
// lib/cotizador/ghl.ts
import type { Cotizacion } from '@/lib/cotizador/tipos';

const BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';

// Pipeline y etapa verificados contra la location el 2026-08-26.
const PIPELINE = 'vr8WB783pg2FsTQj6LiG';
const ETAPA_PROPUESTA = 'Proposal Sent';

// Nota fija en toda cotización. Luxe: "se incluye un bordado de máximo 10x10 cm
// a un color. más grande o con colores los precios varían según muestra."
const NOTA_BORDADO =
  'Incluye bordado de hasta 10x10 cm a un color. Bordados de mayor tamaño o a varios colores se cotizan por separado según muestra.';
const NOTA_PRECIOS = 'Precios en colones. El IVA se detalla por separado.';

export type ParamsEstimate = {
  cotizacion: Cotizacion;
  cliente: { nombre: string; empresa?: string; email: string };
  contactId?: string;
};

export type DepsGhl = { apiKey: string; locationId: string; fetchImpl?: typeof fetch };

export type ResultadoEstimate =
  | { ok: true; estimateId: string; contactId: string; opportunityError?: string }
  | { ok: false; error: string };

function cabeceras(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Version: VERSION,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

// La API exige `contactDetails.id` no vacío pero NO valida que exista. Un id
// inventado produciría cotizaciones huérfanas, sin contacto al que hacerle
// seguimiento — justo lo contrario de lo que buscamos. Así que si no llega un
// contacto, se da de alta antes de cotizar.
async function resolverContacto(
  p: ParamsEstimate, deps: Required<DepsGhl>,
): Promise<{ ok: true; contactId: string } | { ok: false; error: string }> {
  if (p.contactId) return { ok: true, contactId: p.contactId };

  const partes = p.cliente.nombre.trim().split(/\s+/);
  try {
    const res = await deps.fetchImpl(`${BASE}/contacts/upsert`, {
      method: 'POST',
      headers: cabeceras(deps.apiKey),
      body: JSON.stringify({
        locationId: deps.locationId,
        firstName: partes[0] ?? '',
        lastName: partes.slice(1).join(' ') || undefined,
        email: p.cliente.email,
        companyName: p.cliente.empresa,
        source: 'Cotizador Luxe Essentials',
        tags: ['cotizacion'],
      }),
    });
    const texto = await res.text();
    if (!res.ok) return { ok: false, error: `GHL contacto ${res.status}: ${texto.slice(0, 200)}` };
    const datos = JSON.parse(texto) as { contact?: { id?: string }; id?: string };
    const id = datos.contact?.id ?? datos.id;
    if (!id) return { ok: false, error: `GHL creó el contacto sin devolver id: ${texto.slice(0, 200)}` };
    return { ok: true, contactId: id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Nunca lanza: un fallo moviendo la Opportunity no debe invalidar un Estimate
// que ya se creó bien. Devuelve el texto del error para registrarlo.
async function moverOportunidad(
  p: ParamsEstimate, contactId: string, deps: Required<DepsGhl>,
): Promise<string | undefined> {
  try {
    const res = await deps.fetchImpl(`${BASE}/opportunities/`, {
      method: 'POST',
      headers: cabeceras(deps.apiKey),
      body: JSON.stringify({
        pipelineId: PIPELINE,
        locationId: deps.locationId,
        name: `Cotización — ${p.cliente.empresa ?? p.cliente.nombre}`,
        pipelineStageName: ETAPA_PROPUESTA,
        status: 'open',
        contactId,
        monetaryValue: p.cotizacion.total,
      }),
    });
    if (!res.ok) return `GHL oportunidad ${res.status}: ${(await res.text()).slice(0, 200)}`;
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export async function crearEstimate(
  p: ParamsEstimate, deps: DepsGhl,
): Promise<ResultadoEstimate> {
  const { apiKey, locationId, fetchImpl = fetch } = deps;
  const completas = { apiKey, locationId, fetchImpl };

  const contacto = await resolverContacto(p, completas);
  if (!contacto.ok) return { ok: false, error: contacto.error };
  const contactId = contacto.contactId;

  const notas = [NOTA_PRECIOS, NOTA_BORDADO];
  if (p.cotizacion.bordadoEspecial) {
    notas.push('El bordado solicitado excede el estándar: el precio final se confirma contra muestra.');
  }

  const cuerpo = {
    altId: locationId,
    altType: 'location',
    // Obligatorio a nivel de esquema: sin `title` la API responde 500.
    title: `Cotización — ${p.cliente.empresa ?? p.cliente.nombre}`,
    name: `Cotización — ${p.cliente.empresa ?? p.cliente.nombre}`,
    currency: 'CRC',
    businessDetails: { name: 'Luxe Essentials' },
    contactDetails: {
      id: contactId,
      name: p.cliente.nombre,
      email: p.cliente.email,
      companyName: p.cliente.empresa,
    },
    items: [
      ...p.cotizacion.lineas.map((l) => ({
        name: l.nombre,
        // El desglose del set va aquí: sin él, un hotel lee "set de 600 hilos
        // king ₡90.000" y no sabe qué recibe por ese dinero.
        description: [
          l.contenido?.length ? `Incluye: ${l.contenido.join(', ')}.` : null,
          l.descuentoPct > 0 ? `Descuento aplicado: ${l.descuentoPct}%.` : null,
        ]
          .filter(Boolean)
          .join(' '),
        currency: 'CRC',
        // Ya descontado y redondeado por `calcular`. GoHighLevel no descuenta.
        amount: l.precioUnitario,
        qty: l.cantidad,
        type: 'one_time' as const,
      })),
      // El IVA viaja como una línea más, con el entero que calculó nuestro
      // motor. Si se declarara con `taxes`, GoHighLevel lo recalcularía y
      // produciría decimales: 333 x 1,13 da 376,29, y entonces el total que ve
      // el cliente deja de coincidir con el que Luxe cotizó.
      ...(p.cotizacion.iva > 0
        ? [
            {
              name: `IVA ${(p.cotizacion.tasaIva * 100).toFixed(0)}%`,
              description: 'Impuesto al valor agregado sobre el subtotal ya descontado.',
              currency: 'CRC',
              amount: p.cotizacion.iva,
              qty: 1,
              type: 'one_time' as const,
            },
          ]
        : []),
    ],
    // Fijo en cero a propósito. El descuento global de GoHighLevel se aplica a
    // TODAS las líneas, incluida la del IVA, así que usarlo descuadraría el
    // total. Los descuentos ya están dentro de cada `amount`.
    discount: { type: 'percentage' as const, value: 0 },
    // Obligatorio. Esta cotización no se repite.
    frequencySettings: { enabled: false },
    termsNotes: notas.join(' '),
  };

  let estimateId: string;
  try {
    const res = await fetchImpl(`${BASE}/invoices/estimate`, {
      method: 'POST',
      headers: cabeceras(apiKey),
      body: JSON.stringify(cuerpo),
    });
    const texto = await res.text();
    if (!res.ok) return { ok: false, error: `GHL estimate ${res.status}: ${texto.slice(0, 300)}` };

    const datos = JSON.parse(texto) as { _id?: string; id?: string };
    const id = datos._id ?? datos.id;
    if (!id) return { ok: false, error: `GHL respondió sin id: ${texto.slice(0, 300)}` };
    estimateId = id;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const opportunityError = await moverOportunidad(p, contactId, completas);
  return opportunityError
    ? { ok: true, estimateId, contactId, opportunityError }
    : { ok: true, estimateId, contactId };
}
```

- [ ] **Paso 4: Ejecutar y ver que pasa**

Ejecutar: `npx vitest run tests/cotizador-ghl.test.ts`
Esperado: PASA, 13 pruebas.

- [ ] **Paso 5: Conectar el endpoint**

En `app/api/cotizacion/route.ts`, después del `insert` que devolvió `data`, y antes del
`return` final, añadir:

```typescript
  const ghl = await crearEstimate(
    { cotizacion, cliente: datos.cliente, contactId: datos.contactId },
    {
      apiKey: process.env.LUXE_GHL_API_KEY ?? '',
      locationId: process.env.LUXE_GHL_LOCATION_ID ?? '',
    },
  );

  // El registro ya existe pase lo que pase. Aquí solo se anota cómo le fue al
  // CRM: una cotización con ghl_error es recuperable, igual que un lead.
  await supabaseAdmin()
    .from('cotizaciones')
    .update(
      ghl.ok
        ? { estado: 'enviada', ghl_estimate_id: ghl.estimateId, ghl_error: ghl.opportunityError ?? null }
        : { estado: 'error', ghl_error: ghl.error },
    )
    .eq('id', data.id);

  return NextResponse.json({
    ok: true,
    id: data.id,
    cotizacion,
    ghl: ghl.ok ? { estimateId: ghl.estimateId } : { error: ghl.error },
  });
```

Añadir el import al principio del archivo:
```typescript
import { crearEstimate } from '@/lib/cotizador/ghl';
```

Y añadir `contactId` al esquema en `lib/validation.ts`, dentro de `cotizacionSchema`:
```typescript
  contactId: z.string().min(1).optional(),
```

- [ ] **Paso 6: Actualizar la prueba del endpoint**

En `tests/api-cotizacion.test.ts`, añadir al principio del archivo, antes del `import` del
route:

```typescript
vi.mock('@/lib/cotizador/ghl', () => ({
  crearEstimate: vi.fn().mockResolvedValue({ ok: true, estimateId: 'est-1' }),
}));
```

Y extender el mock de Supabase para que soporte `update().eq()`:

```typescript
      update: () => ({ eq: async () => ({ error: null }) }),
```

Añadir una prueba:

```typescript
  it('devuelve el id del estimate de GoHighLevel', async () => {
    const res = await POST(peticion(valido));
    const cuerpo = await res.json();
    expect(cuerpo.ghl.estimateId).toBe('est-1');
  });
```

- [ ] **Paso 7: Suite completa y commit**

Ejecutar: `npm test`
Esperado: todo verde.

```bash
git add lib/cotizador/ghl.ts app/api/cotizacion/route.ts lib/validation.ts tests/cotizador-ghl.test.ts tests/api-cotizacion.test.ts
git commit -m "feat(cotizador): crea el Estimate y mueve la oportunidad en GoHighLevel"
```

---

### Tarea 8: Pantalla de armado

**Archivos:**
- Crear: `app/cotizador/page.tsx`
- Crear: `app/cotizador/Cotizador.tsx`
- Test: `tests/cotizador-ui.test.tsx`

**Interfaces:**
- Consume: `CATALOGO` (Tarea 4), `calcular` (Tarea 3), `POST /api/cotizacion` (Tarea 7).
- Produce: la ruta `/cotizador`.

El cálculo de la vista previa corre **en el cliente**, con la misma función pura que usa el
servidor. El servidor recalcula al recibir: nunca se confía en un total que llegó del
navegador.

**Cuidado con la tasa de IVA.** `calcular` lanza si la tasa no es un número finito entre 0
y 1 — se endureció al revisar la Tarea 3. Aquí no hay Zod de por medio, y un campo de
texto vacío da `parseFloat('') === NaN`. Si le pasás eso a `calcular`, la pantalla se cae
entera. El selector debe ofrecer valores fijos (13% y 0%) en vez de texto libre, y el
estado nunca debe contener algo que `calcular` rechace. Si algún día se acepta texto
libre, se normaliza antes de llamar: número inválido o vacío vuelve al 13% por defecto.

- [ ] **Paso 1: Escribir la prueba que falla**

```typescript
// tests/cotizador-ui.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Cotizador from '@/app/cotizador/Cotizador';

describe('Cotizador', () => {
  it('empieza sin líneas y con el total en cero', () => {
    render(<Cotizador />);
    expect(screen.getByText(/₡0/)).toBeInTheDocument();
  });

  it('filtra el catálogo al escribir en el buscador', async () => {
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await usuario.type(screen.getByLabelText(/buscar/i), 'inserto');
    expect(screen.getByText(/inserto de duvet king/i)).toBeInTheDocument();
    expect(screen.queryByText(/filipina/i)).not.toBeInTheDocument();
  });

  it('muestra el motivo del descuento al alcanzar el umbral', async () => {
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await usuario.type(screen.getByLabelText(/buscar/i), 'set de 600 hilos king');
    await usuario.click(screen.getByRole('button', { name: /agregar/i }));
    const cantidad = screen.getByLabelText(/cantidad/i);
    await usuario.clear(cantidad);
    await usuario.type(cantidad, '16');
    expect(screen.getByText(/16 sets en Sets de cama → 10%/)).toBeInTheDocument();
  });

  it('avisa cuando se marca bordado especial', async () => {
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await usuario.click(screen.getByLabelText(/bordado especial/i));
    expect(screen.getByText(/se confirma contra muestra/i)).toBeInTheDocument();
  });

  it('nunca le pasa al motor una tasa que lo haga lanzar', async () => {
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await usuario.type(screen.getByLabelText(/buscar/i), 'set de 600 hilos king');
    await usuario.click(screen.getByRole('button', { name: /agregar/i }));
    // El selector ofrece valores fijos: no hay forma de escribir una tasa
    // inválida. Si esto se convierte en texto libre, esta prueba debe cambiar
    // a comprobar la normalización — no borrarse.
    const iva = screen.getByLabelText(/iva/i);
    expect(iva.tagName).toBe('SELECT');
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
  });

  it('no deja enviar sin correo del cliente', async () => {
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await usuario.type(screen.getByLabelText(/buscar/i), 'set de 600 hilos king');
    await usuario.click(screen.getByRole('button', { name: /agregar/i }));
    expect(screen.getByRole('button', { name: /enviar cotización/i })).toBeDisabled();
  });
});
```

- [ ] **Paso 2: Ejecutar y ver que falla**

Ejecutar: `npx vitest run tests/cotizador-ui.test.tsx`
Esperado: FALLA — no existe `@/app/cotizador/Cotizador`.

- [ ] **Paso 3: Escribir la pantalla**

`app/cotizador/page.tsx`:
```tsx
import Cotizador from '@/app/cotizador/Cotizador';

// Ruta no enlazada desde ningún sitio, igual que /q7m4. La clave la pide el
// endpoint, no esta página: la protección real está en el servidor.
export const metadata = { robots: { index: false, follow: false } };

export default function Pagina() {
  return <Cotizador />;
}
```

`app/cotizador/Cotizador.tsx`: componente cliente (`'use client'`) con:

- Estado: `clave`, `cliente` (nombre, empresa, email), `lineas` (array de `{skuId, cantidad}`),
  `tasaIva`, `bordadoEspecial`, `enviando`, `resultado`.
- Un buscador (`<input>` con `aria-label="Buscar producto"`) que filtra `CATALOGO` por
  `nombre` y `familia`, sin distinguir mayúsculas ni tildes.
- Botón "Agregar" por cada resultado.
- Por cada línea: nombre, `<input type="number" aria-label="Cantidad">`, precio unitario,
  subtotal, y **el `motivo`** que devuelve `calcular`.
- Vista previa en vivo llamando a `calcular(lineas, CATALOGO, { tasaIva, bordadoEspecial })`
  en cada render.
- Bloque de totales: subtotal, ahorro, IVA, total. El total primero y el IVA abajo, como
  pidió Luxe.
- Casilla "Bordado especial (mayor a 10x10 cm o a varios colores)". Al marcarla, muestra
  el aviso "El precio final se confirma contra muestra."
- Selector de tasa de IVA con 13% por defecto.
- Botón "Enviar cotización", deshabilitado si no hay líneas o el correo está vacío.
  Hace `POST /api/cotizacion` con `clave`, `cliente`, `lineas`, `tasaIva`, `bordadoEspecial`.
- Muestra el `estimateId` devuelto, o el error.

Usar Tailwind, siguiendo el estilo de `app/q7m4/Taller.tsx`.

- [ ] **Paso 4: Ejecutar y ver que pasa**

Ejecutar: `npx vitest run tests/cotizador-ui.test.tsx`
Esperado: PASA, 6 pruebas.

- [ ] **Paso 5: Probar a mano**

Ejecutar: `npm run dev` y abrir `http://localhost:3000/cotizador`.

Comprobar: agregar 16 sets de 600 hilos king muestra "16 sets en Sets de cama → 10%" y un
unitario de ₡81.000. Cambiar a 15 lo baja al 5% y ₡85.500.

- [ ] **Paso 6: Suite completa y commit**

Ejecutar: `npm test`

```bash
git add app/cotizador tests/cotizador-ui.test.tsx
git commit -m "feat(cotizador): pantalla de armado"
```

---

### Tarea 9: El agente registra la intención de cotizar

Última a propósito: toca un sistema que hoy atiende a clientes reales.

**Archivos:**
- Modificar: `lib/agente/estado.ts`, `lib/agente/cerebro.ts`, `lib/agente/procesar.ts`
- Crear: `supabase/migrations/0006_agente_cantidad.sql`
- Test: `tests/agente-cerebro.test.ts` (existente), `tests/agente-estado.test.ts` (existente)

**Interfaces:**
- Consume: la tabla `cotizaciones` (Tarea 5).
- Produce: campo `cantidad` en `Datos`; y `registrarIntencion(p, db)` en
  `lib/cotizador/borrador.ts`, que inserta filas con `origen: 'agente'` y
  `estado: 'borrador'`.

**Qué es un borrador del agente, exactamente.** El agente captura texto libre
(`"unos 300 uniformes"`), no SKUs: no puede armar una cotización calculable, y fingir que
sí produciría filas con precios inventados. Lo que deja es **intención capturada** —quién
es el cliente, qué línea le interesa y cuánto pidió— para que un vendedor la convierta en
cotización real eligiendo los SKUs. Por eso la fila va con `lineas: []` y `totales: {}`.

**El prompt del agente NO cambia.** Sigue diciendo "nunca das precios, ni rangos de precio,
ni descuentos". El agente recoge la cantidad; no cotiza.

- [ ] **Paso 1: Añadir `cantidad` al esquema de la API en `cerebro.ts`**

En el objeto `ESQUEMA`, dentro de `datos.properties`, añadir:
```typescript
        cantidad: { type: ['string', 'null'] },
```
Y añadir `'cantidad'` al array `datos.required`.

> **Cuidado:** el comentario de `producto` en `cerebro.ts:22` advierte que la API rechaza
> `type: ['string','null']` combinado con `enum`. `cantidad` no lleva `enum`, así que la
> forma simple es correcta — igual que `nombre`, `email`, `telefono` y `ubicacion`.

- [ ] **Paso 2: Añadir `cantidad` al esquema de Zod en `cerebro.ts`**

En `salidaSchema.datos`, añadir:
```typescript
    cantidad: z.string().nullable(),
```

- [ ] **Paso 3: Añadir `cantidad` a `Datos` en `estado.ts`**

```typescript
export type Datos = {
  nombre: string | null;
  email: string | null;
  telefono: string | null;
  producto: Producto | null;
  ubicacion: string | null;
  cantidad: string | null;
};

export const DATOS_VACIOS: Datos = {
  nombre: null, email: null, telefono: null, producto: null, ubicacion: null, cantidad: null,
};
```

`fusionarDatos` recorre `Object.keys(DATOS_VACIOS)`, así que recoge el campo nuevo sin
cambios.

- [ ] **Paso 4: Añadir la etiqueta en `resumenParaNota` de `acciones.ts`**

```typescript
    producto: 'Producto de interés', ubicacion: 'Ubicación',
    cantidad: 'Cantidad estimada',
```

- [ ] **Paso 5: Escribir la migración**

```sql
-- supabase/migrations/0006_agente_cantidad.sql
-- `datos` es jsonb, así que no hace falta cambiar la columna. Se rellena el
-- campo nuevo en las filas existentes para que el agente no lea `undefined`
-- donde el código espera `null`.
update public.agente_conversaciones
   set datos = datos || '{"cantidad": null}'::jsonb
 where not (datos ? 'cantidad');
```

- [ ] **Paso 6: Escribir la prueba del registro de intención**

```typescript
// tests/cotizador-borrador.test.ts
import { describe, it, expect, vi } from 'vitest';
import { registrarIntencion } from '@/lib/cotizador/borrador';
import { DATOS_VACIOS } from '@/lib/agente/estado';

function db(filas: unknown[] = []) {
  const insertados: unknown[] = [];
  return {
    insertados,
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => ({ limit: async () => ({ data: filas, error: null }) }) }),
      }),
      insert: async (fila: unknown) => {
        insertados.push(fila);
        return { error: null };
      },
    }),
  };
}

const completos = {
  ...DATOS_VACIOS,
  nombre: 'Ana Pérez', email: 'ana@hotel.com',
  producto: 'uniformes' as const, cantidad: '300 piezas',
};

describe('registrarIntencion', () => {
  it('inserta el borrador cuando hay correo, producto y cantidad', async () => {
    const base = db();
    const error = await registrarIntencion({ contactId: 'c1', datos: completos }, base);
    expect(error).toBeUndefined();
    expect(base.insertados).toHaveLength(1);
    const fila = base.insertados[0] as Record<string, unknown>;
    expect(fila.origen).toBe('agente');
    expect(fila.estado).toBe('borrador');
    expect(fila.contact_id).toBe('c1');
    expect(fila.lineas).toEqual([]);
  });

  it('guarda la cantidad tal como la dijo el cliente', async () => {
    const base = db();
    await registrarIntencion({ contactId: 'c1', datos: completos }, base);
    const fila = base.insertados[0] as { cliente: Record<string, unknown> };
    expect(fila.cliente.cantidadTexto).toBe('300 piezas');
    expect(fila.cliente.producto).toBe('uniformes');
  });

  it('no inserta si falta la cantidad', async () => {
    const base = db();
    await registrarIntencion({ contactId: 'c1', datos: { ...completos, cantidad: null } }, base);
    expect(base.insertados).toHaveLength(0);
  });

  it('no inserta si falta el correo', async () => {
    const base = db();
    await registrarIntencion({ contactId: 'c1', datos: { ...completos, email: null } }, base);
    expect(base.insertados).toHaveLength(0);
  });

  it('no duplica si el contacto ya tiene un borrador abierto', async () => {
    const base = db([{ id: 'ya-existe' }]);
    await registrarIntencion({ contactId: 'c1', datos: completos }, base);
    expect(base.insertados).toHaveLength(0);
  });

  it('devuelve el error de base sin lanzar', async () => {
    const roto = {
      from: () => ({
        select: () => ({
          eq: () => ({ eq: () => ({ limit: async () => ({ data: null, error: { message: 'sin conexión' } }) }) }),
        }),
      }),
    };
    const error = await registrarIntencion({ contactId: 'c1', datos: completos }, roto);
    expect(error).toContain('sin conexión');
  });
});
```

- [ ] **Paso 7: Escribir `lib/cotizador/borrador.ts`**

```typescript
// lib/cotizador/borrador.ts
import type { Datos } from '@/lib/agente/estado';

// El mismo tipo laxo que usa lib/agente/estado.ts, por la misma razón: poder
// probar sin base de datos.
type Db = { from: (tabla: string) => any };

export type ParamsIntencion = { contactId: string; datos: Datos };

// Nunca lanza. Un fallo registrando la intención no debe tumbar el turno del
// agente: al cliente ya se le respondió, y deshacer eso no es posible.
// Devuelve el mensaje de error para que quien llama lo registre.
export async function registrarIntencion(
  p: ParamsIntencion, db: Db,
): Promise<string | undefined> {
  const { datos } = p;

  // Sin correo no hay a quién cotizar; sin producto ni cantidad no hay nada
  // que un vendedor pueda convertir. Se espera a tener las tres.
  if (!datos.email || !datos.producto || !datos.cantidad) return undefined;

  try {
    // Un contacto insistente genera varios turnos con los mismos datos. Sin
    // esta comprobación, la cola se llena de borradores idénticos del mismo
    // cliente y el vendedor no sabe cuál mirar.
    const { data, error } = await db
      .from('cotizaciones')
      .select('id')
      .eq('contact_id', p.contactId)
      .eq('estado', 'borrador')
      .limit(1);
    if (error) return `No se pudo consultar borradores: ${error.message}`;
    if (Array.isArray(data) && data.length > 0) return undefined;

    const { error: errorAlta } = await db.from('cotizaciones').insert({
      origen: 'agente',
      estado: 'borrador',
      contact_id: p.contactId,
      // La intención cruda, tal como la dijo el cliente. No se interpreta:
      // "unos 300" no es 300, y decidirlo es trabajo del vendedor.
      cliente: {
        nombre: datos.nombre,
        email: datos.email,
        telefono: datos.telefono,
        producto: datos.producto,
        cantidadTexto: datos.cantidad,
        ubicacion: datos.ubicacion,
      },
      lineas: [],
      totales: {},
    });
    if (errorAlta) return `No se pudo crear el borrador: ${errorAlta.message}`;
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
```

- [ ] **Paso 8: Conectar en `lib/agente/procesar.ts`**

Añadir el import:
```typescript
import { registrarIntencion } from '@/lib/cotizador/borrador';
```

Y justo después de la línea `const avisar = debeAvisar(fila, datos, turnos);`, añadir:

```typescript
  // Se registra en cada turno que cumpla las condiciones; `registrarIntencion`
  // se encarga de no duplicar. Va aquí y no dentro de `debeAvisar` porque las
  // condiciones son distintas: avisar necesita nombre y un contacto, cotizar
  // necesita además producto y cantidad.
  const errorBorrador = await registrarIntencion({ contactId, datos }, db);
  if (errorBorrador) console.error('[cotizador] borrador del agente:', errorBorrador);
```

- [ ] **Paso 9: Ejecutar las pruebas del agente**

Ejecutar: `npx vitest run tests/agente-cerebro.test.ts tests/agente-estado.test.ts tests/agente-acciones.test.ts tests/agente-procesar.test.ts`

Esperado: FALLAN las que comparan `Datos` completos, porque ahora tienen un campo más.
Actualizar esas aserciones añadiendo `cantidad: null`. **No cambiar la lógica de las
pruebas** — si una falla por otra razón, es un bug de esta tarea.

En `tests/agente-procesar.test.ts` hará falta que el `db` simulado soporte la cadena
`.from('cotizaciones').select().eq().eq().limit()`. Devolver `{ data: [], error: null }`.

- [ ] **Paso 10: Ejecutar la sonda del borrador y la suite**

Ejecutar: `npx vitest run tests/cotizador-borrador.test.ts`
Esperado: PASA, 6 pruebas.

Ejecutar: `npm run db:migrate`
Ejecutar: `npm test`
Esperado: todo verde.

- [ ] **Paso 11: Commit**

```bash
git add lib/agente lib/cotizador/borrador.ts supabase/migrations/0006_agente_cantidad.sql tests/
git commit -m "feat(cotizador): el agente registra la intencion de cotizar"
```

---

### Tarea 10: Cola de borradores en la pantalla

Cierra el circuito: lo que el agente capturó llega a los ojos de un vendedor.

**Archivos:**
- Crear: `app/api/cotizacion/borradores/route.ts`
- Modificar: `app/cotizador/Cotizador.tsx`
- Test: `tests/api-borradores.test.ts`

**Interfaces:**
- Consume: la tabla `cotizaciones` (Tarea 5), las filas que escribe `registrarIntencion`
  (Tarea 9).
- Produce: `POST /api/cotizacion/borradores` → `{ ok: true, borradores: Borrador[] }` con
  `Borrador = { id: string; created_at: string; contact_id: string | null; cliente: Record<string, unknown> }`.

Es `POST` y no `GET` porque la clave viaja en el cuerpo, igual que en el resto de rutas
protegidas del proyecto. Una clave en la barra de direcciones queda en el historial y en
los registros del servidor.

- [ ] **Paso 1: Escribir la prueba que falla**

```typescript
// tests/api-borradores.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const filas = [
  {
    id: 'cot-1',
    created_at: '2026-08-26T10:00:00Z',
    contact_id: 'c1',
    cliente: { nombre: 'Ana Pérez', email: 'ana@hotel.com', producto: 'uniformes', cantidadTexto: '300 piezas' },
  },
];

vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => ({ limit: async () => ({ data: filas, error: null }) }),
        }),
      }),
    }),
  }),
}));

const { POST } = await import('@/app/api/cotizacion/borradores/route');

function peticion(cuerpo: unknown) {
  return new Request('http://localhost/api/cotizacion/borradores', {
    method: 'POST',
    body: JSON.stringify(cuerpo),
  });
}

describe('POST /api/cotizacion/borradores', () => {
  beforeEach(() => {
    process.env.LUXE_TALLER_CLAVE = 'secreta';
  });

  it('rechaza sin clave', async () => {
    const res = await POST(peticion({ clave: 'otra' }));
    expect(res.status).toBe(401);
  });

  it('devuelve los borradores pendientes', async () => {
    const res = await POST(peticion({ clave: 'secreta' }));
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.borradores).toHaveLength(1);
    expect(cuerpo.borradores[0].cliente.cantidadTexto).toBe('300 piezas');
  });

  it('rechaza un cuerpo que no es JSON', async () => {
    const res = await POST(
      new Request('http://localhost/api/cotizacion/borradores', { method: 'POST', body: 'x' }),
    );
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Paso 2: Ejecutar y ver que falla**

Ejecutar: `npx vitest run tests/api-borradores.test.ts`
Esperado: FALLA — no existe la ruta.

- [ ] **Paso 3: Escribir el endpoint**

```typescript
// app/api/cotizacion/borradores/route.ts
import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/server';

export const runtime = 'nodejs';

function claveValida(recibida: unknown): boolean {
  const esperada = process.env.LUXE_TALLER_CLAVE;
  if (!esperada || typeof recibida !== 'string') return false;
  const a = Buffer.from(recibida);
  const b = Buffer.from(esperada);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  let cuerpo: { clave?: unknown };
  try {
    cuerpo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  if (!claveValida(cuerpo.clave)) {
    return NextResponse.json({ ok: false, error: 'Clave incorrecta.' }, { status: 401 });
  }

  const { data, error } = await supabaseAdmin()
    .from('cotizaciones')
    .select('id, created_at, contact_id, cliente')
    .eq('estado', 'borrador')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    console.error('[cotizador] No se pudieron leer los borradores.', error.message);
    return NextResponse.json({ ok: false, error: 'No se pudo consultar.' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, borradores: data ?? [] });
}
```

- [ ] **Paso 4: Ejecutar y ver que pasa**

Ejecutar: `npx vitest run tests/api-borradores.test.ts`
Esperado: PASA, 3 pruebas.

- [ ] **Paso 5: Añadir la sección a `Cotizador.tsx`**

Encima del buscador, una sección "Borradores pendientes":

- Al escribir la clave, hace `POST /api/cotizacion/borradores` y lista lo que vuelva.
- Por cada borrador: nombre, empresa, correo, producto y **la cantidad tal como la dijo el
  cliente** (`cantidadTexto`), con la fecha.
- Un botón "Usar" que rellena los campos del cliente y deja visible un recordatorio con el
  texto original de la cantidad, para que el vendedor elija los SKUs contra lo que el
  cliente realmente pidió.
- Si no hay borradores, un texto neutro: "No hay borradores pendientes."

El texto de la cantidad se muestra **literal, sin interpretar**: "unos 300" no es 300, y
convertirlo es criterio del vendedor.

- [ ] **Paso 6: Probar a mano**

Ejecutar: `npm run dev`, abrir `/cotizador`, escribir la clave.

Si no hay borradores reales todavía, insertar uno de prueba:
```bash
node --env-file=.env.local -e "
import('@supabase/supabase-js').then(async ({createClient}) => {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { error } = await db.from('cotizaciones').insert({
    origen: 'agente', estado: 'borrador', contact_id: 'prueba',
    cliente: { nombre: 'Prueba', email: 'p@example.invalid', producto: 'uniformes', cantidadTexto: 'unos 300' },
    lineas: [], totales: {},
  });
  console.log(error ? error.message : 'borrador de prueba insertado');
});"
```

Borrarlo después:
```bash
node --env-file=.env.local -e "
import('@supabase/supabase-js').then(async ({createClient}) => {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  await db.from('cotizaciones').delete().eq('contact_id', 'prueba');
  console.log('borrado');
});"
```

- [ ] **Paso 7: Suite completa y commit**

Ejecutar: `npm test`

```bash
git add app/api/cotizacion/borradores app/cotizador/Cotizador.tsx tests/api-borradores.test.ts
git commit -m "feat(cotizador): cola de borradores del agente en la pantalla"
```

---

## Después del plan

**Antes de desplegar:** aplicar las migraciones **antes** de subir el código. El README lo
advierte para el agente y vale igual aquí: si el código llega primero, cada escritura falla
contra una tabla que no existe.

**Variables de entorno:** no hay nuevas. Se reutilizan `LUXE_TALLER_CLAVE`,
`LUXE_GHL_API_KEY` y `LUXE_GHL_LOCATION_ID`.

**Pendiente que no bloquea:** la tasa reducida de IVA que Luxe consulta con su contador. El
motor ya la acepta como campo; cuando llegue la respuesta, es agregar la opción al selector
de la Tarea 8.
