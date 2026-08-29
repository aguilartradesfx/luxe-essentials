import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { config } from 'dotenv';
import { hashClave } from '../lib/cotizador/credenciales.mjs';

config({ path: '.env.local' });
config();

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

function normalizarUsuario(usuario) {
  return usuario.trim().toLowerCase();
}

// Los usuarios se administran por consola y no por una pantalla dentro del
// panel. Una pantalla de administración es más superficie de ataque, más código
// y más pruebas para algo que se usa tres veces al año: cuando entra alguien
// nuevo y cuando alguien se va.
export async function construirSql(orden, argumentos) {
  switch (orden) {
    case 'listar':
      return {
        texto:
          'select usuario, nombre, activo, intentos, bloqueado_hasta, ultimo_acceso, creado_at ' +
          'from public.usuarios_panel order by activo desc, usuario',
        valores: [],
      };
    case 'alta': {
      const [usuario, nombre, clave] = argumentos;
      if (!usuario || !nombre || !clave) {
        throw new Error('Uso: alta <usuario> "<nombre completo>" <clave>');
      }
      const { hash, sal } = await hashClave(clave);
      return {
        texto:
          'insert into public.usuarios_panel (usuario, nombre, clave_hash, clave_sal) ' +
          'values ($1, $2, $3, $4)',
        valores: [normalizarUsuario(usuario), nombre, hash, sal],
      };
    }
    case 'clave': {
      const [usuario, nueva] = argumentos;
      if (!usuario || !nueva) {
        throw new Error('Uso: clave <usuario> <nueva clave>');
      }
      // Quien cambia la clave de alguien es porque esa persona no puede
      // entrar: de paso se limpia el bloqueo y el contador de intentos, si no
      // la clave nueva no serviría de nada hasta que venza el bloqueo viejo.
      const { hash, sal } = await hashClave(nueva);
      return {
        texto:
          'update public.usuarios_panel set clave_hash = $1, clave_sal = $2, ' +
          'bloqueado_hasta = null, intentos = 0 where usuario = $3',
        valores: [hash, sal, normalizarUsuario(usuario)],
      };
    }
    case 'desactivar': {
      const [usuario] = argumentos;
      if (!usuario) {
        throw new Error('Uso: desactivar <usuario>');
      }
      // Nunca delete: una cotización firmada por alguien que ya no está tiene
      // que seguir diciendo quién la hizo.
      return {
        texto: 'update public.usuarios_panel set activo = false where usuario = $1',
        valores: [normalizarUsuario(usuario)],
      };
    }
    case 'activar': {
      const [usuario] = argumentos;
      if (!usuario) {
        throw new Error('Uso: activar <usuario>');
      }
      return {
        texto: 'update public.usuarios_panel set activo = true where usuario = $1',
        valores: [normalizarUsuario(usuario)],
      };
    }
    case 'desbloquear': {
      const [usuario] = argumentos;
      if (!usuario) {
        throw new Error('Uso: desbloquear <usuario>');
      }
      return {
        texto: 'update public.usuarios_panel set bloqueado_hasta = null, intentos = 0 where usuario = $1',
        valores: [normalizarUsuario(usuario)],
      };
    }
    default:
      throw new Error(`Orden desconocida: ${orden}. Usá: listar, alta, clave, desactivar, activar, desbloquear.`);
  }
}

function imprimirListado(filas) {
  if (filas.length === 0) {
    console.log('No hay usuarios registrados.');
    return;
  }
  console.table(
    filas.map((fila) => ({
      usuario: fila.usuario,
      nombre: fila.nombre,
      activo: fila.activo,
      intentos: fila.intentos,
      bloqueado_hasta: fila.bloqueado_hasta ?? '',
      ultimo_acceso: fila.ultimo_acceso ?? '',
      creado_at: fila.creado_at,
    })),
  );
}

async function ejecutar(orden, argumentos) {
  const { texto, valores } = await construirSql(orden, argumentos);

  const client = new pg.Client({
    connectionString: connectionString(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    if (orden === 'listar') {
      const { rows } = await client.query(texto, valores);
      imprimirListado(rows);
      console.log(`${rows.length} usuario(s).`);
      return;
    }

    const { rowCount } = await client.query(texto, valores);
    console.log(`${rowCount} fila(s) afectada(s).`);
  } catch (err) {
    if (err && err.code === '23505') {
      throw new Error('Ese usuario ya existe. Usá `clave` para cambiarle la contraseña.');
    }
    throw err;
  } finally {
    await client.end();
  }
}

async function main() {
  const [orden, ...argumentos] = process.argv.slice(2);
  if (!orden) {
    console.error('Uso: npm run usuarios -- <listar|alta|clave|desactivar|activar|desbloquear> [argumentos]');
    process.exit(1);
  }

  try {
    await ejecutar(orden, argumentos);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
