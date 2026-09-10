import 'server-only';
import {
  contactosDeTodasLasZonas,
  conCorreo,
  type ZonaComercial,
  type DepsGhlContactos,
  type DestinatarioCampana,
} from '@/lib/campanas/contactos';
import { filtrarPermitidosParaCampana } from '@/lib/campanas/exclusiones';
import { normalizarCorreo } from '@/lib/campanas/baja';
import type { ClienteCampanas } from '@/lib/campanas/envio';
import { progresoCampana } from '@/lib/campanas/progreso';
import {
  ORDEN_ZONAS_PROGRAMADO,
  topeParaDia,
  diaDeRampa,
  correosConInicialEnviado,
  campanaProgramadaDeZona,
} from '@/lib/campanas/programado';

// La cola del envío programado, para que quien abre el panel pueda
// responder "¿a quién le toca mañana?", "¿cuánto falta?" y "¿cuándo
// termina esto?" -- lo que `VistaHistorialCampanas.tsx` hoy NO puede
// contestar: sólo enseña lo que ya se mandó (el historial) y el
// interruptor de pausa.
//
// LA COLA NO EXISTE COMO FILAS EN LA BASE -- a propósito (ver el
// comentario grande de `resolverObjetivo` en lib/campanas/programado.ts):
// una zona se arma el día que le toca, no antes, para que una baja se
// filtre al momento de armarla y no quede congelada semanas antes de que
// le toque el turno. Este módulo la DERIVA, cada vez que se pide, de tres
// fuentes:
//   1. El orden de zonas (`ORDEN_ZONAS_PROGRAMADO`).
//   2. Lo que ya está en la base (campañas 'programada' ya creadas, con su
//      progreso real -- `progresoCampana`).
//   3. Los contactos que hay HOY en el CRM, para las zonas que todavía no
//      tienen campaña -- se SIMULA qué les tocaría, con el mismo filtro,
//      letra por letra, que usa `resolverObjetivo` para armarlas de
//      verdad (nadie-dos-veces-el-inicial + bajas). Simulación, nunca
//      escritura: este módulo no crea ninguna campaña ni toca ninguna
//      fila -- sólo lee.
//
// LA TRAMPA DE LAS DIRECCIONES ÚNICAS: la misma dirección de correo puede
// aparecer en el CRM bajo dos zonas comerciales distintas (contactos.ts no
// lo impide, y no hay por qué -- son campos independientes). Sumar el
// tamaño de cada zona por separado infla el total. Este módulo nunca suma
// zonas de forma independiente: recorre `ORDEN_ZONAS_PROGRAMADO` UNA vez,
// de punta a punta, con un único `Set` de correos ya "asignados" que se va
// llenando a medida que se procesa cada zona -- así que una dirección que
// ya quedó contada en la zona A jamás se vuelve a contar en la zona B,
// aunque el CRM la tenga en las dos. La suma de `direccionesTotal` de las
// trece filas que devuelve `estadoColaProgramada` es, por construcción,
// el conteo de direcciones ÚNICAS -- no hace falta (ni hay que fiarse de)
// ningún conteo aparte.
//
// UNA SIMPLIFICACIÓN DELIBERADA, para la zona EN CURSO (la única que puede
// estar a medio mandar en un momento dado -- `resolverObjetivo` nunca dos
// a la vez): sus destinatarios TODAVÍA no mandados (estado 'pendiente')
// entran también al `Set` de "ya asignados" antes de simular las zonas
// futuras, aunque el sistema real sólo excluye por 'enviado'
// (`correosConInicialEnviado`). Sin esto, una dirección que hoy está
// 'pendiente' en la zona activa y que también vive en una zona futura se
// contaría dos veces en esta vista -- una vez como "pendiente de la zona
// activa" y otra como "vendrá con la zona futura". Con esto, en cambio,
// nunca se cuenta dos veces, al costo de una imprecisión angosta y menor:
// si alguno de esos pendientes termina en 'error' (no en 'enviado'), el
// sistema real SÍ lo reciclaría a la zona futura que le corresponda --
// esta vista no lo vuelve a ofrecer ahí. Se prefiere nunca mostrar un
// número inflado (una dirección "por duplicado") a costa de, en un caso
// angosto, subestimar en un puñado lo que le tocará a una zona futura.

// 'error': la zona todavía no tiene campaña Y no se pudo simular contra el
// CRM -- ni siquiera después del reintento que ya hace `contactosPorZona`
// (lib/campanas/contactos.ts). Hallazgo de producción (2026-09-10): antes,
// UNA zona así hacía que `estadoColaProgramada` lanzara ENTERA -- la
// pantalla no dibujaba ninguna de las trece filas, aunque las otras doce
// se hubieran podido calcular sin problema. Mismo criterio que ya usaba
// `app/api/campanas/zonas/route.ts` para esto mismo (el fallo de una zona
// queda en su propia fila, nunca tumba a las demás) -- acá se aplica el
// mismo criterio, no uno nuevo.
export type EstadoZonaCola = 'terminada' | 'en_curso' | 'espera' | 'error';

export type FilaZonaCola = {
  zona: ZonaComercial;
  // Posición en `ORDEN_ZONAS_PROGRAMADO`, 1-based -- el orden real de
  // envío, no el de `ZONAS_COMERCIALES` (que es alfabético/de origen).
  orden: number;
  estado: EstadoZonaCola;
  // `null` si la zona todavía no tiene campaña ('espera' o 'error').
  campanaId: string | null;
  // Direcciones ÚNICAS que le tocan a esta zona -- real (`progresoCampana`)
  // si ya tiene campaña, simulado si todavía no. Siempre 0 en 'error': no
  // hay ninguna cifra confiable que ofrecer para una zona que no se pudo
  // consultar -- mostrar un 0 acá NUNCA se confunde con "esta zona no
  // tiene destinatarios", porque `estado` ya lo distingue.
  direccionesTotal: number;
  direccionesEnviadas: number;
  direccionesFallidas: number;
  direccionesPendientes: number;
  // El motivo, tal cual lo devolvió el CRM, cuando `estado === 'error'`.
  // `null` en cualquier otro estado.
  error: string | null;
};

export type CupoHoy = {
  // El día de rampa que le tocaría a HOY si el cron reservara cupo ahora
  // mismo -- mismo cálculo, exacto, que usa `reservarCupoDiario`
  // (`diaDeRampa` + `topeParaDia`). Nunca a ojo.
  dia: number;
  tope: number;
  // Lo que el cron ya reservó hoy (0 si todavía no corrió hoy). Sólo LEE
  // `campanas_envio_diario` -- nunca llama al rpc que reserva cupo, que
  // escribiría.
  reservado: number;
  disponible: number;
  // Si hoy es lunes a viernes. En fin de semana el cron no corre, así que
  // `tope`/`disponible` describen un día hipotético, no uno que vaya a
  // gastarse hoy.
  diaHabilHoy: boolean;
};

export type EstadoColaProgramada = {
  zonas: FilaZonaCola[];
  totalDirecciones: number;
  totalEnviadas: number;
  totalFallidas: number;
  totalPendientes: number;
  cupoHoy: CupoHoy;
  // 'YYYY-MM-DD', o `null` si ya no queda nada pendiente. Calculada con la
  // rampa y el cupo de 100 de lunes a viernes -- ver `fechaEstimadaFin`.
  fechaEstimadaFin: string | null;
  // `true` si AL MENOS una zona quedó en 'error' -- en ese caso los cuatro
  // totales de arriba son un PISO (lo que sí se pudo calcular con lo que
  // respondió el CRM), nunca la cifra completa: la zona en error podría
  // sumar más direcciones de las que este total ya trae. Nunca se muestra
  // un total que finja estar completo cuando le falta una zona -- la
  // pantalla tiene que decirlo con esta bandera, no adivinarlo.
  totalIncompleto: boolean;
  // Las zonas en 'error', en el mismo orden que `zonas` -- para que la
  // pantalla pueda señalarlas por nombre sin tener que volver a filtrar
  // `zonas`.
  zonasConError: ZonaComercial[];
};

// --- Días hábiles (lunes a viernes), en UTC -- el mismo criterio de fecha
// que ya usa todo `lib/campanas/programado.ts`: `fechaHoy` viaja como
// 'YYYY-MM-DD' (`ahora().toISOString().slice(0, 10)`), así que las
// comparaciones de calendario acá también corren en UTC, para que las dos
// partes midan el mismo día siempre -- nunca una en UTC y otra en la hora
// local del servidor.
export function esDiaHabil(fecha: Date): boolean {
  const dia = fecha.getUTCDay(); // 0 domingo ... 6 sábado
  return dia >= 1 && dia <= 5;
}

function siguienteDiaHabil(fecha: Date): Date {
  let siguiente = new Date(fecha.getTime() + 24 * 60 * 60 * 1000);
  while (!esDiaHabil(siguiente)) siguiente = new Date(siguiente.getTime() + 24 * 60 * 60 * 1000);
  return siguiente;
}

// Guarda de seguridad -- jamás debería alcanzarse (a 100/día, hasta un
// atraso de decenas de miles de direcciones termina bien antes), pero un
// `for` que nunca corta es peor que devolver `null` con la fecha en duda.
const TOPE_ITERACIONES_ESTIMACION = 2000;

// La fecha en que se terminaría de mandar `pendientes` direcciones más,
// asumiendo que el cron sigue corriendo de lunes a viernes, sin pausas ni
// cambios de rampa -- el pedido explícito es "calculada con la rampa y el
// cupo de 100, no a ojo", así que esto simula día hábil por día hábil, con
// el mismo `topeParaDia` que usa el envío real, en vez de dividir
// `pendientes / 100` de un tirón (que ignoraría la rampa de los primeros
// cinco días y el fin de semana).
//
// `diaRampaHoy` y `cupoYaReservadoHoy` son los mismos números que
// `cupoHoy` ya calculó -- se pasan en vez de recalcularlos, para que las
// dos partes de la pantalla ("cupo de hoy" y "fecha estimada") cuenten,
// siempre, la misma historia.
export function fechaEstimadaFin(
  pendientes: number,
  diaRampaHoy: number,
  fechaHoy: Date,
  cupoYaReservadoHoy: number,
): string | null {
  if (pendientes <= 0) return null;

  let restante = pendientes;
  let dia = diaRampaHoy;
  let fecha = fechaHoy;

  if (esDiaHabil(fecha)) {
    const disponibleHoy = Math.max(0, topeParaDia(dia) - cupoYaReservadoHoy);
    if (restante <= disponibleHoy) return fecha.toISOString().slice(0, 10);
    restante -= disponibleHoy;
    dia += 1;
    fecha = siguienteDiaHabil(fecha);
  } else {
    // Fin de semana: el día de rampa no avanza (el cron no corre), sólo se
    // salta al lunes.
    fecha = siguienteDiaHabil(fecha);
  }

  for (let i = 0; i < TOPE_ITERACIONES_ESTIMACION; i++) {
    const cupo = topeParaDia(dia);
    if (restante <= cupo) return fecha.toISOString().slice(0, 10);
    restante -= cupo;
    dia += 1;
    fecha = siguienteDiaHabil(fecha);
  }
  return null;
}

export type DepsColaProgramada = DepsGhlContactos;

// El estado completo de la cola, para la pantalla. Sólo LEE -- ninguna
// llamada de este módulo escribe una fila ni reserva cupo.
export async function estadoColaProgramada(
  db: ClienteCampanas,
  deps: DepsColaProgramada,
  ahora: () => Date = () => new Date(),
): Promise<EstadoColaProgramada> {
  const fechaHoy = ahora().toISOString().slice(0, 10);

  // El camino compartido de ~47 peticiones a GHL (lib/campanas/contactos.ts)
  // -- el mismo que usa /api/campanas/zonas, nunca una copia aparte.
  // `contactosPorZona` YA reintentó lo que valía la pena reintentar antes
  // de volver acá (ver el comentario grande junto a `esFalloTransitorio`,
  // en contactos.ts) -- si una entrada de `contactosTodas` sigue sin `ok`
  // llegados a este punto, es porque el reintento tampoco alcanzó.
  //
  // A propósito, YA NO se revisan acá las trece de una sola pasada para
  // lanzar si alguna falló: ese chequeo -- el que causó el hallazgo de
  // producción del 2026-09-10 -- tumbaba la función ENTERA por una zona
  // que ni siquiera hacía falta consultar (una que ya tiene campaña sólo
  // necesita `progresoCampana`, nunca el CRM). Ahora cada zona decide por
  // sí misma, más abajo, si el CRM le hace falta -- y si le hace falta y
  // falló, esa fila queda 'error' sin tocar a las demás.
  const contactosTodas = await contactosDeTodasLasZonas(deps);

  // Arranca con quien YA recibió el inicial de verdad (global, cualquier
  // zona, cualquier campaña) -- la misma garantía 3 que usa
  // `resolverObjetivo` para armar una zona nueva.
  const asignado = await correosConInicialEnviado(db);

  const filas: FilaZonaCola[] = [];
  let totalDirecciones = 0;
  let totalEnviadas = 0;
  let totalFallidas = 0;
  let totalPendientes = 0;
  let totalIncompleto = false;
  const zonasConError: ZonaComercial[] = [];

  for (let i = 0; i < ORDEN_ZONAS_PROGRAMADO.length; i++) {
    const zona = ORDEN_ZONAS_PROGRAMADO[i];
    const existente = await campanaProgramadaDeZona(db, zona);

    if (existente) {
      const progreso = await progresoCampana(db, existente.id);
      const enCurso = progreso.pendientes > 0;

      if (enCurso) {
        // La simplificación deliberada del encabezado: los destinatarios
        // de la zona EN CURSO, en cualquier estado (no sólo 'enviado'),
        // quedan reservados para que ninguna zona futura los vuelva a
        // ofrecer en esta vista.
        const { data: correosZona, error } = await db
          .from('campanas_envios')
          .select('correo')
          .eq('campana_id', existente.id);
        if (error) {
          throw new Error(`No se pudieron leer los destinatarios de ${zona}: ${error.message}`);
        }
        for (const fila of (correosZona ?? []) as { correo: string }[]) {
          asignado.add(normalizarCorreo(fila.correo));
        }
      }

      filas.push({
        zona,
        orden: i + 1,
        estado: enCurso ? 'en_curso' : 'terminada',
        campanaId: existente.id,
        direccionesTotal: progreso.total,
        direccionesEnviadas: progreso.enviados,
        direccionesFallidas: progreso.fallidos,
        direccionesPendientes: progreso.pendientes,
        error: null,
      });
      totalDirecciones += progreso.total;
      totalEnviadas += progreso.enviados;
      totalFallidas += progreso.fallidos;
      totalPendientes += progreso.pendientes;
      continue;
    }

    // Todavía no tiene campaña -- hace falta el CRM para simular qué le
    // tocaría. Si esa consulta falló (aun con reintento), no hay ninguna
    // cifra confiable que ofrecer para esta zona en particular: la fila
    // queda 'error', con el motivo tal cual lo devolvió GHL, y el `for`
    // sigue con la zona siguiente -- se prefiere mostrar las otras doce
    // filas y avisar cuál falta, antes que tirar la pantalla entera por
    // una sola.
    const resultadoZona = contactosTodas[zona];
    if (!resultadoZona.ok) {
      totalIncompleto = true;
      zonasConError.push(zona);
      filas.push({
        zona,
        orden: i + 1,
        estado: 'error',
        campanaId: null,
        direccionesTotal: 0,
        direccionesEnviadas: 0,
        direccionesFallidas: 0,
        direccionesPendientes: 0,
        error: resultadoZona.error,
      });
      // `asignado` NO se toca: sin los contactos de esta zona no hay nada
      // que reservarle a las zonas futuras del recorrido. Costo aceptado,
      // angosto y del mismo tipo que la simplificación deliberada de la
      // zona en curso (ver el comentario grande del encabezado): una
      // dirección que viva en ESTA zona y también en una zona futura
      // podría, sólo mientras esta zona siga en error, contarse en la
      // futura -- se prefiere seguir mostrando algo útil de las otras doce
      // a dejar de mostrarlas por esto.
      continue;
    }
    const conCorreoZona = conCorreo(resultadoZona.contactos);

    const vistos = new Set<string>();
    const candidatos: DestinatarioCampana[] = [];
    for (const d of conCorreoZona) {
      const normal = normalizarCorreo(d.correo);
      if (asignado.has(normal) || vistos.has(normal)) continue;
      vistos.add(normal);
      candidatos.push(d);
    }

    const permitidos = await filtrarPermitidosParaCampana(candidatos, db);
    for (const p of permitidos) asignado.add(normalizarCorreo(p.correo));

    filas.push({
      zona,
      orden: i + 1,
      estado: 'espera',
      campanaId: null,
      direccionesTotal: permitidos.length,
      direccionesEnviadas: 0,
      direccionesFallidas: 0,
      direccionesPendientes: permitidos.length,
      error: null,
    });
    totalDirecciones += permitidos.length;
    totalPendientes += permitidos.length;
  }

  // El cupo de hoy -- mismo cálculo que usaría `reservarCupoDiario` si
  // corriera ahora mismo, pero de SÓLO LECTURA: nunca se llama al rpc que
  // reserva (eso escribe). `diaDeRampa` y una lectura simple de
  // `campanas_envio_diario` alcanzan para reconstruirlo.
  const dia = await diaDeRampa(db, fechaHoy);
  const tope = topeParaDia(dia);
  const { data: filaHoy, error: errorHoy } = await db
    .from('campanas_envio_diario')
    .select('enviados')
    .eq('fecha', fechaHoy)
    .maybeSingle();
  if (errorHoy) {
    throw new Error(`No se pudo leer el cupo de hoy: ${errorHoy.message}`);
  }
  const reservadoHoy = (filaHoy as { enviados: number } | null)?.enviados ?? 0;
  const fechaHoyDate = new Date(`${fechaHoy}T00:00:00.000Z`);
  const cupoHoy: CupoHoy = {
    dia,
    tope,
    reservado: reservadoHoy,
    disponible: Math.max(0, tope - reservadoHoy),
    diaHabilHoy: esDiaHabil(fechaHoyDate),
  };

  // La fecha estimada se sigue calculando con lo que sí se pudo contar --
  // nunca `null` sólo porque una zona quedó en error: es información
  // parcial pero real ("con lo que sabemos hoy, esto es lo que falta"), y
  // la pantalla ya la marca "Estimado" con su propio descargo. Lo que
  // `totalIncompleto` agrega es la advertencia de que ese "lo que sabemos"
  // es, en este cálculo puntual, un piso -- nunca el total real.
  const estimado = fechaEstimadaFin(totalPendientes, dia, fechaHoyDate, reservadoHoy);

  return {
    zonas: filas,
    totalDirecciones,
    totalEnviadas,
    totalFallidas,
    totalPendientes,
    cupoHoy,
    fechaEstimadaFin: estimado,
    totalIncompleto,
    zonasConError,
  };
}
