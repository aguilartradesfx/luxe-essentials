# Panel de cotizaciones — plan de implementación (fase 2)

> **Para agentes ejecutores:** SUB-SKILL REQUERIDA: usar `superpowers:subagent-driven-development`
> para implementar tarea por tarea. Los pasos usan casillas (`- [ ]`) para seguimiento.

**Objetivo:** que la cotización llegue al cliente como un documento propio de Luxe, y que el
equipo la vea, la mida y le dé seguimiento desde un panel embebido dentro de GoHighLevel.

**Arquitectura:** el panel pasa a ser la fuente de verdad de las cotizaciones —documento,
estado, montos, métricas— y GoHighLevel se queda con el cliente: contacto, oportunidad y
seguimiento comercial. Una nota en el contacto enlaza un lado con el otro. El Estimate
nativo de GoHighLevel se retira al final, cuando el reemplazo esté verificado.

**Stack:** Next.js 16 (App Router), React 19, TypeScript, Zod 4, Supabase (base y Storage),
`@react-pdf/renderer`, Resend, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-27-panel-cotizaciones-design.md`

## Restricciones globales

- **Dinero en enteros.** Colones sin decimales, en todo el sistema.
- **Los precios no llegan al navegador.** `catalogo.ts`, `escalas.ts` y `calcular.ts` llevan
  `import 'server-only'`. Cualquier tarea que importe uno de esos desde un componente de
  cliente rompe el build a propósito.
- **Primero la base, después todo lo demás.** La fila existe antes de generar el PDF, mandar
  el correo o tocar GoHighLevel.
- **Los adaptadores nunca lanzan.** Devuelven `{ ok: false, error }` y aceptan una
  implementación inyectable para poder probarse sin red.
- **Ningún fallo de GoHighLevel invalida una cotización que ya salió al cliente.**
- Identificadores, comentarios y textos en español.
- Cada tarea termina con `npm test` en verde y un commit.
- Al terminar cualquier tarea que toque la pantalla, correr `npm run build` y verificar que
  no hay precios en el paquete:
  ```bash
  grep -l "precioLista" .next/static/chunks/*.js 2>/dev/null || echo "SIN precioLista"
  ```

## Mapa de archivos

| Archivo | Responsabilidad |
|---|---|
| `lib/cotizador/documento.tsx` | El PDF: diseño y render a buffer. Sin red, sin base. |
| `lib/cotizador/almacen.ts` | Subir el PDF a Supabase Storage y firmar su enlace. |
| `lib/cotizador/correo.ts` | Mandar la cotización por Resend, con el PDF adjunto. |
| `lib/cotizador/metricas.ts` | Cálculo de las seis métricas. Función pura sobre filas. |
| `lib/sesion.ts` | Emitir y verificar la cookie de sesión, y el token anti-CSRF. |
| `app/api/cotizacion/entrar/route.ts` | Valida la clave y emite la cookie. |
| `app/api/cotizacion/listado/route.ts` | Listado con filtro por estado. |
| `app/api/cotizacion/metricas/route.ts` | Las métricas del panel. |
| `app/api/cotizacion/cerrar/route.ts` | Marcar ganada o perdida. |
| `app/api/cotizacion/reenviar/route.ts` | Volver a mandar el correo. |
| `app/cotizador/Panel.tsx` | Contenedor con las tres vistas. Reemplaza a `Cotizador.tsx`. |
| `app/cotizador/VistaCrear.tsx` | Lo que hoy es `Cotizador.tsx`, extraído. |
| `app/cotizador/VistaListado.tsx` | Listado con acciones por fila. |
| `app/cotizador/VistaMetricas.tsx` | Las seis métricas. |
| `next.config.ts` (modificar) | `frame-ancestors` para permitir el iframe de GoHighLevel. |

---

### Tarea 1: Migración de columnas y estados

**Archivos:**
- Crear: `supabase/migrations/0009_panel_cotizaciones.sql`

**Interfaces:**
- Produce: en `public.cotizaciones`, las columnas `pdf_ruta`, `enviado_at`, `resend_id`,
  `cerrada_at`, `motivo_cierre`, `numero` (correlativo único), y los estados `ganada` y
  `perdida` en el `check`.

- [ ] **Paso 1: Escribir la migración**

```sql
-- supabase/migrations/0009_panel_cotizaciones.sql
-- El panel pasa a ser la fuente de verdad de las cotizaciones: necesita saber
-- dónde vive el PDF, cuándo salió el correo y cómo terminó la negociación.

alter table public.cotizaciones
  add column if not exists pdf_ruta      text,
  add column if not exists enviado_at    timestamptz,
  -- Id de Resend: es lo único que permite rastrear si el correo se entregó y
  -- si el cliente lo abrió. Sin esto, "se envió" es un acto de fe.
  add column if not exists resend_id     text,
  add column if not exists cerrada_at    timestamptz,
  add column if not exists motivo_cierre text;

-- `ganada` y `perdida` las marca un vendedor a mano cuando el cliente responde.
-- Sin ellas el panel informa cuánto se cotizó y nunca cuánto se vendió.
alter table public.cotizaciones drop constraint if exists cotizaciones_estado_check;
alter table public.cotizaciones add constraint cotizaciones_estado_check
  check (estado in ('borrador','creada','enviada','error','convertida','ganada','perdida'));

-- El listado ordena por fecha descendente sin filtrar por origen, así que el
-- índice tampoco filtra: uno parcial que no cubre la consulta es peso muerto.
create index if not exists cotizaciones_creadas_idx
  on public.cotizaciones (created_at desc);

-- El número que el cliente cita cuando llama a preguntar. Correlativo de
-- verdad, no un fragmento del id: `COT-2026-a3f9b2c1` en el documento que
-- recibe un hotel no es un número de cotización, es ruido.
create sequence if not exists cotizaciones_numero_seq;

alter table public.cotizaciones
  add column if not exists numero text unique
    default 'COT-' || to_char(now(), 'YYYY') || '-' ||
            lpad(nextval('cotizaciones_numero_seq')::text, 4, '0');
```

- [ ] **Paso 2: Aplicar y verificar**

Ejecutar: `npm run db:migrate`

Verificar el `check` resultante:
```bash
node --env-file=.env.local -e "
import('pg').then(async ({default:pg})=>{
  const c=new pg.Client({connectionString:process.env.SUPABASE_DB_URL});await c.connect();
  const r=await c.query(\"select pg_get_constraintdef(oid) d from pg_constraint where conname='cotizaciones_estado_check'\");
  console.log(r.rows[0].d); await c.end();});"
```
Esperado: los siete estados en la lista.

- [ ] **Paso 3: Commit**

```bash
git add supabase/migrations/0009_panel_cotizaciones.sql
git commit -m "feat(panel): columnas de documento, envio y cierre"
```

---

### Tarea 2: El documento PDF

**Archivos:**
- Crear: `lib/cotizador/documento.tsx`
- Test: `tests/panel-documento.test.ts`

**Interfaces:**
- Consume: `Cotizacion` de `lib/cotizador/tipos.ts`.
- Produce: `renderizarCotizacion(p: DatosDocumento): Promise<Buffer>` con
  `DatosDocumento = { numero: string; cotizacion: Cotizacion; cliente: ClienteDocumento; emitida: Date; vence: Date }`
  y `ClienteDocumento = { nombre: string; empresa?: string; email: string; telefono?: string; direccion?: string }`.

**Por qué `@react-pdf/renderer` y no un navegador:** las librerías que renderizan abriendo
Chromium pesan cientos de megas, rozan el límite de bundle de Vercel y fallan de formas
difíciles de diagnosticar. Ésta es JavaScript puro y corre en Node sin navegador. El costo es
que usa su propio motor de layout: se diseña para la herramienta, no se convierte desde HTML.

- [ ] **Paso 1: Instalar la dependencia**

Ejecutar: `npm install @react-pdf/renderer`

- [ ] **Paso 2: Escribir la prueba que falla**

```typescript
// tests/panel-documento.test.ts
import { describe, it, expect } from 'vitest';
import { renderizarCotizacion } from '@/lib/cotizador/documento';
import type { Cotizacion } from '@/lib/cotizador/tipos';

const cotizacion: Cotizacion = {
  lineas: [
    {
      skuId: 'set-600-king', nombre: 'Set de 600 hilos king',
      contenido: ['1 cubrecama', '1 sábana', '2 sobrefundas'],
      cantidad: 16, precioLista: 90000, descuentoPct: 10,
      precioUnitario: 81000, subtotal: 1296000, grupo: 'sets-cama',
      motivo: '16 sets en Sets de cama → 10%',
    },
  ],
  subtotal: 1296000, ahorro: 144000, tasaIva: 0.13, iva: 168480,
  total: 1464480, bordadoEspecial: false,
};

const base = {
  numero: 'COT-2026-0001',
  cotizacion,
  cliente: { nombre: 'Ana Pérez', empresa: 'Hotel Papagayo', email: 'ana@hotel.com' },
  emitida: new Date('2026-08-27T12:00:00Z'),
  vence: new Date('2026-09-26T12:00:00Z'),
};

describe('renderizarCotizacion', () => {
  it('produce un PDF válido', async () => {
    const buf = await renderizarCotizacion(base);
    expect(Buffer.isBuffer(buf)).toBe(true);
    // Todo PDF empieza con esta firma. Sin ella no es un PDF, sea lo que sea.
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(1000);
  });

  it('no falla con una cotización de muchas líneas', async () => {
    const muchas = {
      ...base,
      cotizacion: {
        ...cotizacion,
        lineas: Array.from({ length: 40 }, (_, i) => ({
          ...cotizacion.lineas[0], skuId: `sku-${i}`, nombre: `Producto ${i}`,
        })),
      },
    };
    const buf = await renderizarCotizacion(muchas);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('no falla cuando el cliente está exento de IVA', async () => {
    const exento = {
      ...base,
      cotizacion: { ...cotizacion, tasaIva: 0, iva: 0, total: cotizacion.subtotal },
    };
    const buf = await renderizarCotizacion(exento);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('no falla sin empresa ni contenido de set', async () => {
    const minimo = {
      ...base,
      cliente: { nombre: 'Ana Pérez', email: 'ana@hotel.com' },
      cotizacion: {
        ...cotizacion,
        lineas: [{ ...cotizacion.lineas[0], contenido: undefined, descuentoPct: 0 }],
      },
    };
    const buf = await renderizarCotizacion(minimo);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
```

- [ ] **Paso 3: Ejecutar y ver que falla**

Ejecutar: `npx vitest run tests/panel-documento.test.ts`
Esperado: FALLA — no existe el módulo.

- [ ] **Paso 4: Escribir el documento**

Crear `lib/cotizador/documento.tsx` con `@react-pdf/renderer`. Estructura obligatoria:

- **Encabezado:** "Luxe Essentials", el número de cotización, la fecha de emisión y
  **"Válida hasta [fecha]"** bien visible. Un precio sin vigencia es un precio que un hotel
  puede reclamar dentro de un año.
- **Datos del cliente:** nombre, empresa, correo, y teléfono y dirección si vienen.
- **Tabla de líneas:** producto, cantidad, precio unitario, subtotal. Debajo del nombre, en
  letra más chica: **el contenido del set** (`"Incluye: 1 cubrecama, 1 sábana, 2 sobrefundas"`)
  y el descuento aplicado si lo hay. Sin ese desglose, un hotel lee "set de 600 hilos king
  ₡90.000" y no sabe qué recibe.
- **Totales:** subtotal, IVA con su porcentaje, y **el total destacado**. El cliente pidió por
  escrito que el total vaya primero y el IVA se sume abajo.
- **Notas al pie:** que los precios son en colones, y la nota del bordado ("Incluye bordado
  de hasta 10x10 cm a un color. Bordados de mayor tamaño o a varios colores se cotizan por
  separado según muestra."). Si `bordadoEspecial` es `true`, agregar que el precio final se
  confirma contra muestra.
- **Nada sobre métodos de pago.** Requisito explícito del cliente.

Formatear los montos con separador de miles y el símbolo `₡`, sin decimales.

Exportar `renderizarCotizacion` usando `renderToBuffer` del paquete.

Es una pieza de venta para hoteles de lujo: usar espaciado generoso, jerarquía tipográfica
clara y alineación de números a la derecha. No un formulario.

- [ ] **Paso 5: Ejecutar y ver que pasa**

Ejecutar: `npx vitest run tests/panel-documento.test.ts`
Esperado: PASA, 4 pruebas.

- [ ] **Paso 6: Mirarlo con ojos humanos**

```bash
node --experimental-strip-types -e "
import('./lib/cotizador/documento.tsx').then(async m=>{
  const fs=await import('node:fs');
  const buf=await m.renderizarCotizacion({numero:'COT-2026-0001',
    cotizacion:{lineas:[{skuId:'set-600-king',nombre:'Set de 600 hilos king',contenido:['1 cubrecama','1 sábana','2 sobrefundas'],cantidad:16,precioLista:90000,descuentoPct:10,precioUnitario:81000,subtotal:1296000,grupo:'sets-cama',motivo:'16 sets → 10%'}],subtotal:1296000,ahorro:144000,tasaIva:0.13,iva:168480,total:1464480,bordadoEspecial:false},
    cliente:{nombre:'Ana Pérez',empresa:'Hotel Papagayo',email:'ana@hotel.com'},
    emitida:new Date(),vence:new Date(Date.now()+30*864e5)});
  fs.writeFileSync('/tmp/cotizacion-muestra.pdf',buf);console.log('escrito /tmp/cotizacion-muestra.pdf');});"
```

Abrirlo y **juzgarlo como lo juzgaría un hotel que recibe una cotización de ₡1,4 millones.**
Si se ve a formulario, decilo en el reporte: el documento propio es el argumento entero por
el que se abandona la plantilla de GoHighLevel.

- [ ] **Paso 7: Suite completa y commit**

```bash
npm test
git add lib/cotizador/documento.tsx tests/panel-documento.test.ts package.json package-lock.json
git commit -m "feat(panel): documento PDF de la cotizacion"
```

---

### Tarea 3: Almacenamiento del PDF

**Archivos:**
- Crear: `lib/cotizador/almacen.ts`
- Test: `tests/panel-almacen.test.ts`

**Interfaces:**
- Produce: `guardarPdf(p: { id: string; numero: string; pdf: Buffer }, db: ClienteAlmacen): Promise<ResultadoAlmacen>`
  con `ResultadoAlmacen = { ok: true; ruta: string } | { ok: false; error: string }`,
  y `enlaceFirmado(ruta: string, db: ClienteAlmacen, segundos?: number): Promise<{ ok: true; url: string } | { ok: false; error: string }>`.
- `ClienteAlmacen` es el tipo laxo `{ storage: { from: (b: string) => any } }`, igual que
  `Db` en `lib/agente/estado.ts`: se inyecta para poder probar sin red.

**El bucket es privado a propósito.** Es el detalle de precios de un cliente concreto. Un
bucket público con nombres adivinables expone cotizaciones ajenas.

- [ ] **Paso 1: Escribir la prueba que falla**

```typescript
// tests/panel-almacen.test.ts
import { describe, it, expect, vi } from 'vitest';
import { guardarPdf, enlaceFirmado } from '@/lib/cotizador/almacen';

function almacen(resultadoSubida: unknown, resultadoUrl?: unknown) {
  const upload = vi.fn().mockResolvedValue(resultadoSubida);
  const createSignedUrl = vi.fn().mockResolvedValue(resultadoUrl ?? { data: null, error: null });
  return { cliente: { storage: { from: () => ({ upload, createSignedUrl }) } }, upload, createSignedUrl };
}

const pdf = Buffer.from('%PDF-1.7 falso');

describe('guardarPdf', () => {
  it('sube el PDF y devuelve su ruta', async () => {
    const a = almacen({ data: { path: 'x' }, error: null });
    const r = await guardarPdf({ id: 'abc', numero: 'COT-2026-0001', pdf }, a.cliente);
    expect(r).toEqual({ ok: true, ruta: expect.stringContaining('COT-2026-0001') });
  });

  it('organiza por año y usa el id para que la ruta no sea adivinable', async () => {
    const a = almacen({ data: { path: 'x' }, error: null });
    const r = await guardarPdf({ id: 'abc123', numero: 'COT-2026-0001', pdf }, a.cliente);
    if (!r.ok) throw new Error('debía subir');
    expect(r.ruta).toMatch(/^\d{4}\//);
    expect(r.ruta).toContain('abc123');
  });

  it('sube con el tipo de contenido correcto', async () => {
    const a = almacen({ data: { path: 'x' }, error: null });
    await guardarPdf({ id: 'abc', numero: 'COT-1', pdf }, a.cliente);
    expect(a.upload.mock.calls[0][2]).toMatchObject({ contentType: 'application/pdf' });
  });

  it('devuelve el error sin lanzar', async () => {
    const a = almacen({ data: null, error: { message: 'bucket lleno' } });
    const r = await guardarPdf({ id: 'abc', numero: 'COT-1', pdf }, a.cliente);
    expect(r).toEqual({ ok: false, error: expect.stringContaining('bucket lleno') });
  });

  it('no lanza si el almacenamiento explota', async () => {
    const cliente = { storage: { from: () => { throw new Error('sin red'); } } };
    const r = await guardarPdf({ id: 'abc', numero: 'COT-1', pdf }, cliente);
    expect(r).toEqual({ ok: false, error: expect.stringContaining('sin red') });
  });
});

describe('enlaceFirmado', () => {
  it('devuelve la url firmada', async () => {
    const a = almacen({}, { data: { signedUrl: 'https://x/firmada' }, error: null });
    const r = await enlaceFirmado('2026/abc.pdf', a.cliente);
    expect(r).toEqual({ ok: true, url: 'https://x/firmada' });
  });

  it('firma por 90 días por defecto', async () => {
    const a = almacen({}, { data: { signedUrl: 'https://x' }, error: null });
    await enlaceFirmado('2026/abc.pdf', a.cliente);
    expect(a.createSignedUrl.mock.calls[0][1]).toBe(90 * 24 * 60 * 60);
  });

  it('devuelve el error sin lanzar', async () => {
    const a = almacen({}, { data: null, error: { message: 'ruta inexistente' } });
    const r = await enlaceFirmado('no/existe.pdf', a.cliente);
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Paso 2: Ejecutar y ver que falla**

Ejecutar: `npx vitest run tests/panel-almacen.test.ts`
Esperado: FALLA — no existe el módulo.

- [ ] **Paso 3: Escribir el módulo**

```typescript
// lib/cotizador/almacen.ts
import 'server-only';

export const BUCKET = 'cotizaciones';

// 90 días: más que la vigencia de 30 de la cotización, con margen para que el
// cliente vuelva a abrir el correo semanas después de haberla recibido.
const SEGUNDOS_FIRMA = 90 * 24 * 60 * 60;

// El mismo tipo laxo que usa lib/agente/estado.ts, por la misma razón: poder
// probar sin red.
export type ClienteAlmacen = { storage: { from: (bucket: string) => any } };

export type ResultadoAlmacen = { ok: true; ruta: string } | { ok: false; error: string };

// La ruta lleva el id de la fila, no sólo el número: el bucket es privado, pero
// una ruta adivinable a partir del correlativo sería una invitación a probar
// COT-2026-0002 y leer la cotización de otro cliente.
function rutaDe(id: string, numero: string): string {
  const anio = new Date().getFullYear();
  return `${anio}/${numero}-${id}.pdf`;
}

export async function guardarPdf(
  p: { id: string; numero: string; pdf: Buffer }, db: ClienteAlmacen,
): Promise<ResultadoAlmacen> {
  const ruta = rutaDe(p.id, p.numero);
  try {
    const { error } = await db.storage.from(BUCKET).upload(ruta, p.pdf, {
      contentType: 'application/pdf',
      upsert: true,
    });
    if (error) return { ok: false, error: `No se pudo guardar el PDF: ${error.message}` };
    return { ok: true, ruta };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function enlaceFirmado(
  ruta: string, db: ClienteAlmacen, segundos: number = SEGUNDOS_FIRMA,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  try {
    const { data, error } = await db.storage.from(BUCKET).createSignedUrl(ruta, segundos);
    if (error || !data?.signedUrl) {
      return { ok: false, error: `No se pudo firmar el enlace: ${error?.message ?? 'sin url'}` };
    }
    return { ok: true, url: data.signedUrl };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

- [ ] **Paso 4: Crear el bucket en Supabase**

```bash
node --env-file=.env.local -e "
import('@supabase/supabase-js').then(async ({createClient})=>{
  const db=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const {error}=await db.storage.createBucket('cotizaciones',{public:false});
  console.log(error? error.message : 'bucket creado (privado)');
  const {data}=await db.storage.listBuckets();
  console.log('buckets:', data.map(b=>b.name+' '+(b.public?'PUBLICO':'privado')).join(', '));});"
```

Esperado: `bucket creado (privado)` y que el listado lo muestre como privado. **Si aparece
como público, pará y avisá:** sería exponer las cotizaciones de todos los clientes.

- [ ] **Paso 5: Ejecutar y ver que pasa**

Ejecutar: `npx vitest run tests/panel-almacen.test.ts`
Esperado: PASA, 8 pruebas.

- [ ] **Paso 6: Suite completa y commit**

```bash
npm test
git add lib/cotizador/almacen.ts tests/panel-almacen.test.ts
git commit -m "feat(panel): almacenamiento del PDF en Supabase Storage"
```

---

### Tarea 4: Envío por Resend

**Archivos:**
- Crear: `lib/cotizador/correo.ts`
- Modificar: `.env.example`
- Test: `tests/panel-correo.test.ts`

**Interfaces:**
- Consume: el `Buffer` de la Tarea 2 y la url de la Tarea 3.
- Produce: `enviarCotizacion(p: ParamsCorreo, deps: DepsCorreo): Promise<ResultadoCorreo>`
  con `ResultadoCorreo = { ok: true; resendId: string } | { ok: false; error: string }`.
- `DepsCorreo = { apiKey: string; remitente: string; fetchImpl?: typeof fetch }`.

Se llama a la API de Resend con `fetch` en vez de usar su SDK, para mantener el patrón del
repositorio: `fetchImpl` inyectable, nunca lanza, probable sin red.

- [ ] **Paso 1: Escribir la prueba que falla**

```typescript
// tests/panel-correo.test.ts
import { describe, it, expect, vi } from 'vitest';
import { enviarCotizacion } from '@/lib/cotizador/correo';

const params = {
  numero: 'COT-2026-0001',
  cliente: { nombre: 'Ana Pérez', empresa: 'Hotel Papagayo', email: 'ana@hotel.com' },
  total: 1464480,
  vence: new Date('2026-09-26T12:00:00Z'),
  pdf: Buffer.from('%PDF-1.7 falso'),
  enlace: 'https://supabase/firmada',
};
const deps = { apiKey: 'llave', remitente: 'Luxe Essentials <cotizaciones@luxe.cr>' };

function respuesta(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as unknown as Response;
}

describe('enviarCotizacion', () => {
  it('devuelve el id de Resend', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ id: 're_123' }));
    const r = await enviarCotizacion(params, { ...deps, fetchImpl });
    expect(r).toEqual({ ok: true, resendId: 're_123' });
  });

  it('adjunta el PDF con nombre legible', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ id: 're_1' }));
    await enviarCotizacion(params, { ...deps, fetchImpl });
    const cuerpo = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(cuerpo.attachments).toHaveLength(1);
    expect(cuerpo.attachments[0].filename).toBe('COT-2026-0001.pdf');
    expect(cuerpo.attachments[0].content).toBe(params.pdf.toString('base64'));
  });

  it('manda al correo del cliente, desde el remitente configurado', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ id: 're_1' }));
    await enviarCotizacion(params, { ...deps, fetchImpl });
    const cuerpo = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(cuerpo.to).toEqual(['ana@hotel.com']);
    expect(cuerpo.from).toBe(deps.remitente);
  });

  it('el cuerpo lleva el monto, la vigencia y el enlace', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ id: 're_1' }));
    await enviarCotizacion(params, { ...deps, fetchImpl });
    const { html } = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(html).toContain('1.464.480');
    expect(html).toContain('https://supabase/firmada');
    expect(html).toMatch(/26.*setiembre|26\/09|2026-09-26/);
  });

  it('nunca menciona método de pago', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ id: 're_1' }));
    await enviarCotizacion(params, { ...deps, fetchImpl });
    const cuerpo = fetchImpl.mock.calls[0][1].body as string;
    expect(cuerpo).not.toMatch(/pagar|pago en línea|tarjeta|transferencia/i);
  });

  it('devuelve el error de Resend sin lanzar', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ message: 'dominio no verificado' }, 403));
    const r = await enviarCotizacion(params, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('403');
  });

  it('no lanza si se cae la red', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const r = await enviarCotizacion(params, { ...deps, fetchImpl });
    expect(r).toEqual({ ok: false, error: expect.stringContaining('ECONNRESET') });
  });

  it('falla claro si falta la llave', async () => {
    const fetchImpl = vi.fn();
    const r = await enviarCotizacion(params, { apiKey: '', remitente: deps.remitente, fetchImpl });
    expect(r.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
```

- [ ] **Paso 2: Ejecutar y ver que falla**

Ejecutar: `npx vitest run tests/panel-correo.test.ts`
Esperado: FALLA — no existe el módulo.

- [ ] **Paso 3: Escribir el módulo**

Crear `lib/cotizador/correo.ts` con `import 'server-only'`, que llame a
`POST https://api.resend.com/emails` con cabecera `Authorization: Bearer <apiKey>`.

El cuerpo del correo, en HTML sencillo y en español:
- Saludo por el nombre del cliente.
- Que adjunto va la cotización, con su número.
- **El total y hasta cuándo es válida.**
- El enlace por si prefiere abrirla en el navegador.
- Firma de Luxe Essentials.
- **Nada sobre formas de pago.** El vendedor coordina el cobro aparte.

Asunto: `Cotización COT-2026-0001 — Luxe Essentials`.

Formatear el monto con separador de miles y `₡`.

- [ ] **Paso 4: Declarar las variables de entorno**

Añadir a `.env.example`:
```
RESEND_API_KEY=
LUXE_CORREO_REMITENTE=
```

- [ ] **Paso 5: Ejecutar y ver que pasa**

Ejecutar: `npx vitest run tests/panel-correo.test.ts`
Esperado: PASA, 8 pruebas.

- [ ] **Paso 6: Suite completa y commit**

```bash
npm test
git add lib/cotizador/correo.ts tests/panel-correo.test.ts .env.example
git commit -m "feat(panel): envio de la cotizacion por Resend"
```

---

### Tarea 5: Conectar el envío — la cotización llega al cliente

Es el hito entregable de esta fase: al terminar esta tarea, una cotización creada en el
panel **le llega al hotel por correo, con el PDF de Luxe adjunto.**

**Archivos:**
- Modificar: `app/api/cotizacion/route.ts`
- Modificar: `lib/validation.ts`
- Test: `tests/api-cotizacion.test.ts` (existente)

**Interfaces:**
- Consume: `renderizarCotizacion` (T2), `guardarPdf`/`enlaceFirmado` (T3),
  `enviarCotizacion` (T4).
- Produce: la respuesta del endpoint suma `{ pdf: { ruta } | null, correo: { resendId } | { error } }`.

- [ ] **Paso 1: Añadir teléfono y dirección al esquema**

En `lib/validation.ts`, dentro de `cotizacionSchema.cliente`:

```typescript
    telefono: z.string().trim().max(40, 'Escribe un teléfono más corto.').optional(),
    direccion: z.string().trim().max(200, 'Escribe una dirección más corta.').optional(),
```

- [ ] **Paso 2: Escribir las pruebas nuevas**

Añadir a `tests/api-cotizacion.test.ts`, con los módulos simulados al principio del archivo:

```typescript
vi.mock('@/lib/cotizador/documento', () => ({
  renderizarCotizacion: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.7 falso')),
}));
vi.mock('@/lib/cotizador/almacen', () => ({
  guardarPdf: vi.fn().mockResolvedValue({ ok: true, ruta: '2026/COT-1-abc.pdf' }),
  enlaceFirmado: vi.fn().mockResolvedValue({ ok: true, url: 'https://firmada' }),
}));
vi.mock('@/lib/cotizador/correo', () => ({
  enviarCotizacion: vi.fn().mockResolvedValue({ ok: true, resendId: 're_1' }),
}));
```

Y las pruebas:

```typescript
  it('genera el PDF, lo guarda y manda el correo', async () => {
    const res = await POST(peticion(valido));
    const cuerpo = await res.json();
    expect(cuerpo.pdf.ruta).toBe('2026/COT-1-abc.pdf');
    expect(cuerpo.correo.resendId).toBe('re_1');
  });

  it('guarda la ruta del PDF y el id de Resend en la fila', async () => {
    await POST(peticion(valido));
    const actualizado = actualizados[actualizados.length - 1] as Record<string, unknown>;
    expect(actualizado.pdf_ruta).toBe('2026/COT-1-abc.pdf');
    expect(actualizado.resend_id).toBe('re_1');
    expect(actualizado.enviado_at).toBeTruthy();
  });

  it('si el correo falla, la cotización queda en error y es recuperable', async () => {
    const { enviarCotizacion } = await import('@/lib/cotizador/correo');
    vi.mocked(enviarCotizacion).mockResolvedValueOnce({ ok: false, error: 'dominio no verificado' });
    const res = await POST(peticion(valido));
    const cuerpo = await res.json();
    expect(cuerpo.correo.error).toContain('dominio');
    const actualizado = actualizados[actualizados.length - 1] as Record<string, unknown>;
    expect(actualizado.estado).toBe('error');
  });

  it('si el PDF falla, no intenta mandar un correo sin adjunto', async () => {
    const { renderizarCotizacion } = await import('@/lib/cotizador/documento');
    const { enviarCotizacion } = await import('@/lib/cotizador/correo');
    vi.mocked(renderizarCotizacion).mockRejectedValueOnce(new Error('sin fuentes'));
    const res = await POST(peticion(valido));
    expect((await res.json()).ok).toBe(true);
    expect(enviarCotizacion).not.toHaveBeenCalled();
  });
```

**Nota:** el `db` simulado del archivo necesita recoger los `update` en un array
`actualizados`, igual que ya recoge los `insert` en `insertado`.

- [ ] **Paso 3: Ejecutar y ver que falla**

Ejecutar: `npx vitest run tests/api-cotizacion.test.ts`
Esperado: FALLAN las cuatro nuevas.

- [ ] **Paso 4: Conectar en el endpoint**

En `app/api/cotizacion/route.ts`, **después** del insert que devuelve `data` y **antes** de
llamar a GoHighLevel:

1. **Leer el `numero` de la fila insertada.** Lo genera la base con una secuencia
   (`COT-2026-0001`, `COT-2026-0002`…). No lo derives del id: un número como
   `COT-2026-a3f9b2c1` en el documento que recibe un hotel no es un número de cotización.
   El `insert` ya hace `.select().single()`, así que el valor vuelve sin una consulta extra.
2. `renderizarCotizacion(...)` dentro de un `try/catch`: si lanza, registrar el error, dejar
   `estado: 'error'` y **no** intentar mandar el correo.
3. `guardarPdf(...)` y `enlaceFirmado(...)`.
4. `enviarCotizacion(...)`.
5. Un solo `update` al final con `pdf_ruta`, `enviado_at`, `resend_id`, `updated_at`, y
   `estado: 'enviada'` si el correo salió o `'error'` si no.

**El orden importa:** la fila ya existe desde el insert. Todo lo demás es enriquecimiento, y
cualquier fallo deja la cotización recuperable en lugar de perderla.

- [ ] **Paso 5: Ejecutar y ver que pasa**

Ejecutar: `npx vitest run tests/api-cotizacion.test.ts`
Esperado: PASA.

- [ ] **Paso 6: Agregar teléfono y dirección al formulario**

En `app/cotizador/Cotizador.tsx`, junto a los campos de nombre, empresa y correo, agregar dos
campos opcionales: **teléfono** y **dirección**. Ambos con `aria-label` propio, y ambos van
en `cliente` dentro del `POST`.

Son opcionales a propósito: un hotel que cotiza por correo puede no tener dirección de
entrega definida todavía, y bloquear el envío por eso sería estorbar.

Agregar a `tests/cotizador-ui.test.tsx` una prueba que compruebe que ambos viajan en el
cuerpo cuando se llenan, y que la cotización se puede enviar sin ellos.

- [ ] **Paso 7: Probar de verdad, contra Resend**

Configurar `RESEND_API_KEY` y `LUXE_CORREO_REMITENTE` en `.env.local`. Levantar `npm run dev`
y crear una cotización **a tu propio correo**.

Verificar: que el correo llegue, que el PDF esté adjunto y se abra, que el total del correo
coincida con el del PDF, y que no caiga en spam. **Si cae en spam, avisá:** falta configurar
SPF y DKIM en el dominio, y eso bloquea el resto de la fase.

Comprobar también que el teléfono y la dirección, si se llenaron, salen impresos en el PDF.

- [ ] **Paso 8: Suite completa y commit**

```bash
npm test
git add app/api/cotizacion/route.ts lib/validation.ts app/cotizador/Cotizador.tsx tests/
git commit -m "feat(panel): la cotizacion se genera en PDF y sale por correo"
```

---

### Tarea 6: Sesión por cookie e iframe

**Archivos:**
- Crear: `lib/sesion.ts`
- Crear: `app/api/cotizacion/entrar/route.ts`
- Modificar: `next.config.ts`
- Modificar: las cinco rutas de `app/api/cotizacion/`
- Test: `tests/panel-sesion.test.ts`

**Interfaces:**
- Produce: `emitirSesion(): { cookie: string; csrf: string }`,
  `sesionValida(request: Request): boolean`, y `csrfValido(request: Request, enviado: string | undefined): boolean`.

**Por qué:** hoy la clave viaja en el cuerpo de cada petición. Embebido en GoHighLevel eso es
inviable — el vendedor la escribiría en cada carga.

**La consecuencia que hay que declarar:** la cookie necesita `sameSite=none` para funcionar
dentro de un iframe, y eso significa que viaja en peticiones que originan otros sitios. Por
eso las rutas que **escriben** exigen además un token anti-CSRF que el navegador manda en una
cabecera, no en la cookie.

- [ ] **Paso 1: Escribir la prueba que falla**

```typescript
// tests/panel-sesion.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { emitirSesion, sesionValida, csrfValido } from '@/lib/sesion';

function conCookie(valor: string, cabeceras: Record<string, string> = {}) {
  return new Request('http://localhost/x', { headers: { cookie: valor, ...cabeceras } });
}

describe('sesión', () => {
  beforeEach(() => {
    process.env.LUXE_TALLER_CLAVE = 'secreta';
  });

  it('la cookie es httpOnly, secure y sameSite=none', () => {
    const { cookie } = emitirSesion();
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toMatch(/SameSite=None/i);
  });

  it('dura 30 días', () => {
    const { cookie } = emitirSesion();
    expect(cookie).toMatch(/Max-Age=2592000/);
  });

  it('acepta una sesión que ella misma emitió', () => {
    const { cookie } = emitirSesion();
    const valor = cookie.split(';')[0];
    expect(sesionValida(conCookie(valor))).toBe(true);
  });

  it('rechaza una cookie inventada', () => {
    expect(sesionValida(conCookie('luxe_sesion=inventado'))).toBe(false);
  });

  it('rechaza si no hay cookie', () => {
    expect(sesionValida(new Request('http://localhost/x'))).toBe(false);
  });

  it('rechaza una sesión firmada con otra clave', () => {
    const { cookie } = emitirSesion();
    const valor = cookie.split(';')[0];
    process.env.LUXE_TALLER_CLAVE = 'otra';
    expect(sesionValida(conCookie(valor))).toBe(false);
  });

  it('el token anti-CSRF debe coincidir con el de la sesión', () => {
    const { cookie, csrf } = emitirSesion();
    const valor = cookie.split(';')[0];
    expect(csrfValido(conCookie(valor), csrf)).toBe(true);
    expect(csrfValido(conCookie(valor), 'otro')).toBe(false);
    expect(csrfValido(conCookie(valor), undefined)).toBe(false);
  });
});
```

- [ ] **Paso 2: Ejecutar y ver que falla**

Ejecutar: `npx vitest run tests/panel-sesion.test.ts`
Esperado: FALLA — no existe el módulo.

- [ ] **Paso 3: Escribir `lib/sesion.ts`**

Con `import 'server-only'`. La cookie lleva un valor firmado con HMAC-SHA256 usando
`LUXE_TALLER_CLAVE` como secreto, más la fecha de emisión, para poder caducarla. El token
anti-CSRF se deriva del mismo valor.

Constantes: nombre de cookie `luxe_sesion`, `Max-Age=2592000` (30 días), `HttpOnly`,
`Secure`, `SameSite=None`, `Path=/`.

Comparar con `timingSafeEqual`, igual que el resto del repositorio.

- [ ] **Paso 4: Escribir el endpoint de entrada**

`app/api/cotizacion/entrar/route.ts`: recibe `{ clave }`, la valida en tiempo constante como
las demás rutas, y si es correcta responde `{ ok: true, csrf }` con la cabecera `Set-Cookie`.

- [ ] **Paso 5: Aceptar la cookie en las rutas existentes**

En las cinco rutas de `app/api/cotizacion/`, cambiar la comprobación para aceptar **o** la
clave en el cuerpo **o** una sesión válida. Las que escriben (`route.ts`, `cerrar`,
`reenviar`) exigen además el token anti-CSRF cuando se entra por cookie.

No romper la clave en el cuerpo: las pruebas existentes la usan y sigue siendo válida.

- [ ] **Paso 6: Permitir el iframe de GoHighLevel**

En `next.config.ts`, cabeceras para `/cotizador`:

```typescript
  async headers() {
    return [
      {
        source: '/cotizador',
        headers: [
          {
            key: 'Content-Security-Policy',
            // Sólo GoHighLevel puede embeber el panel. Sin esta línea Next.js
            // lo bloquea y el menu link muestra un marco en blanco.
            value: "frame-ancestors 'self' https://app.gohighlevel.com https://*.gohighlevel.com https://*.leadconnectorhq.com",
          },
        ],
      },
    ];
  },
```

- [ ] **Paso 7: Ejecutar y verificar**

Ejecutar: `npx vitest run tests/panel-sesion.test.ts` → PASA, 7 pruebas.
Ejecutar: `npm test` → todo verde.
Ejecutar: `npm run build` y confirmar que compila.

- [ ] **Paso 8: Commit**

```bash
git add lib/sesion.ts app/api/cotizacion next.config.ts tests/panel-sesion.test.ts
git commit -m "feat(panel): sesion por cookie y permiso de iframe para GoHighLevel"
```

---

### Tarea 7: Métricas

**Archivos:**
- Crear: `lib/cotizador/metricas.ts`
- Test: `tests/panel-metricas.test.ts`

**Interfaces:**
- Produce: `calcularMetricas(filas: FilaCotizacion[], hoy: Date): Metricas`.
- `FilaCotizacion = { id: string; created_at: string; enviado_at: string | null; cerrada_at: string | null; estado: string; origen: string; cliente: Record<string, unknown>; lineas: LineaCalculada[]; totales: { subtotal: number; ahorro: number; iva: number; total: number } }`.

Función pura sobre filas: sin base de datos, sin red. Se prueba exhaustivamente.

- [ ] **Paso 1: Escribir la prueba que falla**

```typescript
// tests/panel-metricas.test.ts
import { describe, it, expect } from 'vitest';
import { calcularMetricas } from '@/lib/cotizador/metricas';

const HOY = new Date('2026-08-27T12:00:00Z');

function fila(over: Record<string, unknown> = {}) {
  return {
    id: 'x', created_at: '2026-08-20T12:00:00Z', enviado_at: '2026-08-20T12:00:00Z',
    cerrada_at: null, estado: 'enviada', origen: 'humano',
    cliente: { nombre: 'Ana', empresa: 'Hotel' },
    lineas: [{ skuId: 'set-600-king', nombre: 'Set 600 king', cantidad: 16, subtotal: 1296000, grupo: 'sets-cama' }],
    totales: { subtotal: 1296000, ahorro: 144000, iva: 168480, total: 1464480 },
    ...over,
  } as never;
}

describe('calcularMetricas', () => {
  it('sin filas devuelve todo en cero', () => {
    const m = calcularMetricas([], HOY);
    expect(m.sinRespuesta.monto).toBe(0);
    expect(m.sinRespuesta.cotizaciones).toEqual([]);
    expect(m.ganado.monto).toBe(0);
  });

  it('cuenta lo enviado y sin cerrar como sin respuesta', () => {
    const m = calcularMetricas([fila(), fila({ id: 'y' })], HOY);
    expect(m.sinRespuesta.cantidad).toBe(2);
    expect(m.sinRespuesta.monto).toBe(1464480 * 2);
  });

  it('no cuenta como sin respuesta las ya cerradas', () => {
    const m = calcularMetricas([fila({ estado: 'ganada', cerrada_at: '2026-08-25T12:00:00Z' })], HOY);
    expect(m.sinRespuesta.cantidad).toBe(0);
  });

  it('marca las que vencen dentro de siete días', () => {
    // Enviada el 2026-07-30: vence a los 30 días, el 2026-08-29. Faltan 2 días.
    const m = calcularMetricas([fila({ enviado_at: '2026-07-30T12:00:00Z' })], HOY);
    expect(m.sinRespuesta.porVencer).toBe(1);
  });

  it('separa ganado de perdido', () => {
    const m = calcularMetricas([
      fila({ estado: 'ganada', cerrada_at: '2026-08-25T12:00:00Z' }),
      fila({ id: 'y', estado: 'perdida', cerrada_at: '2026-08-26T12:00:00Z' }),
    ], HOY);
    expect(m.ganado.cantidad).toBe(1);
    expect(m.ganado.monto).toBe(1464480);
    expect(m.perdido.cantidad).toBe(1);
  });

  it('calcula los días promedio entre enviar y cerrar', () => {
    const m = calcularMetricas([
      fila({ estado: 'ganada', enviado_at: '2026-08-01T12:00:00Z', cerrada_at: '2026-08-11T12:00:00Z' }),
    ], HOY);
    expect(m.ganado.diasPromedio).toBe(10);
  });

  it('suma el descuento otorgado y su promedio', () => {
    const m = calcularMetricas([fila(), fila({ id: 'y' })], HOY);
    expect(m.descuento.monto).toBe(144000 * 2);
    // 144.000 sobre un bruto de 1.440.000 es 10%.
    expect(m.descuento.promedioPct).toBeCloseTo(10, 1);
  });

  it('cuenta los productos más cotizados en unidades y en dinero', () => {
    const m = calcularMetricas([fila(), fila({ id: 'y' })], HOY);
    expect(m.productos[0]).toMatchObject({ nombre: 'Set 600 king', unidades: 32, monto: 2592000 });
  });

  it('reparte entre uniformes y hogar por el grupo de cada línea', () => {
    const m = calcularMetricas([
      fila(),
      fila({ id: 'y', lineas: [{ skuId: 'uni-a', nombre: 'Filipina', cantidad: 10, subtotal: 100000, grupo: 'uniformes' }] }),
    ], HOY);
    expect(m.porLinea.hogar.monto).toBe(1296000);
    expect(m.porLinea.uniformes.monto).toBe(100000);
  });

  it('cuenta las fallidas aparte', () => {
    const m = calcularMetricas([fila({ estado: 'error' })], HOY);
    expect(m.fallidas).toBe(1);
    expect(m.sinRespuesta.cantidad).toBe(0);
  });

  it('separa las que nacieron del agente', () => {
    const m = calcularMetricas([fila(), fila({ id: 'y', origen: 'agente' })], HOY);
    expect(m.porOrigen).toEqual({ humano: 1, agente: 1 });
  });

  it('devuelve montos enteros', () => {
    const m = calcularMetricas([fila(), fila({ id: 'y' })], HOY);
    for (const v of [m.sinRespuesta.monto, m.ganado.monto, m.descuento.monto]) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });
});
```

- [ ] **Paso 2: Ejecutar y ver que falla**

Ejecutar: `npx vitest run tests/panel-metricas.test.ts`
Esperado: FALLA — no existe el módulo.

- [ ] **Paso 3: Escribir el módulo**

`lib/cotizador/metricas.ts` con `import 'server-only'`. Exporta el tipo `Metricas` con la
forma que fijan las pruebas, y `calcularMetricas`.

Reglas:
- **Sin respuesta** = `estado` en `('creada','enviada')` y `cerrada_at` nulo. `porVencer` son
  las que cumplen 30 días desde `enviado_at` dentro de los próximos siete.
- **Ganado / perdido** = `estado` `ganada` / `perdida`. `diasPromedio` va de `enviado_at` a
  `cerrada_at`, redondeado.
- **Descuento**: suma de `totales.ahorro`; el promedio es sobre el bruto (subtotal + ahorro).
- **Productos**: agrupar líneas por `nombre`, sumar `cantidad` y `subtotal`, ordenar por monto.
- **Por línea**: `grupo === 'uniformes'` va a uniformes; el resto a hogar.
- **Fallidas**: `estado === 'error'`.
- Nunca contar dos veces una cotización en dos categorías.

- [ ] **Paso 4: Ejecutar y ver que pasa**

Ejecutar: `npx vitest run tests/panel-metricas.test.ts`
Esperado: PASA, 12 pruebas.

- [ ] **Paso 5: Suite completa y commit**

```bash
npm test
git add lib/cotizador/metricas.ts tests/panel-metricas.test.ts
git commit -m "feat(panel): calculo de las metricas"
```

---

### Tarea 8: Endpoints del panel

**Archivos:**
- Crear: `app/api/cotizacion/listado/route.ts`
- Crear: `app/api/cotizacion/metricas/route.ts`
- Crear: `app/api/cotizacion/cerrar/route.ts`
- Crear: `app/api/cotizacion/reenviar/route.ts`
- Test: `tests/api-panel.test.ts`

**Interfaces:**
- Consume: `sesionValida`/`csrfValido` (T6), `calcularMetricas` (T7), `enlaceFirmado` (T3),
  `enviarCotizacion` (T4).
- Produce: cuatro rutas `POST`.

- [ ] **Paso 1: Escribir las pruebas que fallan**

`tests/api-panel.test.ts`, con Supabase simulado como en `tests/api-borradores.test.ts`.
Casos obligatorios por ruta:

**`/listado`** — 401 sin credencial; devuelve las filas con su estado; filtra por estado
cuando se le pasa uno; **no devuelve `lineas` completas** (el listado no necesita el detalle
y son muchos datos); incluye el `contact_id` para poder enlazar a GoHighLevel.

**`/metricas`** — 401 sin credencial; devuelve la forma que produce `calcularMetricas`.

**`/cerrar`** — 401 sin credencial; marca `ganada` con `cerrada_at`; marca `perdida`
guardando `motivo_cierre`; **rechaza un estado que no sea `ganada` ni `perdida`**; rechaza
sin token anti-CSRF cuando se entra por cookie.

**`/reenviar`** — 401 sin credencial; vuelve a firmar el enlace y a mandar el correo;
actualiza `enviado_at` y `resend_id`; **falla claro si la fila no tiene `pdf_ruta`** (no hay
nada que reenviar).

- [ ] **Paso 2: Ejecutar y ver que fallan**

Ejecutar: `npx vitest run tests/api-panel.test.ts`
Esperado: FALLAN — no existen las rutas.

- [ ] **Paso 3: Escribir las cuatro rutas**

Todas `POST`, con `runtime = 'nodejs'`, siguiendo el patrón de
`app/api/cotizacion/borradores/route.ts`: credencial primero, esquema después, errores de
base a 500 con mensaje genérico y el detalle sólo en el log.

`/listado` acepta `{ estado?: string, limite?: number }` y devuelve como máximo 200 filas
ordenadas por `created_at` descendente.

- [ ] **Paso 4: Ejecutar y ver que pasan**

Ejecutar: `npx vitest run tests/api-panel.test.ts`
Esperado: PASA.

- [ ] **Paso 5: Suite completa y commit**

```bash
npm test
git add app/api/cotizacion tests/api-panel.test.ts
git commit -m "feat(panel): endpoints de listado, metricas, cierre y reenvio"
```

---

### Tarea 9: Partir la pantalla en piezas

`app/cotizador/Cotizador.tsx` tiene 797 líneas y va a crecer con dos vistas más. Antes de
agregar nada, se parte.

**Archivos:**
- Crear: `app/cotizador/Panel.tsx`
- Crear: `app/cotizador/VistaCrear.tsx`
- Crear: `app/cotizador/PantallaClave.tsx`
- Crear: `app/cotizador/formato.ts`
- Modificar: `app/cotizador/page.tsx`
- Eliminar: `app/cotizador/Cotizador.tsx`
- Test: `tests/cotizador-ui.test.tsx` (existente)

**Interfaces:**
- Produce: `Panel` como componente por defecto de la ruta; `VistaCrear`, `PantallaClave`, y
  `formatearColones(n: number): string` / `formatearTasa(t: number): string`.

**Esta tarea mueve código y conecta la sesión.** Todo lo demás queda igual.

**Lo que sí cambia: la pantalla pasa a usar la cookie.** Hoy manda `clave` en el cuerpo de
cada petición. `PantallaClave` debe llamar a `POST /api/cotizacion/entrar`, que valida la
clave y devuelve la cookie de sesión más un token anti-CSRF. A partir de ahí las peticiones
van sin clave, y las que escriben mandan el token en la cabecera `x-csrf-token`.

**El token hay que guardarlo en `sessionStorage`, no en memoria.** Sólo se entrega en la
respuesta de `/entrar`; si vive en una variable de React, cada recarga del iframe deja al
vendedor con cookie válida y sin token, obligándolo a escribir la clave de nuevo — que es
justo lo que la sesión existe para evitar.

Si la sesión ya está viva al montar, la pantalla no debe pedir la clave. Las pruebas existentes de
`tests/cotizador-ui.test.tsx` tienen que seguir pasando **sin modificar lo que afirman** —
sólo el import y, si hace falta, envolver en `Panel`. Si alguna prueba necesita cambiar su
aserción, algo se rompió: pará y avisá.

- [ ] **Paso 1: Extraer los formateadores**

`app/cotizador/formato.ts` con `formatearColones` y `formatearTasa`, copiados tal cual de
`Cotizador.tsx`. Sin `server-only`: son de cliente.

- [ ] **Paso 2: Extraer la pantalla de clave**

`app/cotizador/PantallaClave.tsx`, que recibe `onEntrar(clave: string): Promise<string | null>`
—devuelve el mensaje de error o `null` si entró— y renderiza el formulario.

- [ ] **Paso 3: Extraer la vista de crear**

`app/cotizador/VistaCrear.tsx` con todo lo que hoy hace `Cotizador.tsx` después de la clave:
buscador, líneas, totales, envío y la cola de borradores.

- [ ] **Paso 4: Escribir el contenedor**

`app/cotizador/Panel.tsx`: maneja la sesión, y una vez dentro muestra tres pestañas —
**Crear**, **Cotizaciones**, **Métricas** — con `VistaCrear` en la primera. Las otras dos
quedan como marcadores en esta tarea; se llenan en las siguientes.

- [ ] **Paso 5: Ajustar las pruebas y verificar**

Actualizar el import de `tests/cotizador-ui.test.tsx` a `Panel`. **Sin cambiar aserciones.**

Ejecutar: `npx vitest run tests/cotizador-ui.test.tsx` → todas verdes.
Ejecutar: `npm test` → todo verde.
Ejecutar: `npm run build` y verificar `grep -l "precioLista" .next/static/chunks/*.js` → sin resultados.

- [ ] **Paso 6: Commit**

```bash
git add app/cotizador tests/cotizador-ui.test.tsx
git commit -m "refactor(panel): partir la pantalla en piezas antes de agregar vistas"
```

---

### Tarea 10: Vista de cotizaciones

**Archivos:**
- Crear: `app/cotizador/VistaListado.tsx`
- Modificar: `app/cotizador/Panel.tsx`
- Test: `tests/panel-listado-ui.test.tsx`

**Interfaces:**
- Consume: `/api/cotizacion/listado`, `/cerrar`, `/reenviar` (T8).

- [ ] **Paso 1: Escribir la prueba que falla**

`tests/panel-listado-ui.test.tsx` con `fetch` simulado. Casos obligatorios:

- Lista las cotizaciones con cliente, monto y estado.
- **Muestra cuáles vencen pronto**, de forma visible.
- El filtro por estado cambia lo que se pide al servidor.
- "Ganada" y "Perdida" llaman a `/cerrar` con el estado correcto.
- "Perdida" **pide el motivo** antes de cerrar.
- "Reenviar" llama a `/reenviar` y avisa del resultado.
- "Duplicar" **lleva a la vista de crear con las líneas cargadas**.
- Hay un enlace a la ficha del contacto en GoHighLevel cuando la fila tiene `contact_id`.
- Sin cotizaciones, un texto neutro.

- [ ] **Paso 2: Ejecutar y ver que falla**

Ejecutar: `npx vitest run tests/panel-listado-ui.test.tsx`
Esperado: FALLA — no existe el componente.

- [ ] **Paso 3: Escribir la vista**

Tabla con: cliente y empresa, número, fecha, **vigencia** (con aviso si vence dentro de siete
días), monto, estado, y las acciones. El enlace a GoHighLevel se arma como
`https://app.gohighlevel.com/v2/location/<locationId>/contacts/detail/<contactId>`; el
`locationId` llega del servidor, **nunca desde el catálogo ni desde una variable de entorno
pública**.

Los estados con color: sin respuesta en neutro, ganada en verde, perdida en gris, error en
rojo.

- [ ] **Paso 4: Verificar y commitear**

Ejecutar: `npx vitest run tests/panel-listado-ui.test.tsx` → PASA.
Ejecutar: `npm test` y `npm run build` con el grep de precios.

```bash
git add app/cotizador tests/panel-listado-ui.test.tsx
git commit -m "feat(panel): vista de cotizaciones con acciones por fila"
```

---

### Tarea 11: Vista de métricas

**Archivos:**
- Crear: `app/cotizador/VistaMetricas.tsx`
- Modificar: `app/cotizador/Panel.tsx`
- Test: `tests/panel-metricas-ui.test.tsx`

- [ ] **Paso 1: Escribir la prueba que falla**

`tests/panel-metricas-ui.test.tsx` con `fetch` simulado devolviendo una respuesta de
`/api/cotizacion/metricas`. Casos obligatorios:

- Muestra el monto sin respuesta y cuántas vencen esta semana.
- Muestra ganado y perdido del mes, con los días promedio.
- Muestra el descuento otorgado y su promedio.
- Lista los productos más cotizados.
- Muestra el reparto entre uniformes y hogar.
- **Muestra las fallidas y lleva al listado filtrado por error.**
- Muestra cuántas nacieron del agente.

- [ ] **Paso 2: Ejecutar, implementar, verificar**

Seis bloques, cada uno con su número grande y una línea que explique qué significa. Sin
gráficos: son seis números que se leen de un vistazo, y un gráfico de seis puntos es
decoración.

El bloque de fallidas es el único con acción: lleva al listado filtrado.

Ejecutar: `npx vitest run tests/panel-metricas-ui.test.tsx` → PASA.
Ejecutar: `npm test` y `npm run build` con el grep de precios.

- [ ] **Paso 3: Commit**

```bash
git add app/cotizador tests/panel-metricas-ui.test.tsx
git commit -m "feat(panel): vista de metricas"
```

---

### Tarea 12: La nota en el contacto de GoHighLevel

**Archivos:**
- Modificar: `lib/cotizador/ghl.ts`
- Modificar: `app/api/cotizacion/route.ts`
- Test: `tests/cotizador-ghl.test.ts` (existente)

**Interfaces:**
- Produce: `notaDeCotizacion(p: { numero: string; total: number; vence: Date; enlace: string }): string`
  y su uso desde el endpoint vía `agregarNota`.

**Por qué importa más de lo que parece:** si el correo sale por Resend, GoHighLevel no se
entera. La conversación del contacto no lo muestra. **Esta nota es el único rastro** que le
dice al equipo que a ese cliente se le mandó una cotización, cuándo y por cuánto.

- [ ] **Paso 1: Escribir la prueba que falla**

En `tests/cotizador-ghl.test.ts`, pruebas para `notaDeCotizacion`: que incluya el número, el
monto formateado, la fecha de vencimiento y el enlace; y que no mencione métodos de pago.

- [ ] **Paso 2: Implementar y conectar**

Reusar `agregarNota` de `lib/agente/acciones.ts`, que ya existe y está probada. Llamarla
desde el endpoint después de que el correo salga, con el `contactId` resuelto.

Un fallo de la nota **no invalida la cotización**: se registra en `ghl_error` y nada más. El
correo ya llegó al hotel.

- [ ] **Paso 3: Verificar y commitear**

```bash
npm test
git add lib/cotizador/ghl.ts app/api/cotizacion/route.ts tests/cotizador-ghl.test.ts
git commit -m "feat(panel): nota en el contacto con el enlace a la cotizacion"
```

---

### Tarea 13: Retirar el Estimate de GoHighLevel

**Va última a propósito.** Entre quitar el Estimate y tener el reemplazo verificado hay una
ventana donde el cotizador calcula bien y no existe forma de hacerle llegar nada al cliente.

**Archivos:**
- Modificar: `lib/cotizador/ghl.ts`
- Modificar: `app/api/cotizacion/route.ts`
- Modificar: `tests/cotizador-ghl.test.ts`, `tests/api-cotizacion.test.ts`
- Modificar: `docs/superpowers/specs/2026-08-26-cotizaciones-design.md`

- [ ] **Paso 1: Comprobar que el reemplazo funciona de verdad**

**Antes de borrar nada**, crear una cotización real y verificar: el correo llega, el PDF se
abre, los montos coinciden, la nota aparece en el contacto y el listado la muestra.

**Si algo de eso falla, pará.** Esta tarea no se hace hasta que el reemplazo esté probado.

- [ ] **Paso 2: Quitar la creación del Estimate**

De `lib/cotizador/ghl.ts`, eliminar la construcción y el envío del Estimate: el cuerpo, las
fechas, `formatearTasa` si queda sin uso, y las constantes que sólo servían para eso.

**Conservar:** `resolverContacto` y `escribirContactoSinPisar` (que respetan los tags de la
base comercial), `moverOportunidad` con su verificación de etapa, y `agregarNota`.

`crearEstimate` pasa a llamarse `registrarEnCrm` y devuelve `{ ok, contactId, opportunityError? }`
sin `estimateId`.

- [ ] **Paso 3: Ajustar el endpoint y la columna**

`ghl_estimate_id` deja de escribirse. **No se borra la columna:** las cotizaciones ya creadas
la tienen poblada y borrarla perdería el rastro. Dejarla con un comentario en la migración
que diga que es histórica.

- [ ] **Paso 4: Ajustar las pruebas**

Quitar las que verifican el cuerpo del Estimate. **Conservar todas las de contacto y
oportunidad.** Si alguna prueba de contacto falla, es un bug de esta tarea.

- [ ] **Paso 5: Actualizar el diseño de la fase 1**

En `docs/superpowers/specs/2026-08-26-cotizaciones-design.md`, dejar registrado que el
Estimate se retiró en la fase 2 y por qué. Ese documento ya mintió una vez sobre el envío;
no puede volver a quedar desincronizado.

- [ ] **Paso 6: Verificar y commitear**

```bash
npm test
npm run build
git add lib app/api docs tests
git commit -m "refactor(panel): retirar el Estimate de GoHighLevel"
```

---

## Después del plan

**Antes de desplegar:** aplicar la migración `0009` antes de subir el código, y crear el
bucket `cotizaciones` como **privado**.

**Variables de entorno nuevas:** `RESEND_API_KEY` y `LUXE_CORREO_REMITENTE`.

**Configuración fuera del código:** SPF y DKIM del dominio de Luxe en Resend, y el menu link
en GoHighLevel apuntando a `https://<dominio>/cotizador`.

**Pendiente que no bloquea:** que el cliente acepte la cotización desde el correo. Con
"ganada" y "perdida" manuales, la métrica ya funciona; cuando se construya, esos mismos
estados se llenan solos sin rehacer nada.
