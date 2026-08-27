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
