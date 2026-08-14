import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { config } from 'dotenv';

config({ path: '.env.local' });
config();

const DIR = join(process.cwd(), 'supabase', 'migrations');

function connectionString() {
  if (process.env.SUPABASE_DB_URL) return process.env.SUPABASE_DB_URL;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const password = process.env.SUPABASE_DATABASE_PASSWORD;
  if (!url || !password) {
    throw new Error('Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_DATABASE_PASSWORD.');
  }
  const ref = new URL(url).hostname.split('.')[0];
  return `postgresql://postgres:${encodeURIComponent(password)}@db.${ref}.supabase.co:5432/postgres`;
}

async function migrate() {
  const client = new pg.Client({
    connectionString: connectionString(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  await client.query(`
    create table if not exists public._migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `);
  await client.query('alter table public._migrations enable row level security');

  const { rows } = await client.query('select name from public._migrations');
  const aplicadas = new Set(rows.map((r) => r.name));
  const archivos = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

  for (const archivo of archivos) {
    if (aplicadas.has(archivo)) {
      console.log(`· ${archivo} (ya aplicada)`);
      continue;
    }
    const sql = readFileSync(join(DIR, archivo), 'utf8');
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query('insert into public._migrations (name) values ($1)', [archivo]);
      await client.query('commit');
      console.log(`✓ ${archivo}`);
    } catch (err) {
      await client.query('rollback');
      throw new Error(`Falló ${archivo}: ${err.message}`);
    }
  }

  await client.end();
}

const comando = process.argv[2];
if (comando !== 'migrate') {
  console.error('Uso: node scripts/db.mjs migrate');
  process.exit(1);
}
await migrate();
