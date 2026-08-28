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

export type Metricas = {
  sinRespuesta: {
    cantidad: number;
    monto: number;
    porVencer: number;
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

function diasEntre(desde: string, hasta: string): number {
  return Math.round((new Date(hasta).getTime() - new Date(desde).getTime()) / DIA_MS);
}

export function calcularMetricas(filas: FilaCotizacion[], hoy: Date): Metricas {
  const sinRespuestaFilas: FilaCotizacion[] = [];
  let sinRespuestaMonto = 0;
  let porVencer = 0;

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
    // Cada fila cuenta en exactamente una categoría de estado.
    if (fila.estado === 'error') {
      fallidas += 1;
      continue;
    }

    if ((fila.estado === 'creada' || fila.estado === 'enviada') && fila.cerrada_at === null) {
      sinRespuestaFilas.push(fila);
      sinRespuestaMonto += fila.totales.total;

      if (fila.enviado_at !== null) {
        const vence = new Date(fila.enviado_at).getTime() + VENCE_DIAS * DIA_MS;
        const diasHastaVencer = Math.round((vence - hoy.getTime()) / DIA_MS);
        if (diasHastaVencer <= AVISO_DIAS) {
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

    // Descuento, productos, línea y origen se acumulan sobre toda fila que
    // no sea una fallida (ya se descartó arriba con el `continue`).
    descuentoMonto += fila.totales.ahorro;
    brutoMonto += fila.totales.subtotal + fila.totales.ahorro;

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
  }

  const productos = [...productosPorNombre.values()].sort((a, b) => b.monto - a.monto);

  return {
    sinRespuesta: {
      cantidad: sinRespuestaFilas.length,
      monto: Math.round(sinRespuestaMonto),
      porVencer,
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
