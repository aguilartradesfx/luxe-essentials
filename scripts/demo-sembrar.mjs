import { config } from 'dotenv';
import pg from 'pg';
config({ path: '.env.local' });

// Cotizaciones de muestra para ver el panel lleno. Todas llevan el prefijo
// DEMO en el cliente para poder borrarlas de un golpe. NO tocan GoHighLevel:
// son filas y nada más.
const HOY = new Date();
const dias = (n) => new Date(HOY.getTime() - n * 86400000).toISOString();

const MUESTRAS = [
  ['Hotel Punta Islita',    'Guillermo Rojas', 'enviada',    2184500, 'enviada',  1],
  ['Hotel Casa Turire',     'Marta Vargas',    'ganada',      876300, 'ganada',   4],
  ['Hotel Nayara Gardens',  'Guillermo Rojas', 'error',      3412750, 'error',    5],
  ['Hotel Bosque del Cabo', 'Marta Vargas',    'creada',     1095000, 'creada',   6],
  ['Hotel Tabacon',         'Guillermo Rojas', 'perdida',     640200, 'perdida', 10],
  ['Hotel Si Como No',      'Marta Vargas',    'enviada',    1520400, 'enviada',  2],
];

const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

for (const [hotel, vendedor, estado, total, _e, hace] of MUESTRAS) {
  const subtotal = Math.round(total / 1.13);
  await c.query(
    `insert into public.cotizaciones
       (origen, estado, cliente, lineas, totales, vendedor, created_at, updated_at, enviado_at, cerrada_at)
     values ('humano', $1, $2, $3, $4, $5, $6, $6, $7, $8)`,
    [
      estado,
      JSON.stringify({ nombre: `DEMO — ${hotel}`, email: 'demo@ejemplo.cr', telefono: '+506 0000 0000' }),
      JSON.stringify([{ skuId: 'demo', nombre: 'Muestra de demostración', cantidad: 24, precioUnitario: Math.round(subtotal / 24), subtotal }]),
      JSON.stringify({ subtotal, iva: total - subtotal, total, ahorro: Math.round(subtotal * 0.12) }),
      vendedor,
      dias(hace),
      ['enviada', 'ganada', 'perdida'].includes(estado) ? dias(hace) : null,
      ['ganada', 'perdida'].includes(estado) ? dias(hace - 1) : null,
    ],
  );
}

const { rows } = await c.query("select estado, count(*) n, sum((totales->>'total')::numeric) monto from cotizaciones group by estado order by n desc");
await c.end();
console.log('  sembradas 6 cotizaciones de demostración:\n');
rows.forEach(r => console.log('   ' + r.estado.padEnd(12) + String(r.n).padStart(2) + '   ₡' + Number(r.monto).toLocaleString('es-CR')));
console.log('\n  Para borrarlas todas:  npm run demo:limpiar');
