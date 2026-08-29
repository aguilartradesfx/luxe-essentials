import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
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
        throw new Error(
          'Uso: alta <usuario> "<nombre completo>" [clave]\n' +
            'Sin el último argumento, la clave se pide por consola (recomendado: no queda ' +
            'en el historial del shell ni visible en `ps`).',
        );
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
        throw new Error(
          'Uso: clave <usuario> [nueva clave]\n' +
            'Sin el último argumento, la clave se pide por consola (recomendado).',
        );
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

// Revisión final, M2: `npm run usuarios -- alta guillermo "Guillermo Rojas"
// 'clave'` deja la clave en `~/.zsh_history` y visible en `ps` para cualquier
// otro proceso de la máquina mientras el comando corre. Pedirla por `stdin` la
// saca de los dos lados. La forma con argumento se conserva (es la que usan
// las pruebas de `construirSql`, y sirve para automatizar), pero la
// recomendada —y la que documenta el README— es la interactiva.
//
// Sin eco cuando hay terminal: `_writeToOutput` es la costura que expone
// `readline` para eso. Es API privada, y por eso se toca acá y no en ningún
// otro lado — si una versión de Node la cambiara, lo peor que pasa es que la
// clave se vea al teclearla, no que el script deje de funcionar.
//
// Devuelve una función `preguntar(mensaje)` con un `readline` propio, y un
// `preguntar.cerrar()` para soltarlo. Es UNA sola interfaz para las dos
// preguntas a propósito: `readline` se queda con lo que ya leyó de `stdin`, así
// que abrir y cerrar una por pregunta hacía que —con la entrada por tubería—
// la segunda llegara vacía y el script dijera "las dos claves no coinciden"
// aunque fueran idénticas.
function crearLectorDeClaves() {
  const salida = process.stdout;
  const esTerminal = Boolean(process.stdin.isTTY);
  const rl = createInterface({
    input: process.stdin,
    // Sin terminal (una tubería, o CI) no hay nadie mirando teclear: no se
    // escribe el mensaje ni hace falta ocultar el eco.
    output: esTerminal ? salida : undefined,
    terminal: esTerminal,
  });

  if (esTerminal) {
    // Se traga TODO lo que `readline` querría imprimir, que con `terminal:
    // true` es el eco de cada tecla. El mensaje lo escribe `preguntar` a mano,
    // justo antes de leer.
    rl._writeToOutput = () => {};
  }

  // Cola de líneas. `readline` emite 'line' apenas la tiene, y con la entrada
  // por tubería las dos llegan en el mismo pedazo: sin esta cola, la segunda
  // se emitía mientras nadie estaba esperando, se perdía, y el script decía
  // "las dos claves no coinciden" aunque fueran idénticas.
  const pendientes = [];
  const esperando = [];
  let cerrado = false;

  rl.on('line', (linea) => {
    const resolver = esperando.shift();
    if (resolver) resolver(linea);
    else pendientes.push(linea);
  });
  rl.once('close', () => {
    cerrado = true;
    // La entrada se agotó: quien esté esperando recibe vacío en vez de quedar
    // colgado esperando una línea que nunca va a llegar.
    while (esperando.length) esperando.shift()('');
  });

  const preguntar = async (mensaje) => {
    if (esTerminal) salida.write(mensaje);
    const linea = pendientes.length
      ? pendientes.shift()
      : cerrado
        ? ''
        : await new Promise((resolve) => esperando.push(resolve));
    // El Enter tampoco se imprimió (lo comió `_writeToOutput`), así que el
    // salto de línea lo pone esta función.
    if (esTerminal) salida.write('\n');
    return linea;
  };

  preguntar.cerrar = () => rl.close();
  return preguntar;
}

// Completa los argumentos que faltan preguntando por consola. Sólo la clave:
// el usuario y el nombre no son secretos y se siguen dando en la línea de
// órdenes. `pedir` se inyecta para poder probar esto sin una terminal.
//
// Se pregunta dos veces: sin eco, una clave mal tecleada no se ve, y el
// síntoma llega días después como "no puedo entrar" de alguien que sí escribió
// bien su clave.
export async function completarArgumentos(orden, argumentos, pedir) {
  const posicionClave = orden === 'alta' ? 2 : orden === 'clave' ? 1 : -1;
  if (posicionClave === -1) return argumentos;
  if (argumentos[posicionClave]) return argumentos;
  // Si faltan los argumentos previos, `construirSql` ya tiene el mensaje de
  // uso correcto: no se pregunta una clave para una orden que igual va a
  // fallar.
  if (argumentos.length < posicionClave) return argumentos;

  const preguntar = pedir ?? crearLectorDeClaves();
  try {
    const clave = await preguntar('Clave: ');
    if (!clave) {
      throw new Error('La clave no puede estar vacía.');
    }
    const confirmacion = await preguntar('Repetila: ');
    if (clave !== confirmacion) {
      throw new Error('Las dos claves no coinciden. No se cambió nada.');
    }

    const completos = argumentos.slice();
    completos[posicionClave] = clave;
    return completos;
  } finally {
    // Sólo se cierra el lector que abrió esta función. El que inyecta una
    // prueba es suyo.
    if (!pedir) preguntar.cerrar();
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

    // Revisión final, Importante 1: `desactivar` impide entradas FUTURAS y no
    // corta la sesión que ya está viva. `autenticarPeticion` sólo mira la
    // firma de la cookie y nunca vuelve a consultar la tabla; `activo` se
    // comprueba una sola vez, al entrar. Se aceptó que la baja no sea
    // inmediata (ver lib/autenticacion-cotizador.ts para por qué), pero no es
    // defendible que quien corra esta orden se quede creyendo que ya está.
    if (orden === 'desactivar' && rowCount > 0) {
      console.log('');
      console.log('Ojo: esto NO corta la sesión que esa persona ya tenga abierta.');
      console.log('  - No va a poder volver a entrar.');
      console.log('  - Su sesión actual sigue sirviendo hasta 30 días.');
      console.log('Para cortarla ya: rotá LUXE_SESION_SECRETO en Vercel y volvé a desplegar.');
      console.log('Eso obliga a todo el equipo a entrar de nuevo una vez. Ver README.md.');
    }
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
    await ejecutar(orden, await completarArgumentos(orden, argumentos));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

// `process.argv[1]` falta en contextos como `node --input-type=module -e
// "import ..."`: ahí no hay invocación directa que detectar, así que la
// ausencia se trata como "no es invocación directa" y no como una excepción
// que tumbaría el import antes de llegar a comparar nada.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
