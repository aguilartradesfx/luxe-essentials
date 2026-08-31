import { config } from 'dotenv';
import pg from 'pg';
import { cargarModuloServidor, cerrarServidorTs } from './lib/servidor-ts.mjs';

config({ path: '.env.local' });

// Borra SÓLO las cotizaciones de demostración. Se reconocen porque su cliente
// empieza con "DEMO — ": las de verdad nunca van a tener ese prefijo, así que
// este borrado no puede llevarse por delante trabajo real.
const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

// Antes de borrar las filas: si `demo:pdfs` les generó un PDF y lo subió al
// almacenamiento, ese archivo no desaparece solo con el DELETE de abajo (vive
// en Storage, no en la fila). Sin este paso, cada corrida de
// `demo:sembrar` + `demo:pdfs` + `demo:limpiar` dejaría basura acumulándose
// en el bucket `cotizaciones` — limpiar dejaría de dejar todo como estaba.
const { rows: pendientes } = await c.query(
  "select pdf_ruta from public.cotizaciones where cliente->>'nombre' like 'DEMO — %' and pdf_ruta is not null",
);
if (pendientes.length > 0) {
  const { BUCKET } = await cargarModuloServidor('@/lib/cotizador/almacen');
  const { supabaseAdmin } = await cargarModuloServidor('@/lib/supabase/server');
  const rutas = pendientes.map((r) => r.pdf_ruta);
  const { error } = await supabaseAdmin().storage.from(BUCKET).remove(rutas);
  if (error) {
    // No tumba la limpieza de la base por esto: un PDF huérfano en un bucket
    // privado es un problema menor comparado con dejar filas de demostración
    // sueltas en la base de producción.
    console.error(`  no se pudieron borrar ${rutas.length} PDF de demostración del almacenamiento: ${error.message}`);
  } else {
    console.log(`  borrados ${rutas.length} PDF de demostración del almacenamiento.`);
  }
  await cerrarServidorTs();
}

const { rowCount } = await c.query("delete from public.cotizaciones where cliente->>'nombre' like 'DEMO — %'");
const { rows } = await c.query('select count(*) n from public.cotizaciones');
await c.end();
console.log(`  borradas ${rowCount} cotizaciones de demostración. Quedan ${rows[0].n} en total.`);
