import { config } from 'dotenv';
import pg from 'pg';
import { createInterface } from 'node:readline/promises';
import { cargarModuloServidor, cerrarServidorTs } from './lib/servidor-ts.mjs';

config({ path: '.env.local' });

// Borra SÓLO las cotizaciones de demostración. Se reconocen porque su cliente
// empieza con "DEMO — ": las de verdad nunca van a tener ese prefijo, así que
// este borrado no puede llevarse por delante trabajo real...
//
// Revisión final (hallazgo menor): "no van a tener ese prefijo" es una
// promesa que el código no puede sostener por sí solo -- `cliente->>'nombre'`
// es un campo de texto libre que escribe un vendedor. Nada impide que un
// hotel real se llame, o se escriba por accidente, empezando con "DEMO — ".
// Este script corre contra la base de PRODUCCIÓN, y antes borraba sin
// mostrar qué iba a borrar ni pedirle a quien lo corre que lo confirmara.
// Ahora primero imprime la lista completa de lo que coincide con el patrón,
// y sólo continúa si alguien escribe la palabra de confirmación exacta --
// mismo criterio que ya usa `scripts/usuarios.mjs` (una operación sensible
// se confirma por `readline`, nunca con un solo comando irreversible).
const CONFIRMACION = 'BORRAR';

const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

const { rows: aBorrar } = await c.query(
  "select id, cliente->>'nombre' as cliente, created_at from public.cotizaciones where cliente->>'nombre' like 'DEMO — %' order by created_at",
);

if (aBorrar.length === 0) {
  console.log('  no hay cotizaciones de demostración para borrar.');
  await c.end();
  process.exit(0);
}

console.log(`Esto va a borrar ${aBorrar.length} cotización(es) de la base de PRODUCCIÓN:`);
for (const fila of aBorrar) {
  const fecha = new Date(fila.created_at).toISOString().slice(0, 10);
  console.log(`  - ${fila.cliente}  (creada ${fecha}, id ${fila.id})`);
}
console.log('');

const rl = createInterface({ input: process.stdin, output: process.stdout });
let respuesta;
try {
  respuesta = await rl.question(`Escribí "${CONFIRMACION}" para confirmar (cualquier otra cosa cancela): `);
} finally {
  rl.close();
}

if (respuesta.trim() !== CONFIRMACION) {
  console.log('  cancelado -- no se borró nada.');
  await c.end();
  process.exit(1);
}

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
