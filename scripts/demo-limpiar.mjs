import { config } from 'dotenv';
import pg from 'pg';
config({ path: '.env.local' });

// Borra SÓLO las cotizaciones de demostración. Se reconocen porque su cliente
// empieza con "DEMO — ": las de verdad nunca van a tener ese prefijo, así que
// este borrado no puede llevarse por delante trabajo real.
const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const { rowCount } = await c.query("delete from public.cotizaciones where cliente->>'nombre' like 'DEMO — %'");
const { rows } = await c.query('select count(*) n from public.cotizaciones');
await c.end();
console.log(`  borradas ${rowCount} cotizaciones de demostración. Quedan ${rows[0].n} en total.`);
