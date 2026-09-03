import 'server-only';
import { ESCALAS, escalonDe, IVA_GENERAL } from '@/lib/cotizador/escalas';
import {
  DESCUENTO_PERSONALIZADO_MAX,
  type Cotizacion,
  type DescuentoPersonalizado,
  type GrupoDescuento,
  type LineaCalculada,
  type LineaEntrada,
  type Sku,
} from '@/lib/cotizador/tipos';

export type OpcionesCalculo = {
  tasaIva?: number;
  bordadoEspecial?: boolean;
  // Fase 5 (descuento con aprobación): reemplaza el descuento de escala en
  // las líneas que alcanza, no se le suma. Ver `DescuentoPersonalizado` en
  // tipos.ts para la forma, y el diseño en
  // docs/superpowers/specs/2026-09-02-descuento-aprobacion-design.md para
  // el porqué de cada decisión.
  descuentoPersonalizado?: DescuentoPersonalizado;
};

// Mismo criterio que la validación de `tasaIva` más abajo: `calcular` es una
// función pura y no puede confiar en que quien la llama pasó por Zod. Un
// número fuera de [0, 100) o un objeto que no respeta la unión discriminada
// (las dos claves a la vez, o ninguna) es un dato corrupto, no una elección
// legítima -- se rechaza en vez de adivinar cuál mitad vale.
function validarPct(pct: number, contexto: string): void {
  if (!Number.isFinite(pct) || pct < 0 || pct >= DESCUENTO_PERSONALIZADO_MAX) {
    throw new Error(
      `Descuento personalizado inválido${contexto}: ${pct}. Debe ser un número entre 0 ` +
        `(incluido) y ${DESCUENTO_PERSONALIZADO_MAX} (excluido) -- a ${DESCUENTO_PERSONALIZADO_MAX}% ` +
        'el producto queda gratis, y eso no es un descuento.',
    );
  }
}

// Valida la forma completa de `descuentoPersonalizado` y devuelve, por
// grupo, el porcentaje que reemplaza a la escala -- o `undefined` si ese
// grupo no tiene reemplazo y sigue con la escala automática, tal cual hoy.
function resolverDescuentoPersonalizado(
  dp: DescuentoPersonalizado | undefined,
): (grupo: GrupoDescuento) => number | undefined {
  if (!dp) return () => undefined;

  const tieneGeneral = 'general' in dp;
  const tieneFamilias = 'familias' in dp;
  if (tieneGeneral === tieneFamilias) {
    // true en los dos casos raros: ninguna de las dos claves, o las dos a
    // la vez. El diseño las documenta como alternativas ("{ general: n } o
    // { familias: {...} }", migración 0017) -- nunca combinadas.
    throw new Error(
      'Descuento personalizado inválido: debe traer exactamente una de "general" o "familias".',
    );
  }

  if (tieneGeneral) {
    const dpGeneral = dp as { general: number };
    validarPct(dpGeneral.general, ' general');
    return () => dpGeneral.general;
  }

  const dpFamilias = (dp as { familias: Partial<Record<GrupoDescuento, number>> }).familias;
  for (const [grupo, pct] of Object.entries(dpFamilias)) {
    if (pct !== undefined) validarPct(pct, ` de la familia "${grupo}"`);
  }
  // Una familia que no aparece en la cotización (ninguna línea de ese
  // grupo) no es un error: es habitual pedir el descuento antes de armar
  // el pedido. Esta función simplemente nunca se llama con ese grupo, así
  // que no hace nada -- decisión documentada en lib/validation.ts.
  return (grupo) => dpFamilias[grupo];
}

// Medio hacia arriba. `Math.round` ya lo hace para positivos, y aquí no hay
// negativos: un precio de lista o una cantidad negativos se rechazan antes
// de llegar (ver las validaciones en `calcular`).
function redondear(valor: number): number {
  return Math.round(valor);
}

export function calcular(
  entradas: LineaEntrada[],
  skus: Sku[],
  opciones: OpcionesCalculo = {},
): Cotizacion {
  const tasaIva = opciones.tasaIva ?? IVA_GENERAL;

  // La Tarea 8 llama a `calcular` directo desde el estado de React para la
  // vista previa, sin Zod de por medio: un campo de tasa vacío da
  // `parseFloat('') === NaN` y sin esta validación el NaN se propaga en
  // silencio hasta la pantalla del vendedor.
  if (!Number.isFinite(tasaIva) || tasaIva < 0 || tasaIva > 1) {
    throw new Error(`Tasa de IVA inválida: ${tasaIva}. Debe ser un número entre 0 y 1.`);
  }

  // Se valida y resuelve ANTES del catálogo: si el descuento personalizado
  // viene corrupto, la cotización entera se rechaza -- no tiene sentido
  // calcular ninguna línea con datos a medio confiar.
  const pctPersonalizadoDe = resolverDescuentoPersonalizado(opciones.descuentoPersonalizado);

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
    const sku = porId.get(entrada.skuId)!;
    if (!Number.isFinite(sku.precioLista) || sku.precioLista < 0) {
      throw new Error(
        `Precio de lista inválido para ${entrada.skuId}: ${sku.precioLista}. Debe ser un número no negativo.`,
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

    // El descuento personalizado REEMPLAZA al de escala en las líneas que
    // alcanza, no se le suma (diseño, fase 5): sumar un "15% extra" sobre
    // un pedido que ya trae su 10% automático significaría cosas distintas
    // según la cantidad, y el precio final dejaría de ser predecible.
    // `pctPersonalizado` es `undefined` cuando esta línea no está
    // alcanzada -- ahí sigue con `escalon.pct`, exactamente como hoy.
    const pctPersonalizado = pctPersonalizadoDe(sku.grupo);
    const personalizado = pctPersonalizado !== undefined;
    const pct = personalizado ? pctPersonalizado : escalon.pct;

    // El redondeo va sobre el unitario, no sobre el total de la línea: la
    // cotización imprime ambos, y si se redondeara el total, el unitario
    // impreso por la cantidad no daría el total impreso.
    const precioUnitario = redondear(sku.precioLista * (1 - pct / 100));
    const subtotalLinea = precioUnitario * cantidad;

    lineas.push({
      skuId: sku.id,
      nombre: sku.nombre,
      // Copia, no referencia: `calcular` se anuncia como función pura y el
      // catálogo vive en memoria durante todo el proceso en Next.js. Si el
      // llamador hace `push` sobre este arreglo, no debe contaminar el SKU
      // original ni filtrarse a la próxima petición.
      contenido: sku.contenido ? [...sku.contenido] : undefined,
      cantidad,
      precioLista: sku.precioLista,
      descuentoPct: pct,
      precioUnitario,
      subtotal: subtotalLinea,
      grupo: sku.grupo,
      motivo: personalizado
        ? `Descuento personalizado: ${pct}% (reemplaza el descuento de escala)`
        : escalon.pct === 0
          ? `${totalDelGrupo} ${escala.unidad} en ${escala.etiqueta} → sin descuento`
          : `${totalDelGrupo} ${escala.unidad} en ${escala.etiqueta} → ${escalon.pct}%`,
      personalizado,
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
