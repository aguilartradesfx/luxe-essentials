// El documento que recibe el hotel. Hasta ahora se usaba la plantilla
// genérica de un Estimate de GoHighLevel; esta es la pieza propia de Luxe.
//
// @react-pdf/renderer en vez de una librería que abre Chromium: esas pesan
// cientos de megas, rozan el límite de bundle de Vercel y fallan de formas
// difíciles de diagnosticar. Ésta es JavaScript puro, corre en Node sin
// navegador, y usa su propio motor de layout (flexbox, no HTML/CSS real) —
// se diseña para la herramienta, no se convierte desde una página web.
//
// Misma protección que catalogo.ts/escalas.ts/calcular.ts (ronda de
// correcciones 1): sin esto, nada impide que alguien importe este módulo
// desde un componente de cliente y arrastre 652 KB de fuentes embebidas al
// navegador. Este módulo no lee precios de lista ni escalas — recibe una
// `Cotizacion` ya calculada — pero igual solo tiene sentido correr en el
// servidor (usa `node:fs`/`node:path` para leer las fuentes del disco).
import 'server-only';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  Font,
  renderToBuffer,
} from '@react-pdf/renderer';
import type { Cotizacion, LineaCalculada } from '@/lib/cotizador/tipos';
import { formatearFechaLargaCR } from '@/lib/cotizador/fechas';

// Los 14 fonts estándar de PDF (Helvetica, Times, etc.) usan una codificación
// de 8 bits que NO incluye el signo de colón costarricense (₡, U+20A1): sin
// una fuente propia embebida, react-pdf lo reemplaza en silencio por "¡" y el
// documento sale con el símbolo de moneda roto. Por eso se registran acá dos
// fuentes reales, subseteadas a Latín + símbolos de moneda para que el PDF
// generado no pese de más:
//   - Inter (la misma que usa el sitio, ver app/layout.tsx): texto y datos.
//   - Playfair Display (también del sitio): el nombre de Luxe y el total,
//     para que la pieza no se lea a formulario administrativo.
// Licencias OFL de ambas en lib/cotizador/fonts/OFL-*.txt.
const DIR_FONTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fonts');

Font.register({
  family: 'Inter',
  fonts: [
    { src: path.join(DIR_FONTS, 'Inter-Regular.ttf'), fontWeight: 'normal' },
    { src: path.join(DIR_FONTS, 'Inter-SemiBold.ttf'), fontWeight: 600 },
    { src: path.join(DIR_FONTS, 'Inter-Bold.ttf'), fontWeight: 'bold' },
  ],
});

Font.register({
  family: 'Playfair Display',
  fonts: [
    { src: path.join(DIR_FONTS, 'PlayfairDisplay-SemiBold.ttf'), fontWeight: 600 },
    { src: path.join(DIR_FONTS, 'PlayfairDisplay-Bold.ttf'), fontWeight: 'bold' },
  ],
});

// El hifenador por defecto de react-pdf no conoce reglas del español y corta
// palabras en lugares que no son un guion válido en este idioma — por eso NO
// se usa tal cual. Pero apagarlo del todo (devolver la palabra entera
// siempre) tiene un costo que se descubrió en la ronda de correcciones 1: un
// token sin espacios más largo que la columna (un SKU o código pegado, por
// ejemplo) no tiene entonces NINGÚN punto de corte, y el motor de layout lo
// deja desbordar por encima de las columnas vecinas — en la tabla de
// productos, tapando las cifras de cantidad y precio. Ningún nombre real del
// catálogo (ver lib/cotizador/catalogo.ts) se acerca a los
// `LARGO_MAX_SIN_CORTE` caracteres, así que esto nunca hifena una palabra
// real: sólo actúa como corte de emergencia para el caso patológico.
const LARGO_MAX_SIN_CORTE = 30;
Font.registerHyphenationCallback((palabra) => {
  if (palabra.length <= LARGO_MAX_SIN_CORTE) return [palabra];
  const trozos: string[] = [];
  for (let i = 0; i < palabra.length; i += 15) trozos.push(palabra.slice(i, i + 15));
  return trozos;
});

export type ClienteDocumento = {
  nombre: string;
  empresa?: string;
  email: string;
  telefono?: string;
  direccion?: string;
};

export type DatosDocumento = {
  numero: string;
  cotizacion: Cotizacion;
  cliente: ClienteDocumento;
  emitida: Date;
  vence: Date;
};

// Mismo texto que `NOTA_BORDADO`/el aviso de bordado especial en
// `lib/cotizador/ghl.ts`, duplicado a propósito: ese módulo no exporta estas
// constantes (son privadas del payload de GoHighLevel) y este documento no
// depende del Estimate de GHL para existir — es la pieza que lo reemplaza.
const NOTA_BORDADO =
  'Incluye bordado de hasta 10x10 cm a un color. Bordados de mayor tamaño o a varios colores se cotizan por separado según muestra.';
const NOTA_BORDADO_ESPECIAL =
  'El bordado solicitado excede el estándar: el precio final se confirma contra muestra.';

// Colones sin decimales, con "." como separador de miles — mismo criterio
// que `colones()` en app/cotizador/Cotizador.tsx: no se usa
// `toLocaleString`/`Intl.NumberFormat` porque el separador de miles que trae
// el runtime de Node para `es-CR` varía entre versiones de ICU (a veces un
// espacio, no un punto), y un documento que ve el cliente no puede depender
// de eso.
function colones(valor: number): string {
  return `₡${Math.round(valor).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}

// Mismo criterio que `formatearTasa` en lib/cotizador/ghl.ts (no exportada,
// se duplica aquí por la misma razón que las notas de arriba): hasta dos
// decimales, sin ceros de más. `Math.round(tasa * 100)` convertiría una tasa
// reducida de 2.5% en el rótulo "IVA 3%", que miente sobre el monto real.
function formatearTasa(tasa: number): string {
  return (tasa * 100).toFixed(2).replace(/\.?0+$/, '');
}

// Fecha en palabras ("27 de agosto de 2026"), con los nombres de mes de
// Costa Rica ("setiembre", no "septiembre" — ver `lib/cotizador/fechas.ts`,
// que es el único lugar donde eso se resuelve; este archivo y `correo.ts`
// sólo lo importan).
const formatearFecha = formatearFechaLargaCR;

const TINTA = '#20211f';
const TINTA_SUAVE = '#6b6a63';
const ACENTO = '#93712f';
const BORDE = '#e2ded2';
const FONDO_SUAVE = '#f7f5ef';

const styles = StyleSheet.create({
  page: {
    paddingTop: 56,
    paddingBottom: 64,
    paddingHorizontal: 56,
    fontFamily: 'Inter',
    fontSize: 10,
    color: TINTA,
  },

  // ---- Encabezado ----
  encabezado: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 18,
  },
  marca: {
    fontSize: 22,
    fontFamily: 'Playfair Display',
    fontWeight: 'bold',
    letterSpacing: 1,
    color: TINTA,
  },
  lema: {
    fontSize: 9,
    fontFamily: 'Inter',
    color: TINTA_SUAVE,
    marginTop: 5,
    letterSpacing: 0.3,
  },
  encabezadoDerecha: {
    alignItems: 'flex-end',
  },
  numero: {
    fontSize: 11,
    fontFamily: 'Inter',
    fontWeight: 'bold',
    color: TINTA,
  },
  fechaEmision: {
    fontSize: 9,
    fontFamily: 'Inter',
    color: TINTA_SUAVE,
    marginTop: 3,
  },
  vigencia: {
    fontSize: 10,
    fontFamily: 'Inter',
    fontWeight: 'bold',
    color: ACENTO,
    marginTop: 6,
    textAlign: 'right',
  },
  regla: {
    borderBottomWidth: 1.5,
    borderBottomColor: ACENTO,
    marginBottom: 20,
  },

  // ---- Cliente ----
  clienteBox: {
    marginBottom: 24,
  },
  clienteEtiqueta: {
    fontSize: 8,
    fontFamily: 'Inter',
    fontWeight: 600,
    color: TINTA_SUAVE,
    letterSpacing: 1,
    marginBottom: 5,
  },
  clientePrincipal: {
    fontSize: 15,
    fontFamily: 'Playfair Display',
    fontWeight: 600,
    color: TINTA,
  },
  clienteSecundario: {
    fontSize: 9.5,
    fontFamily: 'Inter',
    color: TINTA_SUAVE,
    marginTop: 2,
  },

  // ---- Tabla ----
  tituloSeccion: {
    fontSize: 8,
    fontFamily: 'Inter',
    fontWeight: 600,
    color: TINTA_SUAVE,
    letterSpacing: 1,
    marginBottom: 8,
  },
  tablaHeader: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: TINTA,
    paddingBottom: 6,
    marginBottom: 4,
  },
  colHeader: {
    fontSize: 8.5,
    fontFamily: 'Inter',
    fontWeight: 600,
    color: TINTA_SUAVE,
    letterSpacing: 0.5,
  },
  colProducto: { flexBasis: '46%', flexGrow: 0, flexShrink: 0 },
  colCantidad: { flexBasis: '12%', flexGrow: 0, flexShrink: 0, textAlign: 'right' },
  colPrecio: { flexBasis: '20%', flexGrow: 0, flexShrink: 0, textAlign: 'right' },
  colSubtotal: { flexBasis: '22%', flexGrow: 0, flexShrink: 0, textAlign: 'right' },

  fila: {
    flexDirection: 'row',
    paddingVertical: 10,
    borderBottomWidth: 0.75,
    borderBottomColor: BORDE,
  },
  nombreProducto: {
    fontSize: 10.5,
    fontFamily: 'Inter',
    fontWeight: 600,
    color: TINTA,
  },
  contenidoProducto: {
    fontSize: 8.5,
    fontFamily: 'Inter',
    color: TINTA_SUAVE,
    marginTop: 3,
    lineHeight: 1.4,
  },
  descuentoProducto: {
    fontSize: 8.5,
    fontFamily: 'Inter',
    fontWeight: 600,
    color: ACENTO,
    marginTop: 2,
  },
  valorCelda: {
    fontSize: 10,
    fontFamily: 'Inter',
    color: TINTA,
  },

  // ---- Totales ----
  bloqueTotales: {
    marginTop: 22,
    alignItems: 'flex-end',
  },
  totalDestacado: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: FONDO_SUAVE,
    borderTopWidth: 1.5,
    borderTopColor: ACENTO,
    borderBottomWidth: 1.5,
    borderBottomColor: ACENTO,
    paddingVertical: 12,
    paddingHorizontal: 16,
    width: 280,
  },
  totalEtiqueta: {
    fontSize: 12,
    fontFamily: 'Inter',
    fontWeight: 600,
    color: TINTA,
    letterSpacing: 0.5,
  },
  // Nota: NO usar Playfair Display acá. Sus cifras son "old-style" (alturas
  // desiguales, con descendentes) — elegantes en un titular de texto, pero
  // el número más importante del documento tiene que leerse sin esfuerzo.
  // Inter con cifras alineadas ("lining figures") es lo correcto para dinero.
  totalValor: {
    fontSize: 20,
    fontFamily: 'Inter',
    fontWeight: 'bold',
    color: TINTA,
  },
  filaResumen: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: 280,
    marginTop: 8,
    paddingHorizontal: 16,
  },
  resumenEtiqueta: {
    fontSize: 9.5,
    fontFamily: 'Inter',
    color: TINTA_SUAVE,
  },
  resumenValor: {
    fontSize: 9.5,
    fontFamily: 'Inter',
    color: TINTA,
  },
  // El ahorro frente al precio de lista es el argumento de venta más directo
  // que hay — decirle al hotel cuánto no pagó — así que se destaca en el
  // color de acento en vez de quedar mezclado con el resto del resumen.
  ahorroEtiqueta: {
    fontSize: 9.5,
    fontFamily: 'Inter',
    fontWeight: 600,
    color: ACENTO,
  },
  ahorroValor: {
    fontSize: 9.5,
    fontFamily: 'Inter',
    fontWeight: 600,
    color: ACENTO,
  },

  // ---- Notas al pie ----
  notas: {
    marginTop: 40,
    paddingTop: 14,
    borderTopWidth: 0.75,
    borderTopColor: BORDE,
  },
  notaTexto: {
    fontSize: 8,
    fontFamily: 'Inter',
    color: TINTA_SUAVE,
    lineHeight: 1.5,
    marginBottom: 4,
  },

  piePagina: {
    position: 'absolute',
    bottom: 28,
    left: 56,
    right: 56,
    textAlign: 'center',
    fontSize: 7.5,
    fontFamily: 'Inter',
    color: TINTA_SUAVE,
  },
});

function FilaProducto({ linea }: { linea: LineaCalculada }) {
  return (
    <View style={styles.fila} wrap={false}>
      <View style={styles.colProducto}>
        <Text style={styles.nombreProducto}>{linea.nombre}</Text>
        {linea.contenido && linea.contenido.length > 0 && (
          <Text style={styles.contenidoProducto}>Incluye: {linea.contenido.join(', ')}.</Text>
        )}
        {linea.descuentoPct > 0 && (
          <Text style={styles.descuentoProducto}>Descuento aplicado: {linea.descuentoPct}%</Text>
        )}
      </View>
      <Text style={[styles.colCantidad, styles.valorCelda]}>{linea.cantidad}</Text>
      <Text style={[styles.colPrecio, styles.valorCelda]}>{colones(linea.precioUnitario)}</Text>
      <Text style={[styles.colSubtotal, styles.valorCelda]}>{colones(linea.subtotal)}</Text>
    </View>
  );
}

function Documento({ numero, cotizacion, cliente, emitida, vence }: DatosDocumento) {
  const { lineas, subtotal, ahorro, tasaIva, iva, total, bordadoEspecial } = cotizacion;

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.encabezado}>
          <View>
            <Text style={styles.marca}>LUXE ESSENTIALS</Text>
            <Text style={styles.lema}>Uniformes y textiles de hogar para hotelería</Text>
          </View>
          <View style={styles.encabezadoDerecha}>
            <Text style={styles.numero}>Cotización {numero}</Text>
            <Text style={styles.fechaEmision}>Emitida el {formatearFecha(emitida)}</Text>
            <Text style={styles.vigencia}>Válida hasta {formatearFecha(vence)}</Text>
          </View>
        </View>
        <View style={styles.regla} />

        <View style={styles.clienteBox}>
          <Text style={styles.clienteEtiqueta}>PREPARADA PARA</Text>
          <Text style={styles.clientePrincipal}>{cliente.empresa ?? cliente.nombre}</Text>
          {cliente.empresa && (
            <Text style={styles.clienteSecundario}>Atención: {cliente.nombre}</Text>
          )}
          <Text style={styles.clienteSecundario}>{cliente.email}</Text>
          {cliente.telefono && (
            <Text style={styles.clienteSecundario}>{cliente.telefono}</Text>
          )}
          {cliente.direccion && (
            <Text style={styles.clienteSecundario}>{cliente.direccion}</Text>
          )}
        </View>

        <Text style={styles.tituloSeccion}>DETALLE</Text>
        {/* `fixed`: en una cotización de muchas líneas que ocupa varias
            páginas, sin esto el encabezado de columnas solo aparece en la
            página 1 y las siguientes son números sueltos sin decir qué
            columna es cuál. Al ser un hijo directo de Page colocado antes de
            las filas, react-pdf lo repite al tope de cada página nueva sin
            repetir el resto del membrete (marca, cliente). */}
        <View style={styles.tablaHeader} fixed>
          <Text style={[styles.colProducto, styles.colHeader]}>Producto</Text>
          <Text style={[styles.colCantidad, styles.colHeader]}>Cant.</Text>
          <Text style={[styles.colPrecio, styles.colHeader]}>Precio unit.</Text>
          <Text style={[styles.colSubtotal, styles.colHeader]}>Subtotal</Text>
        </View>
        {lineas.map((linea, i) => (
          <FilaProducto key={`${linea.skuId}-${i}`} linea={linea} />
        ))}

        {/* El total va primero, destacado; el IVA se suma abajo como parte
            del desglose. Requisito explícito del cliente.
            `wrap={false}`: sin esto (ronda de correcciones 1, hallazgo
            crítico), el bloque puede partirse justo entre la caja del Total
            y las filas de Subtotal/IVA cuando cae cerca del borde de una
            página — la caja queda sola en una página y "Subtotal"/"+ IVA"
            flotando solas en la siguiente, sin encabezado de tabla ni
            productos alrededor. Con `wrap={false}` el bloque entero salta a
            la página siguiente si no cabe completo, en vez de partirse. */}
        <View style={styles.bloqueTotales} wrap={false}>
          <View style={styles.totalDestacado}>
            <Text style={styles.totalEtiqueta}>Total</Text>
            <Text style={styles.totalValor}>{colones(total)}</Text>
          </View>
          <View style={styles.filaResumen}>
            <Text style={styles.resumenEtiqueta}>Subtotal</Text>
            <Text style={styles.resumenValor}>{colones(subtotal)}</Text>
          </View>
          {ahorro > 0 && (
            <View style={styles.filaResumen}>
              <Text style={styles.ahorroEtiqueta}>Ahorro vs. precio de lista</Text>
              <Text style={styles.ahorroValor}>{colones(ahorro)}</Text>
            </View>
          )}
          {tasaIva > 0 ? (
            <View style={styles.filaResumen}>
              <Text style={styles.resumenEtiqueta}>{`+ IVA (${formatearTasa(tasaIva)}%)`}</Text>
              <Text style={styles.resumenValor}>{colones(iva)}</Text>
            </View>
          ) : (
            // Sin monto al lado: un "₡0" ahí es ruido, no información — el
            // punto es decir que no aplica, no cuantificar un cero.
            <View style={styles.filaResumen}>
              <Text style={styles.resumenEtiqueta}>Exento de IVA</Text>
            </View>
          )}
        </View>

        {/* Nada sobre métodos de pago: el vendedor coordina el cobro aparte. */}
        <View style={styles.notas} wrap={false}>
          <Text style={styles.notaTexto}>
            Todos los precios de este documento están expresados en colones costarricenses (₡),
            sin decimales.
          </Text>
          <Text style={styles.notaTexto}>{NOTA_BORDADO}</Text>
          {bordadoEspecial && <Text style={styles.notaTexto}>{NOTA_BORDADO_ESPECIAL}</Text>}
        </View>

        <Text
          style={styles.piePagina}
          fixed
          render={({ pageNumber, totalPages }) =>
            totalPages > 1 ? `Luxe Essentials · ${numero} · Página ${pageNumber} de ${totalPages}` : `Luxe Essentials · ${numero}`
          }
        />
      </Page>
    </Document>
  );
}

export async function renderizarCotizacion(datos: DatosDocumento): Promise<Buffer> {
  return renderToBuffer(<Documento {...datos} />);
}
