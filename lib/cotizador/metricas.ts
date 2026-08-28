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

// Ronda de correcciones 1 (Tarea 11): "ganado y perdido" acotado al mes
// calendario, con el mes anterior de comparación. Un acumulado desde el
// origen de los tiempos no le dice a nadie qué hacer hoy —el criterio de
// esta vista— porque no tiene con qué compararse: "ganamos ₡3,6 millones"
// no significa nada sin saber si es más o menos que el mes pasado.
export type ResumenMes = {
  cantidad: number;
  monto: number;
  diasPromedio: number;
};

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
  // Ambos, agrupados por el mes calendario en que se CERRÓ la cotización
  // (`cerrada_at`), en la zona horaria UTC (ver `claveMes`) — no por cuándo
  // se creó ni se envió. Una cotización sin `cerrada_at` no puede ubicarse
  // en ningún mes y no entra en ninguno de los dos.
  ganado: {
    mesActual: ResumenMes;
    mesAnterior: ResumenMes;
  };
  perdido: {
    mesActual: ResumenMes;
    mesAnterior: ResumenMes;
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

// "2026-08": el mes calendario de una fecha, en UTC -- no en la zona
// horaria local de donde corra el proceso. Los `timestamptz` de Supabase
// llegan en ISO con offset; comparar por este identificador en vez de por
// rango de fechas evita que el mismo cierre caiga en meses distintos según
// dónde se ejecute el servidor (o la prueba).
function claveMes(fecha: Date): string {
  return `${fecha.getUTCFullYear()}-${String(fecha.getUTCMonth() + 1).padStart(2, '0')}`;
}

// El mes calendario inmediatamente anterior al de `hoy`, como el mismo tipo
// de identificador que devuelve `claveMes` -- para comparar cierres contra
// él sin tener que reconstruir un rango de fechas cada vez.
function claveMesAnterior(hoy: Date): string {
  return claveMes(new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - 1, 1)));
}

// Un acumulador de cierres (ganados o perdidos) para un mes: se llena fila a
// fila con `sumarCierre` y se cierra una sola vez, al final, con
// `resumenDe` -- mismo motivo que `diasEntre`: redondear el promedio una
// sola vez, no fila por fila.
//
// Ronda de correcciones final: `diasCantidad` es DISTINTO de `cantidad`.
// `cantidad` cuenta toda fila cerrada en el mes (entra al numerador del
// monto); `diasCantidad` cuenta solo las que tienen las dos fechas y por lo
// tanto un número de días real que sumar. Antes el promedio dividía
// `diasSuma` entre `cantidad` -- si de dos cotizaciones ganadas solo una
// tenía `enviado_at` (la otra lo tiene `null`, típicamente una fila vieja de
// antes de que existiera esa columna, o una `error` corregida a mano),
// `diasSuma` solo llevaba los días de la medible pero el divisor contaba las
// dos: el promedio salía a la mitad de lo real.
type AcumuladorCierre = { cantidad: number; monto: number; diasSuma: number; diasCantidad: number };

function acumuladorVacio(): AcumuladorCierre {
  return { cantidad: 0, monto: 0, diasSuma: 0, diasCantidad: 0 };
}

function sumarCierre(acc: AcumuladorCierre, fila: FilaCotizacion): void {
  acc.cantidad += 1;
  acc.monto += fila.totales.total;
  if (fila.enviado_at !== null && fila.cerrada_at !== null) {
    acc.diasSuma += diasEntre(fila.enviado_at, fila.cerrada_at);
    acc.diasCantidad += 1;
  }
}

function resumenDe(acc: AcumuladorCierre): ResumenMes {
  return {
    cantidad: acc.cantidad,
    monto: Math.round(acc.monto),
    // Se divide por las filas MEDIBLES (`diasCantidad`), no por todas
    // (`cantidad`): una cotización sin `enviado_at` no aporta días a la
    // suma, así que tampoco debe diluir el promedio.
    diasPromedio: acc.diasCantidad > 0 ? Math.round(acc.diasSuma / acc.diasCantidad) : 0,
  };
}

export function calcularMetricas(filas: FilaCotizacion[], hoy: Date): Metricas {
  const sinRespuestaFilas: FilaCotizacion[] = [];
  let sinRespuestaMonto = 0;
  let porVencer = 0;
  let vencidas = 0;

  const claveActual = claveMes(hoy);
  const claveAnterior = claveMesAnterior(hoy);

  const ganadoMesActual = acumuladorVacio();
  const ganadoMesAnterior = acumuladorVacio();
  const perdidoMesActual = acumuladorVacio();
  const perdidoMesAnterior = acumuladorVacio();

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
      // Sin `cerrada_at` no hay mes al que asignarla -- no debería pasar
      // para una fila 'ganada' (se marca al cerrar), pero no hay dato del
      // que fiarse ciegamente en este archivo (ver el resto de guardas de
      // `null` acá arriba).
      if (fila.cerrada_at !== null) {
        const clave = claveMes(new Date(fila.cerrada_at));
        if (clave === claveActual) sumarCierre(ganadoMesActual, fila);
        else if (clave === claveAnterior) sumarCierre(ganadoMesAnterior, fila);
      }
    } else if (fila.estado === 'perdida') {
      if (fila.cerrada_at !== null) {
        const clave = claveMes(new Date(fila.cerrada_at));
        if (clave === claveActual) sumarCierre(perdidoMesActual, fila);
        else if (clave === claveAnterior) sumarCierre(perdidoMesAnterior, fila);
      }
    }

    // Productos, reparto y origen sí incluyen las fallidas (y los cierres de
    // cualquier mes, no solo el actual y el anterior): la cotización se
    // armó y se guardó, lo único que falló fue la entrega (el PDF o el
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
      mesActual: resumenDe(ganadoMesActual),
      mesAnterior: resumenDe(ganadoMesAnterior),
    },
    perdido: {
      mesActual: resumenDe(perdidoMesActual),
      mesAnterior: resumenDe(perdidoMesAnterior),
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
