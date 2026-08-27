# Cotizador — diseño

Fecha: 2026-08-26

## El problema

El equipo comercial necesita armar cotizaciones, mandárselas al cliente y darles
seguimiento. La reacción natural es construir un panel de administrador: listado,
estados, búsqueda, filtros, permisos. Eso es semanas de trabajo para replicar algo que
ya existe.

**Ya existe.** GoHighLevel tiene módulo nativo de cotizaciones (Estimates), el token de
la cuenta tiene permiso, y la cuenta ya tiene un pipeline con las etapas exactas del
seguimiento comercial.

La decisión central de este diseño es por lo tanto **no construir el panel**. Se
construye únicamente lo que GoHighLevel no sabe hacer: calcular los precios y descuentos
de Luxe. Todo lo demás —almacenar, enviar, generar el PDF, registrar el estado, hacer el
seguimiento— lo pone GoHighLevel.

## Verificado contra la cuenta real

Sondeado el 2026-08-26 contra la location de producción:

| Capacidad | Estado |
|---|---|
| `GET /invoices/estimate/list` | 200 · `total: 0` |
| `GET /invoices/estimate/number/generate` | 200 · `estimateNumber: 1` |
| `GET /opportunities/pipelines` | 200 · pipeline "Marketing Pipeline" |
| `GET /medias/files` | 200 |
| `GET /products/` | 200 · catálogo vacío |

El pipeline existente tiene las etapas `New Lead → Contacted → Qualified →
**Proposal Sent** → Negotiation → Closed`. La cotización enviada mueve la Opportunity a
*Proposal Sent*.

GoHighLevel lleva la numeración correlativa: el primer Estimate será el número 1.

## Alcance

**Se construye:**

- Motor de precios y descuentos, como librería pura.
- Catálogo de 70 SKUs versionado en el repositorio.
- Pantalla de armado tras clave.
- Creación del Estimate en GoHighLevel y movimiento de la Opportunity.
- Registro en Supabase para auditoría y cola de borradores.

**No se construye** (lo pone GoHighLevel): almacenamiento de cotizaciones, envío de
correo, generación de PDF, pantalla de listado, estados, búsqueda, filtros, usuarios,
roles, permisos.

**Fuera de alcance en esta fase:** PDF con identidad de marca propia. El Estimate usa la
plantilla de GoHighLevel. Si el documento resulta insuficiente como pieza de venta, se
agrega después sin rehacer nada de lo anterior.

## Requisito explícito: la cotización no habla de pago

Luxe tiene clientes de contado, de crédito, con tarjeta y en efectivo. El vendedor
coordina el cobro directamente con cada uno.

**La cotización no menciona método de pago ni ofrece pagar en línea.** El Estimate de
GoHighLevel nace orientado al pago en línea, así que hay que configurarlo para que no
empuje a una pasarela. Esto se verifica *antes* de escribir código: es lo único que
podría invalidar el enfoque completo.

## Arquitectura

```
lib/cotizador/
  tipos.ts       · tipos compartidos: Sku, Talla, GrupoDescuento, Escala, Cotizacion
  catalogo.ts    · los 70 SKUs con precio de lista, y las 6 escalas
  calcular.ts    · función pura: líneas + catálogo → cotización
  ghl.ts         · crea el Estimate, mueve la Opportunity
app/api/cotizacion/route.ts   · endpoint tras clave
app/cotizador/page.tsx        · pantalla de armado
supabase/migrations/0005_cotizaciones.sql
```

El corazón es `calcular.ts`: una función pura, sin red, sin base de datos, sin
GoHighLevel. Recibe las líneas y devuelve la cotización con subtotales, descuento, IVA y
total. Eso permite probarla de forma exhaustiva con Vitest — y en un motor de precios eso
importa más que en otros sitios, porque un error de cálculo no revienta: cotiza mal, en
silencio, y nadie se entera hasta que se factura.

`ghl.ts` sigue el patrón ya establecido en `lib/ghl.ts` y `lib/agente/acciones.ts`:
`fetchImpl` inyectable, nunca lanza, devuelve `{ ok: false, error }`.

## El catálogo

70 SKUs: 22 uniformes, 48 ropa de cama. Fuente: `precios/uniformes-2026.xlsx` y
`precios/ropa-de-cama-2026.xlsx`, con las correcciones de la sección siguiente.

**Solo se guarda el precio de lista.** Los archivos traen tres columnas —lista, 5%, 10%—
pero las dos últimas son datos derivados: se verificaron las 72 filas del archivo contra
`lista × 0.95` y `lista × 0.90` y hay cero discrepancias. Guardar las tres columnas
significa tres lugares que actualizar en cada cambio de precio, y tarde o temprano uno
queda desincronizado. Un catálogo donde el 5% no cuadra con la lista es peor que no
tener catálogo.

```ts
type Sku = {
  id: string;              // 'uni-filipina-tradicional-mc'
  linea: 'uniformes' | 'hogar';
  familia: string;         // 'Filipinas', 'Juegos de cama 600 hilos', 'Toallas 680gm'
  nombre: string;          // lo que ve el cliente en la cotización
  talla?: Talla;           // king | queen | doble | imperial
  precioLista: number;     // colones enteros
  esSet: boolean;          // cuenta para el umbral de ropa de cama
  contenido?: string[];    // qué trae el set, desglosado
};
```

`contenido` no es decorativo. Los renglones que el archivo llama "sábana de 600 hilos
king — ₡90.000" son sets completos (cubrecama, sábana y 2 sobrefundas), no sábanas.
Cotizar eso como "sábana" le dice a un hotel que se le cobran ₡90.000 por una sábana.
El desglose va impreso en la cotización.

Las dos incoherencias de precio detectadas al revisar el catálogo contra sí mismo
resultaron ser erratas reales, y Luxe las corrigió por escrito. Van cargadas ya corregidas;
el detalle está en `precios/README.md`.

## El motor de descuentos

El descuento se calcula sobre **grupos que acumulan**, y el grupo no es el mismo en las
dos líneas. Confirmado por Luxe el 2026-08-26.

**Uniformes: un solo grupo con las 22 prendas.** Las unidades se suman a lo largo de toda
la cotización, sin importar el modelo ni la talla. El ejemplo textual de Luxe: 10
pantalones baggy + 30 filipinas + 8 mandiles = 48 prendas → 10%, aunque ningún renglón
llegue por su cuenta a 24.

| Uniformes | 1–23 | 24–47 | 48+ |
|---|---|---|---|
| | lista | 5% | 10% |

**Ropa de cama: cinco grupos**, cada uno con su propia escala. Los productos de un mismo
grupo acumulan entre sí sin importar calidad ni talla. Confirmado por Luxe el 2026-08-26:
*"puede ser de 600 y 400 mezclados o 300 y 200, sin importar; igualmente 10 king, 3 queen
y 3 doble aplica 10%"* — 16 piezas en total, aunque ninguna talla llegue sola.

| Grupo | SKUs | 5% | 10% |
|---|---:|---|---|
| Sets de cama (600/400/300/200 hilos) | 16 | 10 sets | 16 sets |
| Fundas e insertos (funda 300, funda rayada 200, inserto, pillow top) | 16 | 12 ud | 24 ud |
| Toallas (680/460/360 gm) | 13 | 24 ud | 48 ud |
| Bata blanca (grupo propio, no acumula con toallas) | 1 | 24 ud | 48 ud |
| Almohadas | 2 | 12 packs | 24 packs |

**El archivo dice 20 sets en `D3`; el umbral correcto es 16.** Luxe lo confirmó por escrito
después de mandar el archivo (*"si dejalo a partir de 16 set por favor"*). El catálogo
lleva 16 y el archivo queda desactualizado en esa celda.

### El catálogo del código es la fuente de verdad

Luxe corrigió por escrito cuatro cosas después de mandar la última versión del archivo, así
que el Excel queda desactualizado y el catálogo del repositorio manda:

| Punto | Archivo | Correcto |
|---|---|---|
| Umbral del 10% en sets (`D3`) | 20 sets | **16 sets** |
| Toalla facial 680gm (fila 53) | ₡3.500 | **₡3.000** |
| Toalla de mano 680gm (fila 54) | ₡3.000 | **₡3.500** |
| Toalla de pie (filas 55, 62, 69) | tres filas por gramaje | **una sola, ₡5.000, sin gramaje** |

La corrección de la facial y la de mano no es cosmética: con ella, la facial pasa a ser más
barata que la de mano en los tres gramajes, que era la incoherencia detectada al revisar el
catálogo contra sí mismo.

**Riesgo a vigilar:** la próxima actualización de precios va a llegar como un Excel nuevo.
Si sale del archivo actual, reintroduce las cuatro. Conviene que Luxe corrija su copia
antes de la siguiente ronda.

### Contenido de los sets

Va impreso en la cotización, desglosado:

- **king, queen, doble** — cubrecama, sábana y 2 sobrefundas.
- **imperial** — cubrecama, sábana y 1 sobrefunda. `imperial`, `individual` y `twin` son
  la misma talla; el catálogo usa `imperial`.

Los seis grupos usan **el mismo algoritmo** y solo cambian los números: sumar las
cantidades del grupo en la cotización, buscar el escalón que alcanza, aplicar el
porcentaje. Por eso no hay estrategias intercambiables —serían andamiaje para una sola
estrategia—: las escalas son datos en `catalogo.ts`, un umbral y un porcentaje por grupo, y
`calcular` las recorre. Agregar una familia o corregir un umbral no toca `calcular.ts` ni
sus pruebas.

Ningún escalón se aplica a mano: las seis escalas están completas.

### Bordado

Incluido hasta 10×10 cm a un color, en el precio de la prenda. Más grande o a varios
colores, el precio varía según muestra.

No es una línea de precio: es una **nota fija** en la cotización, más una marca de
"bordado especial — cotizar aparte" que bloquea el envío con precio en firme cuando el
cliente pide algo fuera del estándar. Sin esa marca, una cotización de 500 filipinas con
logo a cuatro colores saldría al precio del bordado sencillo.

### Dinero

**Colones enteros, en enteros.** `0.1 + 0.2` en JavaScript no da `0.3`; en una cotización
de 3.000 piezas ese error se acumula y produce un total que no cuadra con la suma de sus
propias líneas — el tipo de detalle que un cliente B2B sí nota.

Redondeo al colón entero, medio hacia arriba, **sobre el precio unitario ya descontado**;
el subtotal de la línea es ese unitario por la cantidad. El orden importa: la cotización
muestra precio unitario y total de línea, y si se redondeara el total, el unitario impreso
multiplicado por la cantidad no daría el total impreso. Un cliente que saca la calculadora
encuentra la diferencia. Hoy todos los precios dan exacto porque son redondos; la regla
queda fijada antes de que aparezca uno que no lo sea.

### IVA

Los dos archivos dicen que los precios no incluyen IVA. Luxe confirmó el formato el
2026-08-26: **el total va primero y el IVA se suma abajo**, calculado sobre el subtotal ya
descontado.

**La tasa es un campo, no una constante.** Luxe tiene pendiente confirmar con su contador
si hay ventas a tasa reducida —surgió a propósito de una cotización de uniformes para un
colegio, posiblemente al 1%—. Costa Rica tiene tasas reducidas además del 13% general, así
que escribir `0.13` dentro del cálculo obligaría a tocar el motor la primera vez que
aparezca una. El vendedor elige la tasa al armar la cotización y el valor por defecto es
13%.

## Flujo

```
Vendedor arma en /cotizador  ─┐
                              ├─→ calcular() ─→ vista previa en vivo
Agente IA deja borrador     ─┘                        │
                                                 [Aprobar]
                                                      ↓
                              Supabase (registro)  →  GHL Estimate
                                                      ↓
                                        GHL manda el correo con el PDF
                                                      ↓
                                     Opportunity → etapa "Proposal Sent"
```

**Primero Supabase, después GoHighLevel.** Si GoHighLevel falla, la fila queda con
`ghl_error` poblado y la cotización es recuperable — igual que los leads hoy. Al revés,
un fallo de red después de crear el Estimate dejaría al cliente con una cotización que
Luxe no tiene registrada.

El seguimiento comercial vive en GoHighLevel. Supabase guarda el registro de auditoría y
la cola de borradores, y **no es la fuente de verdad del estado comercial**: dos sistemas
reclamando ser la verdad sobre el estado de una cotización es una fuente garantizada de
bugs.

## Base de datos

`supabase/migrations/0005_cotizaciones.sql` — una tabla.

```sql
create table public.cotizaciones (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  origen        text not null,          -- 'humano' | 'agente'
  estado        text not null,          -- 'borrador' | 'enviada' | 'error'
  contact_id    text,                   -- contacto de GoHighLevel
  cliente       jsonb not null,         -- nombre, empresa, correo
  lineas        jsonb not null,         -- sku, cantidad, precio aplicado
  totales       jsonb not null,         -- subtotal, descuento, iva, total
  ghl_estimate_id text,
  ghl_error     text
);
```

`lineas` y `totales` guardan **el resultado del cálculo, no una referencia al catálogo**.
Una cotización enviada hace tres meses tiene que poder reimprimirse con los precios que
tenía ese día, no con los de hoy.

## Interfaz

`app/cotizador/page.tsx`, detrás de la misma clave del taller (`app/q7m4/`). Sin login,
sin usuarios, sin roles.

Buscador de SKU, cantidad por línea, y el total recalculándose en vivo con el descuento
aplicado y el motivo visible ("48 unidades → 10%"). Que el vendedor vea *por qué* se
aplicó el descuento es lo que permite detectar una regla mal configurada antes de que
salga una cotización con el precio equivocado.

Una sección aparte lista los borradores que dejó el agente, pendientes de aprobación.

## El agente

**El prompt del agente no cambia.** Sigue diciendo "nunca das precios, ni rangos de
precio, ni descuentos" (`lib/agente/config.ts`). El agente no cotiza en el chat.

Lo que hace es reunir los insumos —línea, producto, cantidad— y dejar un borrador en la
cola. Un vendedor lo revisa, ajusta si hace falta y lo envía. El cliente nunca recibe un
precio que nadie miró.

Esto obliga a un cambio en el esquema de datos del agente: `Datos` hoy tiene nombre,
correo, teléfono, producto y ubicación, y necesita también cantidad. Toca `cerebro.ts`
(el esquema de la API y el de Zod), `estado.ts` y el jsonb de `agente_conversaciones`.

**Va de último a propósito.** El agente responde hoy a clientes reales. Meterle mano
antes de que el motor de precios esté probado es arriesgar algo que funciona por algo que
todavía no.

## Pruebas

Vitest, ya configurado.

El motor de cálculo se prueba con tablas de casos y **no necesita los precios reales**:
se prueba con un catálogo de prueba. Casos obligatorios: los bordes de cada uno de los seis
escalones, cotización mixta de las dos líneas, el ejemplo textual de Luxe (10 king + 3
queen + 3 doble = 16 sets → 10%), la bata que no acumula con las toallas, tasa de IVA
distinta de 13%, y redondeo con un precio que no sea redondo.

`ghl.ts` se prueba con `fetchImpl` simulado, igual que el resto del proyecto.

## Orden de construcción

1. **Verificar el Estimate sin cobro** contra GoHighLevel. Antes de escribir código.
   Es el único hallazgo que puede invalidar el enfoque.
2. Motor de cálculo y sus pruebas.
3. Catálogo con los 70 SKUs.
4. Pantalla de armado y endpoint.
5. Integración con GoHighLevel.
6. Cola de borradores del agente.

## Supuestos vigentes

**Ninguno pendiente que afecte el cálculo.** Las diez preguntas de
`docs/cotizaciones-preguntas-luxe.md` están resueltas salvo una: si existen ventas a tasa
reducida de IVA, que Luxe consulta con su contador. El motor ya trata la tasa como un
campo, así que esa respuesta no bloquea nada.

Decisiones de normalización, todas en `catalogo.ts`:

- `matrimonial` y `doble` son la misma talla; el catálogo usa `doble`.
- `individual`, `twin` e `imperial` son la misma talla; el catálogo usa `imperial`.
- El precio de almohadas es por paquete, y un paquete cuenta como una unidad.
- La bata blanca se muestra en la categoría de toallas pero acumula en su propio grupo.

## Riesgo abierto

El PDF del Estimate es plantilla de GoHighLevel: admite logo y términos, pero no es un
documento de marca. Para una empresa que vende textiles de lujo, la cotización es una
pieza de venta. Si el resultado se ve pobre, la fase 2 genera un PDF propio, lo sube a la
biblioteca de GoHighLevel y lo adjunta al Estimate. Nada de lo anterior se rehace.

## Nota de seguridad — resuelta

Los `.xlsx` estaban en la raíz y `.vercelignore` no excluía `*.xlsx`, así que la lista de
precios completa habría subido en el próximo despliegue. Los archivos se movieron a
`precios/` y ese directorio está excluido del despliegue.
