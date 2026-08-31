import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { createHash, randomBytes } from 'node:crypto';
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

function normalizarCorreo(correo) {
  return correo.trim().toLowerCase();
}

// Mismo problema que `credenciales.mjs`, pero acá no vale la pena mover un
// módulo entero por tres líneas: `lib/cotizador/invitaciones.ts` es la fuente
// de verdad (la usa `lib/cotizador/equipo.ts` desde el panel), y un `.mjs` no
// puede importar un `.ts`. Estas tres líneas son una copia deliberada, y
// `tests/usuarios-script.test.ts` trae la prueba cruzada que impide que las
// dos huellas diverjan: si alguien cambia el algoritmo de un lado y no del
// otro, esa prueba (y no un bug en producción) es quien se entera primero.
const HORAS_VIGENCIA = 72;

export function huellaDe(enlace) {
  return createHash('sha256').update(enlace).digest('hex');
}

function generarInvitacion() {
  const enlace = randomBytes(32).toString('hex');
  return {
    enlace,
    huella: huellaDe(enlace),
    expira: new Date(Date.now() + HORAS_VIGENCIA * 3_600_000),
  };
}

function urlInvitacion(enlace) {
  const sitio = process.env.NEXT_PUBLIC_SITE_URL || 'https://luxeessentialscr.com';
  return `${sitio}/cotizador/clave?enlace=${encodeURIComponent(enlace)}`;
}

// Versión mínima —texto plano, sin la plantilla con estilos— del correo que
// manda `lib/cotizador/correo-invitacion.ts` desde el panel. Ese módulo es
// `.ts` y además importa `server-only`: tampoco es importable acá. Esta
// consola se usa un puñado de veces al año como vía de recuperación, así que
// no vale la pena duplicar la plantilla HTML completa; el enlace y la
// vigencia son lo único que la persona invitada necesita.
async function enviarCorreoInvitacion({ correo, nombre, enlace }) {
  const apiKey = process.env.RESEND_API_KEY;
  const remitente = process.env.LUXE_CORREO_REMITENTE;
  if (!apiKey || !remitente) {
    return { ok: false, error: 'Faltan RESEND_API_KEY o LUXE_CORREO_REMITENTE en el entorno.' };
  }

  const url = urlInvitacion(enlace);
  const primerNombre = nombre.trim().split(/\s+/)[0] || nombre;
  const cuerpo = {
    from: remitente,
    to: [correo],
    subject: 'Tu acceso al cotizador de Luxe Essentials',
    text:
      `Hola ${primerNombre},\n\n` +
      'Te invitaron a entrar al cotizador de Luxe Essentials. Para arrancar, elegí tu ' +
      `propia clave desde este enlace:\n\n${url}\n\n` +
      `Este enlace vence en ${HORAS_VIGENCIA} horas. Si no lo pediste vos, podés ignorar este correo.`,
  };

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(cuerpo),
    });
    const texto = await res.text();
    if (!res.ok) return { ok: false, error: `Resend ${res.status}: ${texto.slice(0, 300)}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Los usuarios se administran por consola y no por una pantalla dentro del
// panel. Una pantalla de administración es más superficie de ataque, más código
// y más pruebas para algo que se usa tres veces al año: cuando entra alguien
// nuevo y cuando alguien se va.
export async function construirSql(orden, argumentos) {
  switch (orden) {
    case 'listar':
      // `rol` sí se selecciona, pero `clave_hash` nunca: el estado
      // ('invitada'/'vencida'/'activa'/'desactivada') se deriva más abajo,
      // en `imprimirListado`, sólo con `activo` e `invitacion_expira`.
      // `invitacion_expira` se limpia a null en el mismo momento en que se
      // fija `clave_hash` (ver `app/api/cotizacion/fijar-clave/route.ts`),
      // así que "sin invitación pendiente" y "ya tiene clave" son la misma
      // condición vistas desde acá — no hace falta traer el hash para
      // saberlo, y esta lista no tiene ningún motivo para tocarlo.
      return {
        texto:
          'select correo, nombre, rol, activo, intentos, bloqueado_hasta, invitacion_expira, ultimo_acceso, creado_at ' +
          'from public.usuarios_panel order by activo desc, correo',
        valores: [],
      };
    case 'invitar': {
      const [correo, nombre, ...banderas] = argumentos;
      if (!correo || !nombre) {
        throw new Error(
          'Uso: invitar <correo> "<nombre completo>" [--superadmin] [--sin-correo]\n' +
            'Crea la cuenta sin clave y manda un enlace para que la persona elija la suya ' +
            '(vence en 72 horas). Con --sin-correo se crea igual pero no se manda nada: la ' +
            'consola muestra el enlace para pasarlo a mano.',
        );
      }
      const rol = banderas.includes('--superadmin') ? 'superadmin' : 'vendedor';
      const sinCorreo = banderas.includes('--sin-correo');
      const { enlace, huella, expira } = generarInvitacion();
      return {
        texto:
          'insert into public.usuarios_panel (correo, nombre, rol, invitacion_hash, invitacion_expira) ' +
          'values ($1, $2, $3, $4, $5)',
        valores: [normalizarCorreo(correo), nombre, rol, huella, expira.toISOString()],
        enlace,
        sinCorreo,
      };
    }
    case 'clave': {
      const [correo, nueva] = argumentos;
      if (!correo || !nueva) {
        throw new Error(
          'Uso: clave <correo> [nueva clave]\n' +
            'Sin el último argumento, la clave se pide por consola (recomendado: no queda ' +
            'en el historial del shell ni visible en `ps`).',
        );
      }
      // Quien cambia la clave de alguien es porque esa persona no puede
      // entrar: de paso se limpia el bloqueo y el contador de intentos, si no
      // la clave nueva no serviría de nada hasta que venza el bloqueo viejo.
      const { hash, sal } = await hashClave(nueva);
      return {
        texto:
          'update public.usuarios_panel set clave_hash = $1, clave_sal = $2, ' +
          'bloqueado_hasta = null, intentos = 0 where correo = $3',
        valores: [hash, sal, normalizarCorreo(correo)],
      };
    }
    case 'desactivar': {
      const [correo] = argumentos;
      if (!correo) {
        throw new Error('Uso: desactivar <correo>');
      }
      // Nunca delete: una cotización firmada por alguien que ya no está tiene
      // que seguir diciendo quién la hizo.
      return {
        texto: 'update public.usuarios_panel set activo = false where correo = $1',
        valores: [normalizarCorreo(correo)],
      };
    }
    case 'activar': {
      const [correo] = argumentos;
      if (!correo) {
        throw new Error('Uso: activar <correo>');
      }
      return {
        texto: 'update public.usuarios_panel set activo = true where correo = $1',
        valores: [normalizarCorreo(correo)],
      };
    }
    case 'desbloquear': {
      const [correo] = argumentos;
      if (!correo) {
        throw new Error('Uso: desbloquear <correo>');
      }
      return {
        texto: 'update public.usuarios_panel set bloqueado_hasta = null, intentos = 0 where correo = $1',
        valores: [normalizarCorreo(correo)],
      };
    }
    default:
      throw new Error(`Orden desconocida: ${orden}. Usá: listar, invitar, clave, desactivar, activar, desbloquear.`);
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

// Completa los argumentos que faltan preguntando por consola. Sólo la clave
// de `clave` (correo y nombre no son secretos y se siguen dando en la línea
// de órdenes). `invitar` ya no pide clave por acá: la persona invitada la
// elige la primera vez que entra, con el enlace que esta orden manda. `pedir`
// se inyecta para poder probar esto sin una terminal.
//
// Se pregunta dos veces: sin eco, una clave mal tecleada no se ve, y el
// síntoma llega días después como "no puedo entrar" de alguien que sí escribió
// bien su clave.
export async function completarArgumentos(orden, argumentos, pedir) {
  const posicionClave = orden === 'clave' ? 1 : -1;
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

// Mismo criterio que `derivarEstado` en `lib/cotizador/equipo.ts`, pero sin
// mirar `clave_hash` (ver el comentario de `listar` en `construirSql`, más
// arriba, sobre por qué esta consulta no lo trae).
function derivarEstado(fila, ahora) {
  if (!fila.activo) return 'desactivada';
  if (fila.invitacion_expira === null) return 'activa';
  const vigente = new Date(fila.invitacion_expira).getTime() > ahora.getTime();
  return vigente ? 'invitada' : 'vencida';
}

function imprimirListado(filas, ahora = new Date()) {
  if (filas.length === 0) {
    console.log('No hay usuarios registrados.');
    return;
  }
  console.table(
    filas.map((fila) => ({
      correo: fila.correo,
      nombre: fila.nombre,
      rol: fila.rol,
      estado: derivarEstado(fila, ahora),
      intentos: fila.intentos,
      bloqueado_hasta: fila.bloqueado_hasta ?? '',
      ultimo_acceso: fila.ultimo_acceso ?? '',
      creado_at: fila.creado_at,
    })),
  );
}

async function ejecutar(orden, argumentos) {
  const { texto, valores, enlace, sinCorreo } = await construirSql(orden, argumentos);

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

    if (orden === 'invitar' && rowCount > 0) {
      const [correo, nombre] = valores;
      if (sinCorreo) {
        console.log('No se mandó ningún correo (--sin-correo). Pasale este enlace a mano:');
        console.log(`  ${urlInvitacion(enlace)}`);
      } else {
        const resultado = await enviarCorreoInvitacion({ correo, nombre, enlace });
        if (resultado.ok) {
          console.log(`Invitación enviada por correo a ${correo}.`);
        } else {
          console.log(`No se pudo mandar el correo: ${resultado.error}`);
          console.log('La cuenta ya quedó creada. Pasale este enlace a mano:');
          console.log(`  ${urlInvitacion(enlace)}`);
        }
      }
    }

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
      throw new Error('Ese correo ya está en el equipo.');
    }
    throw err;
  } finally {
    await client.end();
  }
}

async function main() {
  const [orden, ...argumentos] = process.argv.slice(2);
  if (!orden) {
    console.error('Uso: npm run usuarios -- <listar|invitar|clave|desactivar|activar|desbloquear> [argumentos]');
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
