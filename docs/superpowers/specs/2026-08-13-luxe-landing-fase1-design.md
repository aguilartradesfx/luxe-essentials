# Luxe Essentials — Landing Page (Fase 1)

**Fecha:** 2026-08-13
**Estado:** Diseño aprobado en conversación, pendiente de revisión escrita
**Fase:** 1 de 2 (Fase 2 = agente de IA conectado a GHL y al sitio)

---

## 1. Contexto

Luxe Essentials es la casa matriz de una operación de manufactura textil en Guatemala.
Tiene dos marcas de cara al cliente:

- **The Chef's Store** — uniformes industriales y corporativos (identidad verde/negro).
- **BDE — Bodega del Edredón** — textiles de hogar y ropa de cama (retail/distribución).

Esta lectura se sostiene en la evidencia de los materiales entregados: el deck
`presentacion Luxe 2026.pdf` dedica su primera mitad a capacidad de planta (corte, diseño,
bordado, bodega de telas, empaque, carga de contenedores), que es relato de manufacturera,
no de producto. La paleta de Luxe (navy/teal/beige) no coincide con la de ninguna de las dos
marcas hijas precisamente porque se sitúa por encima de ellas.

### Materiales de origen

| Archivo | Contenido | Uso en el sitio |
|---|---|---|
| `LOGO.svg` | Logotipo Luxe Essentials, paths vectorizados, negro sólido | Identidad principal |
| `Paleta de colores .jpg` | 5 colores con hex | Sistema de color |
| `presentacion Luxe 2026.pdf` | 22 págs, solo imagen, deck de The Chef's Store | Fuente de contenido (vía transcripción) |
| `Textos_presentacion_Luxe_2026.pdf` | Transcripción textual del deck anterior | Fuente de copy de uniformes y capacidad |
| `Transcripcion_Catalogo_BDE_Junio_2026.pdf` | Catálogo BDE junio 2026 con precios y SKUs | Fuente de categorías de hogar (sin precios) |

---

## 2. Objetivo y métrica

**Objetivo único:** generar cotizaciones B2B calificadas.

**Métrica norte:** número de envíos completados del formulario de cotización que llegan
a GoHighLevel como contacto.

**Audiencia:** responsable de compras u operaciones en restaurantes, hoteles, hospitales,
constructoras e industria; y distribuidores de textiles de hogar.

**Pregunta que la página debe responder:** "¿Esta fábrica aguanta mi volumen y puede
personalizar lo que necesito?"

---

## 3. Alcance

### Dentro de la Fase 1

- Landing de una sola página larga, responsive, en español.
- Formulario de cotización con persistencia en Supabase y sincronización a GHL.
- Optimización de las 14 fotografías entregadas y sistema de manifest que permite añadir las
  que faltan sin tocar código.
- Repositorio en GitHub y despliegue en Vercel, ambos creados vía API REST con tokens.

### Fuera de la Fase 1 (YAGNI explícito)

- E-commerce, carrito o pagos.
- Catálogo navegable con SKUs y precios. Los precios del catálogo BDE son de junio 2026,
  de lista de distribuidor, y cambian; publicarlos es un pasivo, no un activo.
- CMS, autenticación, blog, área de cliente.
- Versión en inglés.
- El agente de IA (Fase 2). No requiere preparación especial en Fase 1 más allá de dejar
  el pipeline de GHL funcionando.

---

## 4. Identidad de marca

### 4.1 Color

Paleta de origen, sin alterar:

| Token | Hex | Rol |
|---|---|---|
| `--navy` | `#2F4156` | Color de marca, base de superficies |
| `--teal` | `#567C8D` | Acento, bordes, degradados de fondo |
| `--sky` | `#C8D9E6` | Texto secundario, acentos claros |
| `--beige` | `#F5EFEB` | Texto principal, relleno de botón primario |
| `--white` | `#FFFFFF` | Capas de vidrio (con alfa), detalles |

Tokens derivados:

| Token | Valor | Rol |
|---|---|---|
| `--bg-deep` | `#1A2634` | Fondo base de la página (navy oscurecido) |
| `--glass-fill` | `rgba(255,255,255,0.08)` | Relleno de tarjetas de vidrio |
| `--plate-fill` | `rgba(245,239,235,0.92)` | Relleno de placa clara para fotografía |
| `--glass-border` | `rgba(255,255,255,0.15)` | Borde de 1px de tarjetas |
| `--glass-shadow` | `0 8px 32px rgba(0,0,0,0.25)` | Sombra de elevación |

### 4.2 Decisión: base oscura

El sitio usa **navy profundo como fondo base**, no beige ni blanco.

Razón: el glassmorphism depende de que haya color y profundidad detrás del vidrio. Sobre
fondos claros el efecto se lee como suciedad y el texto sobre blur pierde contraste. Con base
oscura, beige y sky funcionan como texto de alto contraste y el vidrio se percibe como vidrio.

Contrastes verificados contra `--bg-deep`:

| Combinación | Ratio aprox. | Cumple |
|---|---|---|
| Beige `#F5EFEB` sobre navy | ~8.3:1 | AAA |
| Sky `#C8D9E6` sobre navy | ~6.3:1 | AA |
| Beige sobre teal `#567C8D` | ~3.9:1 | Solo texto grande |

Consecuencia de diseño: **el botón primario es relleno beige con texto navy** (~8.3:1), no
relleno teal. El teal queda para bordes, acentos y degradados de fondo. El botón secundario
es vidrio con borde sky.

### 4.3 Tipografía

El logotipo está vectorizado (paths), no hay fuente viva disponible. Se emparejan:

- **Display / títulos:** Playfair Display — serif de alto contraste, congruente con el logotipo.
- **Texto / UI:** Inter.

Ambas self-hosted vía `next/font`, sin peticiones a dominios externos.

### 4.4 Logotipo

`LOGO.svg` es negro sólido sobre transparente. Sobre fondo navy se invierte a beige/blanco
manipulando el `fill` de los paths. Se generan dos variantes en `public/brand/`:
`logo-light.svg` (para fondos oscuros) y `logo-dark.svg` (el original, para OG y favicon).

---

## 5. Arquitectura de información

Página única con anclas. Orden y contenido:

### 5.1 Hero

- Logotipo Luxe Essentials.
- H1 propuesto: *"Fabricamos lo que tu operación viste y usa todos los días."*
- Subtítulo propuesto: *"Planta propia en Guatemala. Diseño, corte, bordado, auditoría de
  calidad y empaque bajo un mismo techo, con capacidad para producción industrial."*
- Cuatro atributos tomados del deck: *Diseño personalizado · Calidad garantizada ·
  Confección industrial · Imagen que representa*.
- CTA primario "Solicitar cotización" (ancla al formulario).
- CTA secundario "Conocer nuestras líneas".
- Imagen: `corporativo-camisas-pantalones` (modelos con uniforme corporativo). Es la única
  toma con personas y alta resolución, lo que la hace la mejor portada disponible.

### 5.2 Capacidad instalada

Copy derivado de la página 2 del deck: departamento de corte y diseño, capacidad de imprimir
o desarrollar trazos propios, auditoría de calidad, logística y bodega de accesorios, bordado,
bodega de telas y producto terminado, empaque, y área de carga con capacidad para cuatro
contenedores simultáneos.

### 5.3 Cifras

Tres cifras en tarjetas de vidrio, todas verificables en el deck:

- **250** operarios en planta (deck pág. 3).
- **4** contenedores cargando simultáneamente (deck pág. 2).
- **8** áreas productivas (corte, diseño y patronaje, bordado, bodega de telas, empaque,
  auditoría de calidad, logística y accesorios, carga) — derivado de la enumeración del deck.

### 5.4 Las dos líneas

Dos tarjetas grandes de vidrio, una por línea. Sin precios, sin SKUs.

**Uniformes — The Chef's Store**
Filipinas (ejecutiva, clásica, premium), gorros de chef y gorras, camisas tipo Columbia,
camisas industriales con reflectivo, playeras y pantalones industriales, pantalones de denim,
polos de tejido plano, prendas deportivas, chalecos corporativos, chaquetas ejecutivas,
sets de médicos.

**Hogar — Bodega del Edredón**
Almohadas, sets de sábanas de 200 a 600 hilos, fundas e insertos de duvet, cubrecamas y
edredones, toallas y accesorios de baño, línea infantil, maternidad y bebé, protectores
y accesorios.

Imágenes: la línea de uniformes usa `cocina-linea-completa`. **La línea de hogar no tiene
fotografía disponible** (ver §7.3); se resuelve con una composición tipográfica sobre vidrio,
sin imagen, hasta que lleguen las tomas.

Debajo de la tarjeta de uniformes, una galería con las once tomas de producto disponibles
(§7.2), cada una en placa clara con su rótulo.

### 5.5 Proceso de fábrica

Secuencia de siete pasos en tarjetas de vidrio: diseño y patronaje → corte → confección →
bordado y personalización → auditoría de calidad → empaque → carga y logística.

Sólo un paso tiene fotografía: `planta-bordado`, que se usa como imagen destacada de la
sección. Los otros seis pasos se representan con tarjetas de vidrio tipográficas con icono,
sin foto. Esto es una decisión, no una carencia disimulada: seis placeholders vacíos junto a
una foto real se leerían como sitio incompleto, mientras que una secuencia tipográfica
uniforme con una sola foto de apoyo se lee como diseño intencional.

Cuando lleguen las tomas de planta, cada paso adopta su imagen sin cambio estructural.

### 5.6 Personalización

Técnicas confirmadas en el deck: bordado, serigrafía, DTF y sublimación. Más colores, tallas
y trazos a la medida.

Sin imagen propia: la única toma de bordado disponible se usa en §5.2, y repetirla aquí
debilitaría ambas apariciones. La sección se resuelve como bloque tipográfico sobre vidrio.

### 5.7 Formulario de cotización

Campos:

| Campo | Tipo | Requerido |
|---|---|---|
| `nombre` | texto | Sí |
| `empresa` | texto | No |
| `email` | email | Sí |
| `telefono` | tel | No |
| `linea` | select: `uniformes` \| `hogar` \| `ambas` | Sí |
| `cantidad` | texto libre (rango aproximado de piezas) | No |
| `mensaje` | textarea | No |

Estados explícitos de UI: reposo, enviando, éxito, error de validación, error de servidor.
El estado de éxito confirma recepción y da el siguiente paso esperado.

### 5.8 Footer

Logotipo, las dos líneas, datos de contacto (placeholder), dirección (placeholder),
redes sociales (placeholder), aviso de derechos.

---

## 6. Arquitectura técnica

### 6.1 Stack

- Next.js con App Router, TypeScript estricto.
- Tailwind CSS v4, tokens de marca declarados en `@theme`.
- Supabase para persistencia de leads.
- GoHighLevel como destino comercial de los leads.
- Vercel para hosting.

Elegido por coherencia con las variables `NEXT_PUBLIC_*` ya presentes en `.env.local`.

### 6.2 Estructura

```
app/
  layout.tsx           fuentes, metadata, fondo global
  page.tsx             composición de secciones
  api/lead/route.ts    handler del formulario (server-only)
components/
  sections/            una por sección de §5
  ui/                  GlassCard, Button, Field, Figure
  background/          AuroraBackground (blobs animados)
content/
  copy.ts              todo el texto del sitio, centralizado
  media.ts             manifest de imágenes
lib/
  supabase/server.ts   cliente con service role, server-only
  ghl.ts              cliente de GoHighLevel
  validation.ts        esquema del formulario
public/
  brand/               logo-light.svg, logo-dark.svg
  images/              imágenes reales (mañana) y placeholders hoy
scripts/
  ghl-discover.mjs     descubre pipelines y custom fields de GHL
supabase/
  migrations/          SQL versionado
```

Todo el copy vive en `content/copy.ts`. Ninguna cadena de texto de cara al usuario se escribe
inline en un componente. Esto hace barato traducir a inglés más adelante y permite que el
cliente revise el texto en un solo archivo.

### 6.3 Flujo del lead

```
Formulario (cliente)
  → POST /api/lead  (route handler, runtime Node)
      1. Valida el payload
      2. INSERT en Supabase  ← se escribe ANTES de llamar a GHL
      3. Upsert de contacto en GHL
      4. UPDATE de la fila con ghl_contact_id o ghl_error
  → respuesta al cliente
```

**El orden es deliberado.** Supabase se escribe primero para que un fallo de GHL —token
vencido, cambio de API, caída— no pierda el lead. Las filas con `ghl_error` no nulo son
la cola de reintento.

El paso 3 nunca bloquea la respuesta de éxito al usuario si el paso 2 tuvo éxito: el lead
ya está guardado y recuperable.

Las credenciales de Supabase (service role) y de GHL sólo se leen en el servidor. Nunca se
exponen al cliente ni se importan desde un componente cliente.

### 6.4 Modelo de datos

```sql
create table public.leads (
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
-- Sin políticas públicas: sólo el service role escribe, desde el route handler.
```

Se captura `utm` (jsonb) desde los parámetros de la URL para atribuir campañas cuando se
activen los tags de tracking que ya están previstos como variables comentadas en `.env.local`.

### 6.5 Integración con GoHighLevel

Variables ya presentes: `LUXE_GHL_API_KEY`, `LUXE_GHL_LOCATION_ID`. El prefijo `LUXE_` es
intencional y debe conservarse: evita la colisión con la variable global `GHL_LOCATION_ID`
que el shell exporta.

Alcance de Fase 1: crear o actualizar el contacto con nombre, email, teléfono, empresa,
etiquetas (`landing`, `luxe-web`, y la línea de interés) y una nota con el mensaje y la
cantidad estimada.

**Trabajo de descubrimiento requerido antes de implementar.** Dos cosas no se pueden asumir:

1. Si `LUXE_GHL_API_KEY` es una llave de ubicación v1 o un token v2. El endpoint, los
   headers y la forma del payload difieren.
2. Los identificadores de pipeline y etapa, necesarios si se quiere crear una oportunidad
   además del contacto.

`scripts/ghl-discover.mjs` resuelve ambas: prueba la autenticación y lista pipelines y
custom fields. La creación de oportunidad sólo se implementa si el descubrimiento devuelve
un pipeline utilizable; si no, Fase 1 cierra con contacto etiquetado más nota, que ya es
suficiente para operar comercialmente.

### 6.6 Infraestructura

Repositorio de GitHub y proyecto de Vercel se crean **por API REST** usando
`GITHUB_ACCESS_TOKEN` y `VERCEL_ACCESS_TOKEN` de `.env.local`. No se usa el CLI de Vercel:
está autenticado contra otra cuenta y produciría el despliegue en el lugar equivocado.

Las variables de entorno se cargan en el proyecto de Vercel vía API. `.env.local` nunca se
commitea; `.gitignore` ya lo cubre y esto se verifica antes del primer push.

---

## 7. Imágenes

### 7.1 Origen

La carpeta `IMÁGENES/` contiene 14 archivos JPEG con nombres autogenerados
(`Generated Image August 11, 2026 - 4_04PM.jpg` y similares), 124 MB en total. Once están a
5436×3072 y tres a 1359×768. Todas corresponden a páginas identificables del deck, lo que
permitió mapearlas sin ambigüedad.

Los nombres de origen no se conservan: no son estables ni descriptivos. Se renombran al `id`
del manifest durante la optimización.

### 7.2 Inventario y mapeo

| `id` | Contenido | Pág. deck | Sección |
|---|---|---|---|
| `corporativo-camisas-pantalones` | Camisas y pantalones corporativos, con modelos | 13 | Hero |
| `planta-bordado` | Área de bordado en operación | 6 | Proceso |
| `cocina-linea-completa` | Filipinas, delantal, gorros, pantalones | 10–11 | Línea uniformes |
| `cocina-filipinas` | Filipinas: negra, blanca, vivo rosado, roja, denim | 11 | Galería |
| `cocina-gorros-pantalones` | Gorras, gorros de chef, pantalón pied-de-poule | 12 | Galería |
| `camisas-columbia` | Camisas tipo Columbia, caqui + 6 colores | 14 | Galería |
| `camisas-industriales-reflectivo` | Camisas industriales con reflectivo | 15 | Galería |
| `playeras-pantalones-industriales` | Playeras y pantalones industriales reflectivos | 16 | Galería |
| `pantalones-denim-reflectivo` | Pantalones de denim con reflectivo | 17 | Galería |
| `polos-tejido-plano` | Polos + muestrario de colores | 18 | Galería |
| `deportivas` | Hoodie, ¼ zip, vestido deportivo, blusa | 19 | Galería |
| `chalecos-corporativos` | Chaleco ejecutivo y enguatado | 20 | Galería |
| `chaquetas-ejecutivas` | Chaquetas ejecutivas | 21 | Galería |
| `set-medicos` | Scrubs negro, blanco y azul marino | 22 | Galería |

### 7.3 Huecos conocidos

1. **Línea de hogar: cero imágenes.** No hay sábanas, edredones, almohadas ni toallas.
   Se resuelve tipográficamente (§5.4).
2. **Planta: una sola imagen**, y es la de menor resolución. Faltan corte, confección, bodega
   de telas, auditoría de calidad, empaque y carga de contenedores. Se resuelve
   tipográficamente (§5.5).
3. **Sin imagen Open Graph.** Se genera desde `corporativo-camisas-pantalones` recortada a
   1200×630 con el logotipo sobrepuesto.

Ambos huecos están declarados en el manifest con `pending: true`, de modo que la lista de
fotos por pedir se lee del código y no de este documento.

### 7.4 Manifest

`content/media.ts` declara cada imagen:

```ts
{ id: 'planta-bordado', ratio: '16:9',
  alt: 'Operarias trabajando en máquinas bordadoras industriales',
  brief: 'Área de bordado en operación' }
```

`<Figure id="planta-bordado" />` resuelve la entrada y renderiza `public/images/<id>.webp`
vía `next/image`. Si la entrada tiene `pending: true`, renderiza un marcador SVG generado
localmente con la paleta de marca y el `brief` encima — nunca un servicio externo tipo
Unsplash o placehold.co, que añade peticiones a terceros y hay que desconectar después.

El `alt` es obligatorio en todas las entradas, incluidas las pendientes.

### 7.5 Optimización

`scripts/optimize-images.mjs`, con **sharp** (ya presente como dependencia de Next.js):

- Redimensiona a un máximo de 2400 px de ancho, sin ampliar las que ya son menores.
- Codifica a **WebP con calidad 80**. Se elige WebP y no AVIF como formato de origen porque
  `next/image` genera de todos modos las variantes de entrega (AVIF y WebP) por tamaño de
  pantalla; el archivo en el repositorio sólo necesita ser una fuente ligera y sin pérdida
  generacional visible.
- Elimina metadatos EXIF.
- Escribe en `public/images/<id>.webp` e imprime el peso antes y después.

El script es idempotente y toma el mapeo de `IMÁGENES/` a `id` de una tabla explícita en su
código, para que renombrar o reprocesar no dependa del orden del directorio.

**Los originales no se versionan.** `IMÁGENES/` se añade a `.gitignore`: son 124 MB que no
aportan nada al repositorio y encarecen cada clonación. Permanecen en el disco del usuario
como respaldo.

---

## 8. Dirección visual

### 8.1 Fondo

`AuroraBackground`: tres manchas radiales desenfocadas en teal y sky sobre `--bg-deep`,
con desplazamiento lento en bucle. Es el elemento que da al vidrio algo que refractar.

Implementado con transformaciones CSS sobre elementos posicionados y `filter: blur()`.
Sin canvas, sin librerías de animación, sin dependencias.

### 8.2 Vidrio: dos variantes

`GlassCard` es el único componente que produce superficies de vidrio; ninguna sección
reimplementa el efecto. Tiene dos variantes que comparten borde, radio, blur y sombra, y sólo
difieren en el relleno:

- **`dark`** (por defecto) — `--glass-fill` sobre el fondo navy. Para texto, cifras,
  pasos de proceso y el formulario.
- **`plate`** — `--plate-fill`, claro. Exclusiva para fotografía de producto.

La variante `plate` existe por una razón concreta: trece de las catorce imágenes son tomas de
producto sobre fondo blanco. Colocadas directamente sobre el navy se leerían como recortes
mal hechos. Sobre una placa clara, ese fondo blanco se integra y la toma se lee como plato de
catálogo deliberado.

**No se recorta el fondo blanco por procesamiento automático.** Varias prendas son blancas
—los scrubs de `set-medicos`, la filipina de `cocina-linea-completa`, la camisa de
`corporativo-camisas-pantalones`— y cualquier umbral que elimine el fondo se comería también
la prenda.

Al implementar la variante `plate` se probará `mix-blend-mode: multiply` sobre el relleno
beige, que funde el fondo blanco con la placa. Si las prendas blancas pierden definición, se
descarta el modo de fusión y la placa queda plana. Es una verificación visual, no un punto
abierto del diseño: ambas salidas son aceptables.

Regla dura, en ambas variantes: **el texto nunca se apoya sobre blur puro.** Todo bloque de
texto vive dentro de una capa con relleno suficiente para sostener el contraste de §4.2.

### 8.3 Movimiento y accesibilidad

- `prefers-reduced-motion: reduce` detiene la animación del fondo y las transiciones de entrada.
- Navegación completa por teclado con foco visible sobre fondo oscuro.
- Jerarquía de encabezados correcta, un solo `h1`.
- Toda imagen con `alt` desde el manifest; los placeholders también.
- El formulario asocia etiquetas y anuncia errores de validación a lectores de pantalla.

---

## 9. Supuestos

Registrados para que sean fáciles de refutar:

1. **Luxe Essentials es la casa matriz** de The Chef's Store y BDE, no el rebrand de una sola.
2. **Español únicamente.** El copy centralizado abarata añadir inglés después.
3. **Sede en Guatemala**, deducido de los precios en quetzales y la dirección en zona 5
   del catálogo BDE.
4. Las líneas conservan sus nombres actuales, "The Chef's Store" y "Bodega del Edredón",
   presentadas bajo Luxe Essentials.

## 10. Datos pendientes

No están en los materiales entregados. Van como placeholder visible en el sitio, marcados
para reemplazo:

- Teléfono, WhatsApp y correo de contacto de Luxe Essentials.
- Dirección de la planta y de oficinas.
- Redes sociales.
- Dominio definitivo (afecta `NEXT_PUBLIC_SITE_URL`, metadata y OG).

Fotografía pendiente (detalle en §7.3), listada aquí como pedido para producción:

- **Línea de hogar**, prioridad alta: cama vestida, sets de sábanas, edredones y cubrecamas,
  toallas y baño. Sin esto la línea se presenta sólo con tipografía.
- **Planta**, prioridad media: área de corte, confección, bodega de telas, auditoría de
  calidad, empaque y carga de contenedores. La panorámica de planta y la toma de los cuatro
  contenedores son las de mayor rendimiento para el argumento de capacidad.

---

## 11. Criterios de aceptación

1. La landing se despliega en Vercel desde un repositorio de GitHub creado vía API, en la
   cuenta correspondiente a los tokens entregados.
2. Un envío del formulario crea una fila en `public.leads` y un contacto etiquetado en GHL.
3. Un fallo de GHL deja la fila en Supabase con `ghl_error` poblado y aun así muestra éxito
   al usuario.
4. Ninguna credencial de servidor aparece en el bundle del cliente.
5. Las catorce imágenes disponibles se sirven optimizadas desde `public/images/`, con un peso
   total en el repositorio por debajo de 8 MB frente a los 124 MB de origen. Las entradas
   marcadas `pending: true` muestran marcador de marca y se resuelven colocando el archivo,
   sin cambios de código.
6. Los contrastes de §4.2 se cumplen en el sitio construido.
7. El sitio es usable con teclado y respeta `prefers-reduced-motion`.
8. Todo el texto de cara al usuario reside en `content/copy.ts`.
