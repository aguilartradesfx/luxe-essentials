import 'server-only';

import type { LineaCalculada } from './tipos';

// Lo que trae cada fila de la tabla de cotizaciones — el jsonb `lineas`
// guarda `LineaCalculada[]` tal cual salió de `calcular.ts`.
export type FilaCotizacion = {
  id: string;
  created_at: string;
  enviado_at: string | null;
  cerrada_at: string | null;
  estado: string;
  origen: string;
  cliente: Record<string, unknown>;
  lineas: LineaCalculada[];
  totales: { subtotal: number; ahorro: number; iva: number; total: number };
};

const DIA_MS = 24 * 60 * 60 * 1000;
const VENCE_DIAS = 30;
const AVISO_DIAS = 7;

// La tabla acepta siete estados, pero solo cinco son cotizaciones de verdad
// con montos y líneas confiables. `borrador` no tiene ni líneas ni totales
// (lleva `lineas: []`, `totales: {}`) y `convertida` es la fila fantasma que
// deja atrás un borrador cuando el vendedor la convierte en una cotización
// real —la fila nueva es la que cuenta—. Si cualquiera de las dos entrara a
// las métricas de dinero o producto, un mismo negocio se contaría dos veces.
const ESTADOS_REALES = new Set(['creada', 'enviada', 'error', 'ganada', 'perdida']);

export type Metricas = {
  sinRespuesta: {
    cantidad: number;
    monto: number;
    // Vencen dentro de los próximos 7 días (incluido el día del vencimiento):
    // es la llamada de hoy.
    porVencer: number;
    // Ya pasaron los 30 días: ese precio no corre más, hay que volver a
    // cotizar, no llamar a preguntar.
    vencidas: number;
    cotizaciones: FilaCotizacion[];
  };
  ganado: {
    cantidad: number;
    monto: number;
    diasPromedio: number;
  };
  perdido: {
    cantidad: number;
    monto: number;
    diasPromedio: number;
  };
  descuento: {
    monto: number;
    promedioPct: number;
  };
  productos: Array<{ nombre: string; unidades: number; monto: number }>;
  porLinea: {
    uniformes: { monto: number };
    hogar: { monto: number };
  };
  porOrigen: Record<string, number>;
  fallidas: number;
};

// Diferencia en días sin redondear — el redondeo pasa una sola vez, al
// final, sobre el promedio. Redondear cada fila y después promediar acumula
// error: tres cierres de 0,4 / 1,4 / 0,4 días dan promedio real 0,73 (→ 1),
// pero redondeados fila por fila dan 0 / 1 / 0 → promedio 0,33 (→ 0).
function diasEntre(desde: string, hasta: string): number {
  return (new Date(hasta).getTime() - new Date(desde).getTime()) / DIA_MS;
}

export function calcularMetricas(filas: FilaCotizacion[], hoy: Date): Metricas {
  const sinRespuestaFilas: FilaCotizacion[] = [];
  let sinRespuestaMonto = 0;
  let porVencer = 0;
  let vencidas = 0;

  let ganadoCantidad = 0;
  let ganadoMonto = 0;
  let ganadoDiasSuma = 0;

  let perdidoCantidad = 0;
  let perdidoMonto = 0;
  let perdidoDiasSuma = 0;

  let descuentoMonto = 0;
  let brutoMonto = 0;

  let uniformesMonto = 0;
  let hogarMonto = 0;

  const porOrigen: Record<string, number> = {};
  let fallidas = 0;

  const productosPorNombre = new Map<string, { nombre: string; unidades: number; monto: number }>();

  for (const fila of filas) {
    // `borrador` y `convertida` quedan fuera de todo: ni líneas ni totales
    // confiables, y contarlas duplicaría el negocio que ya cuenta la fila
    // real que las reemplaza.
    if (!ESTADOS_REALES.has(fila.estado)) continue;

    // Cada fila cuenta en exactamente un estado.
    if (fila.estado === 'error') {
      fallidas += 1;
    } else if ((fila.estado === 'creada' || fila.estado === 'enviada') && fila.cerrada_at === null) {
      sinRespuestaFilas.push(fila);
      sinRespuestaMonto += fila.totales.total;

      if (fila.enviado_at !== null) {
        const vence = new Date(fila.enviado_at).getTime() + VENCE_DIAS * DIA_MS;
        const diasHastaVencer = Math.round((vence - hoy.getTime()) / DIA_MS);
        if (diasHastaVencer < 0) {
          vencidas += 1;
        } else if (diasHastaVencer <= AVISO_DIAS) {
          porVencer += 1;
        }
      }
    } else if (fila.estado === 'ganada') {
      ganadoCantidad += 1;
      ganadoMonto += fila.totales.total;
      if (fila.enviado_at !== null && fila.cerrada_at !== null) {
        ganadoDiasSuma += diasEntre(fila.enviado_at, fila.cerrada_at);
      }
    } else if (fila.estado === 'perdida') {
      perdidoCantidad += 1;
      perdidoMonto += fila.totales.total;
      if (fila.enviado_at !== null && fila.cerrada_at !== null) {
        perdidoDiasSuma += diasEntre(fila.enviado_at, fila.cerrada_at);
      }
    }

    // Productos, reparto y origen sí incluyen las fallidas: la cotización
    // se armó y se guardó, lo único que falló fue la entrega (el PDF o el
    // correo). Los números están intactos y le sirven a producción y a la
    // pregunta de si el agente aporta cotizaciones reales.
    for (const linea of fila.lineas) {
      const acumulado = productosPorNombre.get(linea.nombre) ?? {
        nombre: linea.nombre,
        unidades: 0,
        monto: 0,
      };
      acumulado.unidades += linea.cantidad;
      acumulado.monto += linea.subtotal;
      productosPorNombre.set(linea.nombre, acumulado);

      if (linea.grupo === 'uniformes') {
        uniformesMonto += linea.subtotal;
      } else {
        hogarMonto += linea.subtotal;
      }
    }

    porOrigen[fila.origen] = (porOrigen[fila.origen] ?? 0) + 1;

    // El descuento sí excluye las fallidas: mide margen *entregado* a un
    // cliente, y a quien nunca recibió la cotización no se le otorgó nada.
    if (fila.estado !== 'error') {
      descuentoMonto += fila.totales.ahorro;
      brutoMonto += fila.totales.subtotal + fila.totales.ahorro;
    }
  }

  const productos = [...productosPorNombre.values()].sort((a, b) => b.monto - a.monto);

  return {
    sinRespuesta: {
      cantidad: sinRespuestaFilas.length,
      monto: Math.round(sinRespuestaMonto),
      porVencer,
      vencidas,
      cotizaciones: sinRespuestaFilas,
    },
    ganado: {
      cantidad: ganadoCantidad,
      monto: Math.round(ganadoMonto),
      diasPromedio: ganadoCantidad > 0 ? Math.round(ganadoDiasSuma / ganadoCantidad) : 0,
    },
    perdido: {
      cantidad: perdidoCantidad,
      monto: Math.round(perdidoMonto),
      diasPromedio: perdidoCantidad > 0 ? Math.round(perdidoDiasSuma / perdidoCantidad) : 0,
    },
    descuento: {
      monto: Math.round(descuentoMonto),
      promedioPct: brutoMonto > 0 ? (descuentoMonto / brutoMonto) * 100 : 0,
    },
    productos,
    porLinea: {
      uniformes: { monto: Math.round(uniformesMonto) },
      hogar: { monto: Math.round(hogarMonto) },
    },
    porOrigen,
    fallidas,
  };
}
