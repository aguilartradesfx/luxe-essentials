import { config } from 'dotenv';
import pg from 'pg';
import { cargarModuloServidor, cerrarServidorTs } from './lib/servidor-ts.mjs';

config({ path: '.env.local' });

// Cuántos días queda "vigente" el PDF de muestra. Mismo valor que
// `DIAS_VIGENCIA` en app/api/cotizacion/route.ts (y, ahí mismo, en
// lib/cotizador/ghl.ts): se duplica por la misma razón que ese archivo ya
// explica — el documento tiene que decir una fecha consistente con el resto
// del sistema, aunque acá no haya Estimate ni correo de por medio.
const DIAS_VIGENCIA = 30;

// Genera y guarda el PDF real de las 6 cotizaciones de demostración que deja
// `demo:sembrar` (cliente->>'nombre' que empieza con "DEMO — "). Se insertaron
// directo en la base, sin pasar por app/api/cotizacion, así que nunca tuvieron
// PDF — y sin `pdf_ruta`, el panel no dibuja el botón «Ver PDF» en ninguna.
//
// Usa el mismo `renderizarCotizacion` (lib/cotizador/documento.tsx) y
// `guardarPdf` (lib/cotizador/almacen.ts) que app/api/cotizacion/route.ts en
// el camino real — cargados vía scripts/lib/servidor-ts.mjs, ver el
// comentario ahí sobre por qué hace falta ese puente. No manda correo, no
// llama a GoHighLevel: sólo genera, sube y actualiza `pdf_ruta`.
//
// Sólo toca la columna `pdf_ruta`, y sólo en filas cuyo cliente empieza con
// "DEMO — " — el mismo filtro que usa `demo:limpiar` para borrar. La base es
// de producción; este script no debe poder rozar una cotización real.
async function main() {
  const { renderizarCotizacion } = await cargarModuloServidor('@/lib/cotizador/documento');
  const { guardarPdf } = await cargarModuloServidor('@/lib/cotizador/almacen');
  const { supabaseAdmin } = await cargarModuloServidor('@/lib/supabase/server');

  const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const { rows } = await c.query(
    `select id, numero, cliente, lineas, totales, created_at
       from public.cotizaciones
      where cliente->>'nombre' like 'DEMO — %'
      order by numero`,
  );

  if (rows.length === 0) {
    console.log('  no hay cotizaciones de demostración. Corré antes: npm run demo:sembrar');
    await c.end();
    return;
  }

  const db = supabaseAdmin();
  let ok = 0;
  let fallidas = 0;

  for (const fila of rows) {
    const totales = fila.totales ?? {};

    // Las filas de `demo:sembrar` sólo llevan lo mínimo (skuId, nombre,
    // cantidad, precioUnitario, subtotal / subtotal, iva, total, ahorro).
    // `renderizarCotizacion` no lee `precioLista`/`grupo`/`motivo` de cada
    // línea (sólo el vendedor los ve en pantalla), así que se completan con
    // valores razonables en vez de inventar cifras que no están en la base.
    const cotizacion = {
      lineas: (fila.lineas ?? []).map((l) => ({
        skuId: l.skuId,
        nombre: l.nombre,
        contenido: l.contenido,
        cantidad: l.cantidad,
        precioLista: l.precioLista ?? l.precioUnitario,
        descuentoPct: l.descuentoPct ?? 0,
        precioUnitario: l.precioUnitario,
        subtotal: l.subtotal,
        grupo: l.grupo ?? 'uniformes',
        motivo: l.motivo ?? 'Cotización de muestra.',
      })),
      subtotal: totales.subtotal,
      ahorro: totales.ahorro ?? 0,
      // Mismo 13% que usa `demo:sembrar` para derivar `subtotal` a partir del
      // total (Math.round(total / 1.13)): no viene guardado en `totales`,
      // así que se reconstruye con la misma tasa en vez de asumir exento.
      tasaIva: totales.tasaIva ?? 0.13,
      iva: totales.iva,
      total: totales.total,
      bordadoEspecial: totales.bordadoEspecial ?? false,
    };

    const emitida = new Date(fila.created_at);
    const vence = new Date(emitida);
    vence.setDate(vence.getDate() + DIAS_VIGENCIA);

    try {
      const pdf = await renderizarCotizacion({ numero: fila.numero, cotizacion, cliente: fila.cliente, emitida, vence });
      const guardado = await guardarPdf({ id: fila.id, numero: fila.numero, pdf }, db);
      if (!guardado.ok) {
        console.error(`  x ${fila.numero}: ${guardado.error}`);
        fallidas++;
        continue;
      }

      // Doble filtro a propósito: por `id` (para no tocar otra fila) Y por
      // el prefijo "DEMO — " (para que este UPDATE, tomado solo, nunca pueda
      // escribir sobre una cotización real). Sólo `pdf_ruta`: nada de
      // `updated_at` ni ninguna otra columna.
      const { rowCount } = await c.query(
        `update public.cotizaciones
            set pdf_ruta = $1
          where id = $2 and cliente->>'nombre' like 'DEMO — %'`,
        [guardado.ruta, fila.id],
      );
      if (rowCount !== 1) {
        console.error(`  x ${fila.numero}: el PDF se guardó pero no se actualizó la fila (rowCount=${rowCount}).`);
        fallidas++;
        continue;
      }

      console.log(`  ok ${fila.numero} (${fila.cliente?.nombre}) -> ${guardado.ruta}`);
      ok++;
    } catch (err) {
      console.error(`  x ${fila.numero}:`, err instanceof Error ? err.message : String(err));
      fallidas++;
    }
  }

  await c.end();
  await cerrarServidorTs();

  console.log(`\n  PDF generados: ${ok}. Fallidas: ${fallidas}.`);
  if (fallidas > 0) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error('[demo:pdfs]', err);
  await cerrarServidorTs();
  process.exitCode = 1;
});
