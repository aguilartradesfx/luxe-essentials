import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Cotizador, { CSRF_STORAGE_KEY } from '@/app/cotizador/Panel';

// Tarea 8: el catálogo ya no viaja en el bundle. `Cotizador` arranca con una
// pantalla de clave y solo pide el catálogo (sin precios) a
// `/api/cotizacion/catalogo` cuando se valida; la vista previa (con rebote de
// 300ms) sale de `/api/cotizacion/previsualizar`. Estas pruebas simulan las
// dos rutas — antes ejercitaban `calcular()` y `CATALOGO` directo en el
// navegador, ahora ejercitan el fetch que los reemplaza.
//
// Revisión posterior a la Tarea 8: se agregaron las pruebas que faltaban
// sobre el bloqueo de líneas incompletas, la protección contra doble envío,
// el rechazo visible de decimales, el orden total/IVA, el motivo con
// descuento cero, los mensajes de red en español y la condición del botón
// alineada con lo que exige el servidor. Cada una se verificó en rojo
// (revirtiendo temporalmente el fix correspondiente) antes de dejarla en
// verde — ver el reporte de la Tarea 8 para el detalle de qué mutante mata
// cada una.

// El id y la familia de "set de 600 hilos king" deben coincidir con
// lib/cotizador/catalogo.ts (`set-600-king`, familia "Sets de cama 600
// hilos") — no son datos inventados libremente: si divergen, esta suite
// puede seguir en verde mientras la pantalla real manda al servidor un SKU
// que `calcular()` rechazaría con 400. Ese contrato no lo sostiene esta
// prueba (usa un mock, no el motor real): lo sostiene
// tests/api-cotizacion-previsualizar.test.ts, que sí llama a
// `/api/cotizacion/previsualizar` con este mismo SKU y afirma el `motivo` y
// el `precioUnitario` reales que produce el motor. Si alguien mueve el
// escalón de 16 a otro número, esa prueba hermana se pone roja y avisa que
// hay que actualizar también el mock de acá.
const SKUS = [
  { id: 'set-600-king', nombre: 'set de 600 hilos king', familia: 'Sets de cama 600 hilos' },
  { id: 'uni-filipina-tradicional-manga-corta', nombre: 'filipina tradicional manga corta', familia: 'Uniformes' },
  { id: 'inserto-duvet-king', nombre: 'inserto de duvet king', familia: 'Edredones' },
];

// Token anti-CSRF que devuelve el simulacro de `/api/cotizacion/entrar` (y,
// cuando aplica, el de `/api/cotizacion/catalogo` por cookie) — Ronda de
// correcciones 1 (Tarea 9). Un valor fijo alcanza: lo único que estas
// pruebas verifican es que la pantalla lo guarde y lo reenvíe tal cual, no
// que sea criptográficamente válido (eso lo prueba el servidor, en
// tests/api-cotizacion-sesion.test.ts).
const CSRF_TOKEN_DE_PRUEBA = 'csrf-token-de-prueba';

// Réplica mínima de lo que hace `calcular()` en el servidor para las líneas
// que estas pruebas necesitan: sets de cama (escalón de 16 → 10%, y "sin
// descuento" por debajo de 10) y todo lo demás sin descuento. No es el motor
// real —vive en el servidor y esta prueba no debe reimportarlo, sería volver
// a arrastrar el catálogo—, solo lo justo para que la pantalla tenga algo
// coherente que pintar. La etiqueta "Sets de cama" en el `motivo` es la de
// `ESCALAS['sets-cama'].etiqueta` (lib/cotizador/escalas.ts), no la familia
// del SKU — son dos campos distintos, y confundirlos fue justamente el
// descuido que esta nota corrige.
function cotizacionSimulada(lineas: { skuId: string; cantidad: number }[], tasaIva: number, bordadoEspecial: boolean) {
  const totalSetsDeCama = lineas
    .filter((l) => l.skuId === 'set-600-king')
    .reduce((acc, l) => acc + l.cantidad, 0);
  const pct = totalSetsDeCama >= 16 ? 10 : totalSetsDeCama >= 10 ? 5 : 0;

  const calculadas = lineas.map((l) => {
    const esSet = l.skuId === 'set-600-king';
    const precioLista = 90000;
    const descuentoPct = esSet ? pct : 0;
    const precioUnitario = Math.round(precioLista * (1 - descuentoPct / 100));
    const subtotal = precioUnitario * l.cantidad;
    return {
      skuId: l.skuId,
      nombre: SKUS.find((s) => s.id === l.skuId)?.nombre ?? l.skuId,
      cantidad: l.cantidad,
      precioLista,
      descuentoPct,
      precioUnitario,
      subtotal,
      grupo: esSet ? 'sets-cama' : 'uniformes',
      motivo: esSet
        ? `${totalSetsDeCama} sets en Sets de cama → ${pct === 0 ? 'sin descuento' : `${pct}%`}`
        : 'sin descuento',
    };
  });

  const subtotal = calculadas.reduce((acc, l) => acc + l.subtotal, 0);
  const bruto = calculadas.reduce((acc, l) => acc + l.precioLista * l.cantidad, 0);
  const iva = Math.round(subtotal * tasaIva);
  return {
    lineas: calculadas,
    subtotal,
    ahorro: bruto - subtotal,
    tasaIva,
    iva,
    total: subtotal + iva,
    bordadoEspecial,
  };
}

type OpcionesFetch = {
  // Si se define, `/api/cotizacion` responde con éxito la primera vez que se
  // llega a este número de llamadas y sigue existiendo (para probar qué pasa
  // si, pese a todo, se dispara una segunda petición).
  fallarRed?: 'previsualizar' | 'cotizacion';
  // Lo que devuelve `/api/cotizacion/borradores`. Por defecto, vacío — las
  // pruebas de armado de la cotización no necesitan borradores; las que sí
  // los necesitan (la cola del agente) lo pasan explícito.
  borradores?: unknown[];
  // Fuerza la `tasaIva` que devuelve `/api/cotizacion/previsualizar`, sin
  // importar qué tasa mandó la pantalla. Sirve para probar el rótulo del IVA
  // con una tasa fraccionaria (2.5%) que el `<select>` de la pantalla no
  // puede producir hoy (solo ofrece 13% y 0%): lo que se ejercita es que el
  // rótulo formatea `cotizacion.tasaIva` sin `Math.round`, no el viaje de
  // ida y vuelta de la tasa.
  previsualizarTasaIvaForzada?: number;
  // Tarea 5, ronda de correcciones 1: por defecto `/api/cotizacion` responde
  // como si el PDF y el correo hubieran salido bien. Estas dos permiten que
  // una prueba puntual simule que el correo falló (con el PDF sí guardado)
  // o que el PDF nunca se generó, sin tener que reescribir todo `mockFetch`.
  correoFalla?: string;
  pdfFalla?: boolean;
  // Ronda de correcciones 1 (Tarea 9) — sesión por cookie y CSRF:
  // `sesionActiva` simula que ya hay una cookie válida antes de montar la
  // pantalla: `/api/cotizacion/catalogo` responde bien aunque el cuerpo no
  // traiga `clave` (la sonda de `Panel`). `csrf` fija el token que devuelven
  // `/entrar` y (si `sesionActiva`) `/catalogo`; por defecto,
  // `CSRF_TOKEN_DE_PRUEBA`. `crear401` hace que `/api/cotizacion` responda
  // 401 sin importar qué mande la pantalla — simula un token anti-CSRF
  // rancio, para probar la recuperación.
  sesionActiva?: boolean;
  csrf?: string;
  crear401?: boolean;
};

function mockFetch(opciones: OpcionesFetch = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const cuerpo = init?.body ? JSON.parse(init.body as string) : {};
    const csrf = opciones.csrf ?? CSRF_TOKEN_DE_PRUEBA;

    if (url.endsWith('/api/cotizacion/catalogo')) {
      if (cuerpo.clave === 'correcta') {
        return new Response(JSON.stringify({ ok: true, skus: SKUS }), { status: 200 });
      }
      // Ronda de correcciones 1 (Tarea 9): la sonda de sesión de `Panel`
      // llama acá sin `clave`, apoyada solo en la cookie. `sesionActiva`
      // simula que esa cookie ya es válida — y, como la ruta real, devuelve
      // el token anti-CSRF derivado de ella en la misma respuesta.
      if (!cuerpo.clave && opciones.sesionActiva) {
        return new Response(JSON.stringify({ ok: true, skus: SKUS, csrf }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: false, error: 'Clave incorrecta.' }), { status: 401 });
    }

    if (url.endsWith('/api/cotizacion/entrar')) {
      // Ronda de correcciones 1 (Tarea 9): valida la clave igual que
      // `/catalogo` arriba — a propósito el mismo criterio, para que ningún
      // simulacro de este archivo pueda "entrar" con una clave que el
      // servidor real rechazaría.
      if (cuerpo.clave !== 'correcta') {
        return new Response(JSON.stringify({ ok: false, error: 'Clave incorrecta.' }), { status: 401 });
      }
      return new Response(JSON.stringify({ ok: true, csrf }), { status: 200 });
    }

    if (url.endsWith('/api/cotizacion/borradores')) {
      // Tarea 10: se llama justo al entrar. Vacío salvo que la prueba pida
      // otra cosa vía `opciones.borradores`.
      return new Response(JSON.stringify({ ok: true, borradores: opciones.borradores ?? [] }), { status: 200 });
    }

    if (url.endsWith('/api/cotizacion/listado')) {
      // Ronda de correcciones 1 (Tarea 10): la pestaña "Cotizaciones" pide
      // esto al montar. Vacío alcanza para las pruebas de este archivo —lo
      // único que ejercitan de esa pestaña es que cambiar a ella y volver
      // no le borre al vendedor lo que armó en "Crear".
      return new Response(JSON.stringify({ ok: true, cotizaciones: [], locationId: 'loc-1' }), { status: 200 });
    }

    if (url.endsWith('/api/cotizacion/previsualizar')) {
      if (opciones.fallarRed === 'previsualizar') {
        throw new TypeError('Failed to fetch');
      }
      const tasaIva = opciones.previsualizarTasaIvaForzada ?? cuerpo.tasaIva ?? 0.13;
      const cotizacion = cotizacionSimulada(cuerpo.lineas ?? [], tasaIva, cuerpo.bordadoEspecial ?? false);
      return new Response(JSON.stringify({ ok: true, cotizacion }), { status: 200 });
    }

    if (url.endsWith('/api/cotizacion')) {
      if (opciones.fallarRed === 'cotizacion') {
        throw new TypeError('Failed to fetch');
      }
      // Ronda de correcciones 1 (Tarea 9, hallazgo crítico): simula un token
      // anti-CSRF rancio (p. ej. una segunda pestaña rotó la cookie) — la
      // pantalla debe recuperarse, no quedar atrapada.
      if (opciones.crear401) {
        return new Response(JSON.stringify({ ok: false, error: 'Token anti-CSRF inválido.' }), { status: 401 });
      }
      const pdf = opciones.pdfFalla ? null : { ruta: '2026/COT-2026-0001-cot-1.pdf' };
      const correo = opciones.pdfFalla
        ? { error: 'No se generó el PDF: no se intentó enviar el correo.' }
        : opciones.correoFalla
          ? { error: opciones.correoFalla }
          : { resendId: 're_1' };
      return new Response(
        JSON.stringify({
          ok: true,
          id: 'cot-1',
          numero: 'COT-2026-0001',
          cotizacion: cotizacionSimulada(cuerpo.lineas ?? [], cuerpo.tasaIva ?? 0.13, cuerpo.bordadoEspecial ?? false),
          ghl: { estimateId: 'est-1' },
          pdf,
          correo,
        }),
        { status: 200 },
      );
    }

    throw new Error(`Fetch no simulado en la prueba: ${url}`);
  });
}

// Entra con la clave correcta y espera a que el catálogo (sin precios) esté
// cargado, es decir, a que la pantalla de clave se haya reemplazado por la
// pantalla principal.
async function entrar(usuario: ReturnType<typeof userEvent.setup>) {
  await usuario.type(screen.getByLabelText(/^clave$/i), 'correcta');
  await usuario.click(screen.getByRole('button', { name: /entrar/i }));
  await waitFor(() => {
    expect(screen.getByLabelText(/buscar/i)).toBeInTheDocument();
  });
}

// Busca un producto por texto y lo agrega (queda con cantidad "1").
async function agregar(usuario: ReturnType<typeof userEvent.setup>, texto: string) {
  await usuario.clear(screen.getByLabelText(/buscar/i));
  await usuario.type(screen.getByLabelText(/buscar/i), texto);
  await usuario.click(screen.getByRole('button', { name: /agregar/i }));
}

async function llenarCliente(
  usuario: ReturnType<typeof userEvent.setup>,
  { nombre, email, telefono, direccion }: { nombre?: string; email?: string; telefono?: string; direccion?: string },
) {
  if (nombre !== undefined) await usuario.type(screen.getByLabelText(/nombre del cliente/i), nombre);
  if (email !== undefined) await usuario.type(screen.getByLabelText(/correo del cliente/i), email);
  if (telefono !== undefined) await usuario.type(screen.getByLabelText(/teléfono del cliente/i), telefono);
  if (direccion !== undefined) await usuario.type(screen.getByLabelText(/dirección del cliente/i), direccion);
}

describe('Cotizador', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('pide la clave antes de mostrar el catálogo', () => {
    mockFetch();
    render(<Cotizador />);
    expect(screen.getByLabelText(/^clave$/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/buscar producto/i)).not.toBeInTheDocument();
  });

  it('avisa si la clave es incorrecta y no entra', async () => {
    mockFetch();
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await usuario.type(screen.getByLabelText(/^clave$/i), 'mala');
    await usuario.click(screen.getByRole('button', { name: /entrar/i }));
    await waitFor(() => {
      expect(screen.getByText(/clave incorrecta/i)).toBeInTheDocument();
    });
    expect(screen.queryByLabelText(/buscar producto/i)).not.toBeInTheDocument();
  });

  it('empieza sin líneas y con el total en cero, tras entrar con la clave', async () => {
    mockFetch();
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await entrar(usuario);
    expect(screen.getByText(/₡0/)).toBeInTheDocument();
  });

  it('filtra el catálogo al escribir en el buscador', async () => {
    mockFetch();
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await entrar(usuario);
    await usuario.type(screen.getByLabelText(/buscar/i), 'inserto');
    expect(screen.getByText(/inserto de duvet king/i)).toBeInTheDocument();
    expect(screen.queryByText(/filipina/i)).not.toBeInTheDocument();
  });

  it('muestra el motivo del descuento al alcanzar el umbral', async () => {
    mockFetch();
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await entrar(usuario);
    await agregar(usuario, 'set de 600 hilos king');
    const cantidad = screen.getByLabelText(/cantidad/i);
    await usuario.clear(cantidad);
    await usuario.type(cantidad, '16');
    await waitFor(
      () => {
        expect(screen.getByText(/16 sets en Sets de cama → 10%/)).toBeInTheDocument();
      },
      { timeout: 2000 },
    );
  });

  it('muestra el motivo también cuando no aplica ningún descuento', async () => {
    // Mata el mutante "ocultar el motivo cuando el descuento es cero": si el
    // render solo pinta `calculada.motivo` cuando `descuentoPct > 0`, esta
    // prueba se queda sin el texto y falla.
    mockFetch();
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await entrar(usuario);
    await agregar(usuario, 'set de 600 hilos king');
    // Se agrega con cantidad 1: muy por debajo del escalón de descuento.
    await waitFor(
      () => {
        expect(screen.getByText(/1 sets en Sets de cama → sin descuento/)).toBeInTheDocument();
      },
      { timeout: 2000 },
    );
  });

  it('el total cotizado aparece antes que el IVA en el resumen, como pidió Luxe por escrito', async () => {
    // Mata el mutante que invierte el orden del bloque de totales: el brief
    // (Tarea 8) es explícito — "el total primero y el IVA abajo".
    mockFetch();
    const usuario = userEvent.setup();
    const { container } = render(<Cotizador />);
    await entrar(usuario);
    await agregar(usuario, 'set de 600 hilos king');
    await waitFor(
      () => {
        expect(screen.getByText(/IVA \(/)).toBeInTheDocument();
      },
      { timeout: 2000 },
    );
    const texto = container.textContent ?? '';
    const posTotal = texto.indexOf('Total cotizado');
    const posIva = texto.search(/IVA \(/);
    expect(posTotal).toBeGreaterThanOrEqual(0);
    expect(posIva).toBeGreaterThan(posTotal);
  });

  it('el rótulo del IVA no redondea una tasa fraccionaria (mismo formato que lib/cotizador/ghl.ts)', async () => {
    // Math.round(0.025 * 100) da 3: "IVA (3%)" miente sobre una tasa real de
    // 2.5%. Ronda de correcciones 2 (menor, de paso): mismo error que ya se
    // había corregido en lib/cotizador/ghl.ts con `formatearTasa`, y que acá
    // se había quedado a medias. Mata el mutante que reintroduce
    // `Math.round(cotizacion.tasaIva * 100)` en el rótulo.
    mockFetch({ previsualizarTasaIvaForzada: 0.025 });
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await entrar(usuario);
    await agregar(usuario, 'set de 600 hilos king');
    await waitFor(
      () => {
        expect(screen.getByText(/IVA \(2\.5%\)/)).toBeInTheDocument();
      },
      { timeout: 2000 },
    );
    expect(screen.queryByText(/IVA \(3%\)/)).not.toBeInTheDocument();
    expect(screen.queryByText(/IVA \(2%\)/)).not.toBeInTheDocument();
  });

  it('avisa cuando se marca bordado especial', async () => {
    mockFetch();
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await entrar(usuario);
    await usuario.click(screen.getByLabelText(/bordado especial/i));
    expect(screen.getByText(/se confirma contra muestra/i)).toBeInTheDocument();
  });

  it('nunca le pasa al motor una tasa que lo haga lanzar', async () => {
    mockFetch();
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await entrar(usuario);
    await agregar(usuario, 'set de 600 hilos king');
    // El selector ofrece valores fijos: no hay forma de escribir una tasa
    // inválida. Si esto se convierte en texto libre, esta prueba debe cambiar
    // a comprobar la normalización — no borrarse.
    const iva = screen.getByLabelText(/iva/i);
    expect(iva.tagName).toBe('SELECT');
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
  });

  it('no deja enviar sin correo del cliente', async () => {
    mockFetch();
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await entrar(usuario);
    await agregar(usuario, 'set de 600 hilos king');
    expect(screen.getByRole('button', { name: /cotizar y enviar/i })).toBeDisabled();
  });

  it('no deja enviar sin el nombre del cliente, aunque haya correo (el servidor también lo exige)', async () => {
    mockFetch();
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await entrar(usuario);
    await agregar(usuario, 'set de 600 hilos king');
    await llenarCliente(usuario, { email: 'cliente@empresa.com' });
    expect(screen.getByRole('button', { name: /cotizar y enviar/i })).toBeDisabled();
    await llenarCliente(usuario, { nombre: 'Ana Pérez' });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /cotizar y enviar/i })).not.toBeDisabled();
    });
  });

  it('el catálogo servido a la pantalla no trae precios', async () => {
    mockFetch();
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await entrar(usuario);
    await usuario.type(screen.getByLabelText(/buscar/i), 'set de 600 hilos king');
    // Antes de la Tarea 8 esta lista mostraba el precio de lista junto a la
    // familia. Ahora `SkuUI` no lo trae: si algún día vuelve a aparecer aquí,
    // es porque el catálogo completo volvió a viajar al navegador.
    expect(screen.queryByText(/₡90\.000/)).not.toBeInTheDocument();
  });

  it('rechaza una cantidad decimal de forma visible en vez de truncarla en silencio', async () => {
    mockFetch();
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await entrar(usuario);
    await agregar(usuario, 'set de 600 hilos king');
    const cantidad = screen.getByLabelText(/cantidad/i);
    await usuario.clear(cantidad);
    await usuario.type(cantidad, '2.5');

    // El campo debe seguir mostrando exactamente lo que el vendedor escribió...
    expect(cantidad).toHaveValue(2.5);
    // ...con un error visible junto a la línea...
    expect(screen.getByText(/entero, sin decimales/i)).toBeInTheDocument();
    // ...y sin cotizar "2" por su cuenta: con la única línea inválida, el
    // total se queda en cero en vez de mostrar un cálculo que el vendedor no
    // escribió. (Varias cifras de la pantalla son "₡0" a la vez — subtotal,
    // ahorro, IVA — así que se apunta puntualmente al valor bajo "Total
    // cotizado".)
    const totalValor = screen.getByText('Total cotizado').nextElementSibling;
    expect(totalValor).toHaveTextContent('₡0');
    expect(screen.getByRole('button', { name: /cotizar y enviar/i })).toBeDisabled();
  });

  it('bloquea el envío si una línea se queda sin cantidad, en vez de mandarla incompleta en silencio', async () => {
    const fetchEspiado = mockFetch();
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await entrar(usuario);
    await agregar(usuario, 'set de 600 hilos king');
    await agregar(usuario, 'filipina tradicional manga corta');
    await llenarCliente(usuario, { nombre: 'Ana Pérez', email: 'ana@empresa.com' });

    // Dos líneas en pantalla; se borra la cantidad de la segunda.
    const cantidades = screen.getAllByLabelText(/cantidad/i);
    expect(cantidades).toHaveLength(2);
    await usuario.clear(cantidades[1]);

    await waitFor(() => {
      expect(screen.getByText(/falta la cantidad/i)).toBeInTheDocument();
    });
    const boton = screen.getByRole('button', { name: /cotizar y enviar/i });
    expect(boton).toBeDisabled();

    // Aunque se intente, el botón deshabilitado no dispara el envío: nunca
    // debe llegar una petición a /api/cotizacion con una sola línea cuando
    // el vendedor armó dos.
    await usuario.click(boton);
    const llamadasAlEnvio = fetchEspiado.mock.calls.filter(([input]) =>
      (typeof input === 'string' ? input : input.toString()).endsWith('/api/cotizacion'),
    );
    expect(llamadasAlEnvio).toHaveLength(0);
  });

  it('el cuerpo del envío final ya no lleva la clave y manda el token anti-CSRF en la cabecera, con las líneas tal cual están en pantalla, sin un total inventado', async () => {
    // Ronda de correcciones 1 (Tarea 9): este contrato reemplaza al de la
    // etapa anterior a la sesión por cookie. Antes mataba el mutante
    // "mandar total: 1 y quitar la clave" exigiendo `clave` en el cuerpo;
    // ahora la clave ya no viaja ahí en absoluto —la sesión por cookie más
    // el token anti-CSRF de la cabecera son la única credencial de este
    // envío—, así que el mutante equivalente hoy es "quitar la cabecera
    // `x-csrf-token`", cubierto por la aserción de más abajo.
    const fetchEspiado = mockFetch();
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await entrar(usuario);
    await agregar(usuario, 'set de 600 hilos king');
    await llenarCliente(usuario, { nombre: 'Ana Pérez', email: 'ana@empresa.com' });

    // La sesión por cookie (Tarea 9) se establece en segundo plano tras
    // entrar: se espera a que el token quede guardado antes de enviar, para
    // no depender de que las interacciones de arriba le hayan dado tiempo
    // por casualidad.
    await waitFor(() => {
      expect(sessionStorage.getItem(CSRF_STORAGE_KEY)).toBe(CSRF_TOKEN_DE_PRUEBA);
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /cotizar y enviar/i })).not.toBeDisabled();
    });
    await usuario.click(screen.getByRole('button', { name: /cotizar y enviar/i }));

    await waitFor(() => {
      expect(screen.getByText(/enviada a/i)).toBeInTheDocument();
    });

    const llamada = fetchEspiado.mock.calls.find(([input]) =>
      (typeof input === 'string' ? input : input.toString()).endsWith('/api/cotizacion'),
    );
    expect(llamada).toBeDefined();
    const init = llamada![1] as RequestInit;
    const cuerpo = JSON.parse(init.body as string);

    expect(cuerpo).toEqual({
      cliente: { nombre: 'Ana Pérez', email: 'ana@empresa.com' },
      lineas: [{ skuId: 'set-600-king', cantidad: 1 }],
      tasaIva: 0.13,
      bordadoEspecial: false,
    });
    expect('total' in cuerpo).toBe(false);
    expect('clave' in cuerpo).toBe(false);

    const cabeceras = new Headers(init.headers);
    expect(cabeceras.get('x-csrf-token')).toBe(CSRF_TOKEN_DE_PRUEBA);
  });

  it('el botón dice la verdad ANTES del clic: ahora sí manda la cotización', async () => {
    // Ronda de correcciones "final-fix-C": el botón decía "Enviar cotización"
    // cuando `crearEstimate` (lib/cotizador/ghl.ts) solo creaba un Estimate
    // en borrador — nada salía de verdad. Ronda de correcciones 1 (Tarea 5):
    // ahora SÍ sale (correo con el PDF adjunto), así que "Cotizar y enviar"
    // vuelve a ser cierto en los tres estados: reposo, en vuelo y terminado.
    // Mutante que esto mata: volver a un texto que no diga "enviar" en
    // ninguno de los tres, o mantener el texto viejo "Crear en GoHighLevel".
    //
    // El envío a `/api/cotizacion` se retiene a propósito (con una promesa
    // que esta prueba libera a mano) para poder observar el estado "en
    // vuelo" — con el `mockFetch` compartido, que resuelve en el mismo
    // microtask, esa ventana es demasiado angosta para capturarla con
    // `waitFor`.
    let liberarEnvio: (() => void) | undefined;
    const bloqueoEnvio = new Promise<void>((resolve) => {
      liberarEnvio = resolve;
    });
    const fetchEspiado = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const cuerpo = init?.body ? JSON.parse(init.body as string) : {};

      if (url.endsWith('/api/cotizacion/catalogo')) {
        // Ronda de correcciones 1 (Tarea 9): este simulacro respondía
        // `ok: true` sin mirar la clave — a diferencia del `mockFetch()`
        // compartido, que sí la exige. Con la sonda de sesión de `Panel`
        // (dispara siempre al montar, sin gate), ese simulacro laxo hacía
        // que la pantalla "entrara sola" antes de que esta prueba llegara a
        // escribir la clave y apretar "Entrar" — el simulacro mentía sobre
        // lo que hace el servidor real (tests/api-cotizacion-catalogo.test.ts:
        // rechaza sin clave). Corregido para que valide igual que el mock
        // compartido.
        if (cuerpo.clave !== 'correcta') {
          return new Response(JSON.stringify({ ok: false, error: 'Clave incorrecta.' }), { status: 401 });
        }
        return new Response(JSON.stringify({ ok: true, skus: SKUS }), { status: 200 });
      }
      if (url.endsWith('/api/cotizacion/entrar')) {
        if (cuerpo.clave !== 'correcta') {
          return new Response(JSON.stringify({ ok: false, error: 'Clave incorrecta.' }), { status: 401 });
        }
        return new Response(JSON.stringify({ ok: true, csrf: CSRF_TOKEN_DE_PRUEBA }), { status: 200 });
      }
      if (url.endsWith('/api/cotizacion/borradores')) {
        return new Response(JSON.stringify({ ok: true, borradores: [] }), { status: 200 });
      }
      if (url.endsWith('/api/cotizacion/previsualizar')) {
        const cotizacion = cotizacionSimulada(cuerpo.lineas ?? [], cuerpo.tasaIva ?? 0.13, cuerpo.bordadoEspecial ?? false);
        return new Response(JSON.stringify({ ok: true, cotizacion }), { status: 200 });
      }
      if (url.endsWith('/api/cotizacion')) {
        await bloqueoEnvio;
        return new Response(
          JSON.stringify({
            ok: true,
            id: 'cot-1',
            numero: 'COT-2026-0001',
            ghl: { estimateId: 'est-1' },
            pdf: { ruta: '2026/COT-2026-0001-cot-1.pdf' },
            correo: { resendId: 're_1' },
          }),
          { status: 200 },
        );
      }
      throw new Error(`Fetch no simulado en la prueba: ${url}`);
    });

    const usuario = userEvent.setup();
    render(<Cotizador />);
    await entrar(usuario);
    await agregar(usuario, 'set de 600 hilos king');
    await llenarCliente(usuario, { nombre: 'Ana Pérez', email: 'ana@empresa.com' });

    const boton = await screen.findByRole('button', { name: /cotizar y enviar/i });
    expect(boton).not.toBeDisabled();
    // El texto de reposo ya sí promete un envío que ahora ocurre de verdad.
    expect(boton.textContent).toMatch(/enviar/i);

    await usuario.click(boton);
    // Estado "en vuelo": "Enviando…" describe lo que de verdad está en
    // curso. La petición sigue retenida por `bloqueoEnvio`, así que este
    // estado es estable hasta liberarlo.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /enviando/i })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /enviando/i }).textContent).toMatch(/enviando/i);

    liberarEnvio?.();

    await waitFor(() => {
      expect(screen.getByText(/enviada a/i)).toBeInTheDocument();
    });
    // Solo hubo una llamada real al servidor propio, disparada por el único clic.
    const llamadasAlEnvio = fetchEspiado.mock.calls.filter(([input]) =>
      (typeof input === 'string' ? input : input.toString()).endsWith('/api/cotizacion'),
    );
    expect(llamadasAlEnvio).toHaveLength(1);
  });

  it('el mensaje de éxito dice la verdad: a qué correo salió, con el número de cotización, sin instrucciones de mandarla a mano', async () => {
    // Ronda de correcciones 1 (Tarea 5): antes decía "falta enviarla al
    // cliente... abrila en GoHighLevel y envíala vos desde ahí" — cierto
    // cuando el único "envío" era el Estimate en borrador de GoHighLevel.
    // Ahora el correo con el PDF adjunto sí sale solo, así que ese texto
    // sería activamente falso (y llevaría al vendedor a mandar la misma
    // cotización dos veces, en formatos distintos). La pantalla tiene que
    // decir a qué correo llegó y con qué número, y ya no debe instruir a
    // nadie a enviarla a mano.
    mockFetch();
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await entrar(usuario);
    await agregar(usuario, 'set de 600 hilos king');
    await llenarCliente(usuario, { nombre: 'Ana Pérez', email: 'ana@empresa.com' });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /cotizar y enviar/i })).not.toBeDisabled();
    });
    await usuario.click(screen.getByRole('button', { name: /cotizar y enviar/i }));

    await waitFor(() => {
      expect(screen.getByText(/enviada a/i)).toBeInTheDocument();
    });
    // A qué correo y con qué número — la información que de verdad importa.
    expect(screen.getByText(/ana@empresa\.com/i)).toBeInTheDocument();
    expect(screen.getByText(/cot-2026-0001/i)).toBeInTheDocument();
    // El texto viejo, que prometía un envío pendiente que ya no existe, no
    // puede seguir apareciendo.
    expect(screen.queryByText(/falta enviarla al cliente/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/env[ií]ala vos desde ah[ií]/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/enviada en gohighlevel/i)).not.toBeInTheDocument();
  });

  it('si el correo falla, lo dice en rojo: la cotización se guardó, el PDF quedó guardado, pero el correo no salió', async () => {
    // No existía ninguna prueba de este camino en ninguna capa (UI incluida)
    // antes de esta ronda. Es el caso más delicado: la fila y el PDF sí
    // quedaron bien, pero el hotel no recibió nada — si la pantalla no lo
    // dice en rojo, el vendedor puede creer que ya se mandó.
    mockFetch({ correoFalla: 'dominio no verificado' });
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await entrar(usuario);
    await agregar(usuario, 'set de 600 hilos king');
    await llenarCliente(usuario, { nombre: 'Ana Pérez', email: 'ana@empresa.com' });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /cotizar y enviar/i })).not.toBeDisabled();
    });
    await usuario.click(screen.getByRole('button', { name: /cotizar y enviar/i }));

    const aviso = await screen.findByText(/el correo no sali/i);
    expect(aviso).toBeInTheDocument();
    expect(aviso.textContent).toMatch(/dominio no verificado/i);
    expect(aviso.textContent).toMatch(/pdf.*guard/i);
    expect(aviso.className).toMatch(/red/);
    // No debe sonar como si sí hubiera salido.
    expect(screen.queryByText(/enviada a/i)).not.toBeInTheDocument();
  });

  it('si el PDF nunca se generó, lo dice: no se envió nada y la cotización quedó recuperable', async () => {
    mockFetch({ pdfFalla: true });
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await entrar(usuario);
    await agregar(usuario, 'set de 600 hilos king');
    await llenarCliente(usuario, { nombre: 'Ana Pérez', email: 'ana@empresa.com' });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /cotizar y enviar/i })).not.toBeDisabled();
    });
    await usuario.click(screen.getByRole('button', { name: /cotizar y enviar/i }));

    const aviso = await screen.findByText(/no se pudo generar el pdf/i);
    expect(aviso.textContent).toMatch(/no se envi/i);
    expect(aviso.textContent).toMatch(/recuperable/i);
    expect(aviso.className).toMatch(/red/);
  });

  it('GoHighLevel aparece como una línea secundaria, sin instrucciones de enviar a mano', async () => {
    mockFetch();
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await entrar(usuario);
    await agregar(usuario, 'set de 600 hilos king');
    await llenarCliente(usuario, { nombre: 'Ana Pérez', email: 'ana@empresa.com' });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /cotizar y enviar/i })).not.toBeDisabled();
    });
    await usuario.click(screen.getByRole('button', { name: /cotizar y enviar/i }));

    await waitFor(() => {
      expect(screen.getByText(/est-1/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/env[ií]ala vos desde ah[ií]/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/abrila en gohighlevel/i)).not.toBeInTheDocument();
  });

  it('no permite un segundo envío tras uno exitoso (protección contra doble clic)', async () => {
    const fetchEspiado = mockFetch();
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await entrar(usuario);
    await agregar(usuario, 'set de 600 hilos king');
    await llenarCliente(usuario, { nombre: 'Ana Pérez', email: 'ana@empresa.com' });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /cotizar y enviar/i })).not.toBeDisabled();
    });
    const boton = screen.getByRole('button', { name: /cotizar y enviar/i });
    await usuario.click(boton);

    await waitFor(() => {
      expect(screen.getByText(/enviada a/i)).toBeInTheDocument();
    });

    // El botón, terminado el envío, describe lo que de verdad pasó: la fila
    // se guardó. El detalle de a dónde salió (o si falló) vive en el mensaje
    // de resultado, no en el botón.
    const botonTrasEnvio = screen.getByRole('button', { name: /cotización guardada/i });
    expect(botonTrasEnvio).toBeDisabled();

    // Un segundo clic (el "clic nervioso") no debe crear otra fila en
    // Supabase ni otro Estimate en GoHighLevel.
    await usuario.click(botonTrasEnvio);
    const llamadasAlEnvio = fetchEspiado.mock.calls.filter(([input]) =>
      (typeof input === 'string' ? input : input.toString()).endsWith('/api/cotizacion'),
    );
    expect(llamadasAlEnvio).toHaveLength(1);

    // Solo "Nueva cotización" reabre la puerta.
    expect(screen.getByRole('button', { name: /nueva cotización/i })).toBeInTheDocument();
  });

  it('un fallo de red en la vista previa se muestra en español, no el mensaje crudo del navegador', async () => {
    mockFetch({ fallarRed: 'previsualizar' });
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await entrar(usuario);
    await agregar(usuario, 'set de 600 hilos king');

    await waitFor(
      () => {
        expect(screen.getByText(/fallo de red/i)).toBeInTheDocument();
      },
      { timeout: 2000 },
    );
    expect(screen.queryByText(/failed to fetch/i)).not.toBeInTheDocument();
  });

  it('un fallo de red al enviar se muestra en español, no el mensaje crudo del navegador', async () => {
    mockFetch({ fallarRed: 'cotizacion' });
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await entrar(usuario);
    await agregar(usuario, 'set de 600 hilos king');
    await llenarCliente(usuario, { nombre: 'Ana Pérez', email: 'ana@empresa.com' });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /cotizar y enviar/i })).not.toBeDisabled();
    });
    await usuario.click(screen.getByRole('button', { name: /cotizar y enviar/i }));

    await waitFor(() => {
      expect(screen.getByText(/fallo de red/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/failed to fetch/i)).not.toBeInTheDocument();
  });
});

// Tarea 10, ronda de corrección 1: el revisor mutó la línea que pinta
// `cantidadTexto` para pasarla por `Number.parseInt` (convertir "300 aprox"
// en 300) y las 22 pruebas de este archivo siguieron en verde — nada las
// ejercitaba. Estas pruebas cierran ese hueco.
describe('Borradores pendientes (Tarea 10)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function borrador(id: string, cliente: Record<string, unknown>) {
    return { id, created_at: '2026-08-26T10:00:00Z', contact_id: 'c1', cliente };
  }

  it('muestra la cantidad del borrador literal, sin interpretarla como número', async () => {
    // "300 aprox" empieza con dígitos: si alguien "arregla" la pantalla para
    // que se vea más prolija con `Number.parseInt(cantidadTexto, 10)`, JS
    // coacciona el número resultante (300) a string al pintarlo y la palabra
    // "aprox" desaparece en silencio. Esta prueba exige el texto exacto, con
    // comillas angulares y todo, así que ese cambio la pone en rojo.
    mockFetch({
      borradores: [
        borrador('cot-1', {
          nombre: 'Ana Pérez',
          email: 'ana@hotel.com',
          producto: 'uniformes',
          cantidadTexto: '300 aprox',
        }),
      ],
    });
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await entrar(usuario);

    await waitFor(() => {
      expect(screen.getByText('«300 aprox»')).toBeInTheDocument();
    });
    // Ni "300" solo ni "NaN" — cualquiera de las dos es la marca de que
    // alguien pasó el texto por un parseo numérico.
    expect(screen.queryByText('«300»')).not.toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
  });

  it('lista el borrador con lo que trajo, y "Usar" rellena los campos del cliente', async () => {
    mockFetch({
      borradores: [
        borrador('cot-2', {
          nombre: 'Carlos Rojas',
          empresa: 'Hotel Playa Linda',
          email: 'carlos@playalinda.com',
          producto: 'sábanas',
          cantidadTexto: 'unos 300',
        }),
      ],
    });
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await entrar(usuario);

    await waitFor(() => {
      expect(screen.getByText(/carlos rojas/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/hotel playa linda/i)).toBeInTheDocument();
    expect(screen.getByText(/carlos@playalinda\.com/i)).toBeInTheDocument();
    expect(screen.getByText(/sábanas/i)).toBeInTheDocument();
    expect(screen.getByText('«unos 300»')).toBeInTheDocument();

    await usuario.click(screen.getByRole('button', { name: /usar/i }));

    expect(screen.getByLabelText(/nombre del cliente/i)).toHaveValue('Carlos Rojas');
    expect(screen.getByLabelText(/empresa del cliente/i)).toHaveValue('Hotel Playa Linda');
    expect(screen.getByLabelText(/correo del cliente/i)).toHaveValue('carlos@playalinda.com');
    // El recordatorio deja el pedido original visible, para elegir SKUs
    // contra lo que el cliente realmente dijo.
    expect(screen.getByText(/«unos 300» de sábanas/i)).toBeInTheDocument();
  });

  it('sin borradores pendientes, muestra el texto neutro en vez de una sección vacía', async () => {
    mockFetch({ borradores: [] });
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await entrar(usuario);

    await waitFor(() => {
      expect(screen.getByText('No hay borradores pendientes.')).toBeInTheDocument();
    });
  });

  // --- Ronda de correcciones 2 (hallazgo I1) ---

  it('el envío final manda borradorId y contactId cuando la cotización viene de "Usar" un borrador', async () => {
    // Antes esto se tiraba: `usarBorrador` solo rellenaba los campos de
    // cliente, y el envío final no sabía de qué borrador venía. La fila del
    // agente se quedaba en 'borrador' para siempre (y bloqueaba
    // `registrarIntencion` para ese contacto), y GoHighLevel daba de alta un
    // contacto nuevo aunque el borrador ya trajera uno (`contact_id: 'c1'`
    // en el helper `borrador(...)` de arriba).
    const fetchEspiado = mockFetch({
      borradores: [
        borrador('cot-3', {
          nombre: 'Carlos Rojas',
          email: 'carlos@playalinda.com',
          producto: 'sábanas',
          cantidadTexto: 'unos 300',
        }),
      ],
    });
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await entrar(usuario);

    await waitFor(() => {
      expect(screen.getByText(/carlos rojas/i)).toBeInTheDocument();
    });
    await usuario.click(screen.getByRole('button', { name: /usar/i }));
    await agregar(usuario, 'set de 600 hilos king');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /cotizar y enviar/i })).not.toBeDisabled();
    });
    await usuario.click(screen.getByRole('button', { name: /cotizar y enviar/i }));

    await waitFor(() => {
      expect(screen.getByText(/enviada a/i)).toBeInTheDocument();
    });

    const llamada = fetchEspiado.mock.calls.find(([input]) =>
      (typeof input === 'string' ? input : input.toString()).endsWith('/api/cotizacion'),
    );
    expect(llamada).toBeDefined();
    const cuerpo = JSON.parse((llamada![1] as RequestInit).body as string);
    expect(cuerpo.borradorId).toBe('cot-3');
    expect(cuerpo.contactId).toBe('c1');
  });

  it('un envío que no viene de un borrador no manda borradorId ni contactId', async () => {
    // Mata el mutante "mandar siempre borradorId/contactId, hayan venido de
    // un borrador o no": una cotización armada desde cero no debe cerrar
    // ningún borrador ajeno ni reutilizar un contacto que no le corresponde.
    const fetchEspiado = mockFetch();
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await entrar(usuario);
    await agregar(usuario, 'set de 600 hilos king');
    await llenarCliente(usuario, { nombre: 'Ana Pérez', email: 'ana@empresa.com' });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /cotizar y enviar/i })).not.toBeDisabled();
    });
    await usuario.click(screen.getByRole('button', { name: /cotizar y enviar/i }));

    await waitFor(() => {
      expect(screen.getByText(/enviada a/i)).toBeInTheDocument();
    });

    const llamada = fetchEspiado.mock.calls.find(([input]) =>
      (typeof input === 'string' ? input : input.toString()).endsWith('/api/cotizacion'),
    );
    const cuerpo = JSON.parse((llamada![1] as RequestInit).body as string);
    expect('borradorId' in cuerpo).toBe(false);
    expect('contactId' in cuerpo).toBe(false);
  });

  it('tras un envío exitoso, el borrador usado desaparece de la lista local (la cola no sigue mostrando lo ya atendido)', async () => {
    mockFetch({
      borradores: [
        borrador('cot-4', {
          nombre: 'Carlos Rojas',
          email: 'carlos@playalinda.com',
          producto: 'sábanas',
          cantidadTexto: 'unos 300',
        }),
      ],
    });
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await entrar(usuario);

    await waitFor(() => {
      expect(screen.getByText(/carlos rojas/i)).toBeInTheDocument();
    });
    await usuario.click(screen.getByRole('button', { name: /usar/i }));
    await agregar(usuario, 'set de 600 hilos king');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /cotizar y enviar/i })).not.toBeDisabled();
    });
    await usuario.click(screen.getByRole('button', { name: /cotizar y enviar/i }));

    await waitFor(() => {
      expect(screen.getByText(/enviada a/i)).toBeInTheDocument();
    });

    expect(screen.queryByText(/carlos rojas/i)).not.toBeInTheDocument();
    expect(screen.getByText('No hay borradores pendientes.')).toBeInTheDocument();
  });

  // --- Tarea 5: teléfono y dirección del cliente ---

  it('manda teléfono y dirección en el cuerpo del envío cuando se llenan', async () => {
    const fetchEspiado = mockFetch();
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await entrar(usuario);
    await agregar(usuario, 'set de 600 hilos king');
    await llenarCliente(usuario, {
      nombre: 'Ana Pérez',
      email: 'ana@empresa.com',
      telefono: '+506 8888-8888',
      direccion: 'Frente al parque, Liberia',
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /cotizar y enviar/i })).not.toBeDisabled();
    });
    await usuario.click(screen.getByRole('button', { name: /cotizar y enviar/i }));

    await waitFor(() => {
      expect(screen.getByText(/enviada a/i)).toBeInTheDocument();
    });

    const llamada = fetchEspiado.mock.calls.find(([input]) =>
      (typeof input === 'string' ? input : input.toString()).endsWith('/api/cotizacion'),
    );
    const cuerpo = JSON.parse((llamada![1] as RequestInit).body as string);
    expect(cuerpo.cliente.telefono).toBe('+506 8888-8888');
    expect(cuerpo.cliente.direccion).toBe('Frente al parque, Liberia');
  });

  it('la cotización se puede enviar sin teléfono ni dirección (son opcionales)', async () => {
    // Un hotel que cotiza por correo puede no tener todavía una dirección de
    // entrega definida: bloquear el envío por eso sería estorbar.
    const fetchEspiado = mockFetch();
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await entrar(usuario);
    await agregar(usuario, 'set de 600 hilos king');
    await llenarCliente(usuario, { nombre: 'Ana Pérez', email: 'ana@empresa.com' });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /cotizar y enviar/i })).not.toBeDisabled();
    });
    await usuario.click(screen.getByRole('button', { name: /cotizar y enviar/i }));

    await waitFor(() => {
      expect(screen.getByText(/enviada a/i)).toBeInTheDocument();
    });

    const llamada = fetchEspiado.mock.calls.find(([input]) =>
      (typeof input === 'string' ? input : input.toString()).endsWith('/api/cotizacion'),
    );
    const cuerpo = JSON.parse((llamada![1] as RequestInit).body as string);
    // `undefined` desaparece al pasar por `JSON.stringify`: no llegan como
    // strings vacíos, sencillamente no viajan.
    expect('telefono' in cuerpo.cliente).toBe(false);
    expect('direccion' in cuerpo.cliente).toBe(false);
  });
});

// Ronda de correcciones 1 (Tarea 9): la sesión por cookie es la razón de
// ser de este panel dentro del iframe de GoHighLevel — sin ella, cada
// recarga obliga al vendedor a volver a escribir la clave. El revisor probó
// tres mutantes (quitar la cabecera `x-csrf-token` de `crear()`, hacer que
// la sonda nunca entre, y borrar entera la llamada que crea la sesión) y
// las 32 pruebas de arriba seguían en verde: nada las ejercitaba. Estas
// tres pruebas cierran ese hueco, y una cuarta cubre la recuperación de un
// token rancio (hallazgo crítico separado).
describe('Sesión por cookie y token anti-CSRF (Tarea 9, ronda de correcciones 1)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('no entra a la pantalla principal hasta que /entrar termina, para que el primer envío no dependa de una carrera', async () => {
    // Ronda de correcciones 2 (hallazgo importante): el revisor señaló mi
    // propia preocupación del reporte anterior — `crear()` ya no manda la
    // clave en el cuerpo, así que el primer envío depende enteramente de
    // que `establecerSesion` (el POST a /entrar) haya terminado. Si esa
    // llamada se dispara sin esperarla, el primer envío puede ganarle la
    // carrera y volver con un 401 evitable. Esta prueba retiene /entrar a
    // propósito (mismo patrón que "el botón dice la verdad ANTES del
    // clic") y confirma que la pantalla NO pasa a mostrar el catálogo
    // mientras esa llamada sigue en vuelo.
    let liberarEntrar: (() => void) | undefined;
    const bloqueoEntrar = new Promise<void>((resolve) => {
      liberarEntrar = resolve;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const cuerpo = init?.body ? JSON.parse(init.body as string) : {};
      if (url.endsWith('/api/cotizacion/catalogo')) {
        if (cuerpo.clave === 'correcta') {
          return new Response(JSON.stringify({ ok: true, skus: SKUS }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: false, error: 'Clave incorrecta.' }), { status: 401 });
      }
      if (url.endsWith('/api/cotizacion/entrar')) {
        await bloqueoEntrar;
        return new Response(JSON.stringify({ ok: true, csrf: CSRF_TOKEN_DE_PRUEBA }), { status: 200 });
      }
      throw new Error(`Fetch no simulado en la prueba: ${url}`);
    });

    const usuario = userEvent.setup();
    render(<Cotizador />);
    await usuario.type(screen.getByLabelText(/^clave$/i), 'correcta');
    await usuario.click(screen.getByRole('button', { name: /^entrar$/i }));

    // /entrar sigue retenido: todavía "Entrando…", sin buscador. Si
    // `establecerSesion` se disparara sin esperarla, esto ya habría
    // pasado a la pantalla principal en este punto.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /entrando/i })).toBeInTheDocument();
    });
    expect(screen.queryByLabelText(/buscar/i)).not.toBeInTheDocument();

    liberarEntrar?.();

    await waitFor(() => {
      expect(screen.getByLabelText(/buscar/i)).toBeInTheDocument();
    });
    // Y, para cuando entra, el token ya está guardado — el primer envío no
    // tiene que competir contra nada.
    expect(sessionStorage.getItem(CSRF_STORAGE_KEY)).toBe(CSRF_TOKEN_DE_PRUEBA);
  });

  it('al validar la clave, llama a /api/cotizacion/entrar y guarda el token anti-CSRF que devuelve', async () => {
    // Mata el mutante "borrar la llamada que crea la sesión": sin ella, no
    // hay ningún POST a /entrar y `sessionStorage` se queda vacío para
    // siempre.
    const fetchEspiado = mockFetch();
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await entrar(usuario);

    await waitFor(() => {
      expect(sessionStorage.getItem(CSRF_STORAGE_KEY)).toBe(CSRF_TOKEN_DE_PRUEBA);
    });

    const llamada = fetchEspiado.mock.calls.find(([input]) =>
      (typeof input === 'string' ? input : input.toString()).endsWith('/api/cotizacion/entrar'),
    );
    expect(llamada).toBeDefined();
    const cuerpo = JSON.parse((llamada![1] as RequestInit).body as string);
    expect(cuerpo).toEqual({ clave: 'correcta' });
  });

  it('si la sesión ya está viva al montar (cookie), entra directo sin pedir la clave, y no manda clave vacía en las lecturas', async () => {
    // Mata el mutante "la sonda nunca entra": con `sesionActiva`,
    // `/api/cotizacion/catalogo` responde bien a la sonda (sin `clave` en
    // el cuerpo) porque hay una cookie válida — la pantalla de clave no
    // debería aparecer en ningún momento.
    const fetchEspiado = mockFetch({ sesionActiva: true });
    render(<Cotizador />);

    await waitFor(() => {
      expect(screen.getByLabelText(/buscar/i)).toBeInTheDocument();
    });
    expect(screen.queryByLabelText(/^clave$/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^entrar$/i })).not.toBeInTheDocument();

    // Ronda de correcciones 1 (hallazgo menor): sin una clave conocida
    // (se entró por cookie, nunca se escribió una), la cola de borradores
    // —que se pide sola al montar `VistaCrear`— no debe mandar `clave: ''`
    // de peso muerto en el cuerpo.
    await waitFor(() => {
      const llamada = fetchEspiado.mock.calls.find(([input]) =>
        (typeof input === 'string' ? input : input.toString()).endsWith('/api/cotizacion/borradores'),
      );
      expect(llamada).toBeDefined();
    });
    const llamadaBorradores = fetchEspiado.mock.calls.find(([input]) =>
      (typeof input === 'string' ? input : input.toString()).endsWith('/api/cotizacion/borradores'),
    );
    const cuerpoBorradores = JSON.parse((llamadaBorradores![1] as RequestInit).body as string);
    expect('clave' in cuerpoBorradores).toBe(false);
  });

  it('si el envío final vuelve con 401 (token anti-CSRF rancio), avisa por qué y NO pierde la cotización a medio armar', async () => {
    // Ronda de correcciones 2 (hallazgo importante): la primera versión de
    // esta prueba (ronda 1) afirmaba `expect(screen.queryByLabelText(/buscar/i)).not.toBeInTheDocument()`
    // — es decir, congelaba el bug que el revisor encontró: `onSesionInvalida`
    // desmontaba `VistaCrear` entera (ponía `dentro = false`), así que el
    // vendedor perdía el cliente y las líneas ya armadas, sin ninguna
    // explicación, en un formulario de clave en blanco. Ahora `VistaCrear`
    // sigue montada (con su estado intacto) detrás de la pantalla de clave,
    // que además explica qué pasó.
    const fetchEspiado = mockFetch({ crear401: true });
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await entrar(usuario);
    await agregar(usuario, 'set de 600 hilos king');
    await llenarCliente(usuario, { nombre: 'Ana Pérez', email: 'ana@empresa.com' });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /cotizar y enviar/i })).not.toBeDisabled();
    });
    await usuario.click(screen.getByRole('button', { name: /cotizar y enviar/i }));

    // Vuelve a pedir la clave — pero con una explicación, no un formulario
    // en blanco sin contexto.
    await waitFor(() => {
      expect(screen.getByLabelText(/^clave$/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/tu sesión venció/i)).toBeInTheDocument();

    // Lo armado sigue ahí, debajo de la pantalla de clave — no se perdió.
    // (`getByLabelText(/cantidad/i)` es unívoco: solo la línea agregada lo
    // tiene, a diferencia de "set de 600 hilos king" en texto, que también
    // aparece en el resultado del buscador porque `busqueda` no se limpia
    // sola.)
    expect(screen.getByLabelText(/nombre del cliente/i)).toHaveValue('Ana Pérez');
    expect(screen.getByLabelText(/correo del cliente/i)).toHaveValue('ana@empresa.com');
    expect(screen.getByLabelText(/cantidad/i)).toHaveValue(1);

    // El token inservible no se deja atrás: si sobreviviera, una sonda
    // futura (u otra pestaña) podría volver a intentarlo con el mismo token
    // rancio.
    expect(sessionStorage.getItem(CSRF_STORAGE_KEY)).toBeNull();

    // Se ejerció el camino de escritura, y falló como se esperaba.
    const llamadasAlEnvio = fetchEspiado.mock.calls.filter(([input]) =>
      (typeof input === 'string' ? input : input.toString()).endsWith('/api/cotizacion'),
    );
    expect(llamadasAlEnvio).toHaveLength(1);

    // Al reautenticarse, sigue exactamente donde estaba: no hay que
    // rearmar nada de cero.
    await usuario.type(screen.getByLabelText(/^clave$/i), 'correcta');
    await usuario.click(screen.getByRole('button', { name: /^entrar$/i }));

    await waitFor(() => {
      expect(screen.queryByLabelText(/^clave$/i)).not.toBeInTheDocument();
    });
    expect(screen.getByLabelText(/nombre del cliente/i)).toHaveValue('Ana Pérez');
    expect(screen.getByLabelText(/cantidad/i)).toHaveValue(1);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /cotizar y enviar/i })).not.toBeDisabled();
    });
  });
});

describe('Pestañas del panel (Tarea 10, ronda de correcciones 1)', () => {
  // Hallazgo importante del revisor: `VistaCrear` se desmontaba al salir de
  // la pestaña "Crear" (era condicional a `pestana === 'crear'`, igual que
  // las otras dos), y no persistía el cliente ni las líneas en ningún
  // lado. Con "Duplicar" (Tarea 10) el salto entre pestañas pasa a ser
  // parte de la rutina diaria —duplicar allá, editar acá, volver a mirar
  // algo allá—, así que perder el trabajo en cada ida y vuelta ya no es un
  // caso raro. Es el mismo problema que la Tarea 9 resolvió para la sesión
  // vencida (no perderle el trabajo al vendedor); esta prueba pide que se
  // sostenga también acá.
  it('cambiar a "Cotizaciones" y volver a "Crear" no pierde el cliente ni las líneas', async () => {
    mockFetch();
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await entrar(usuario);

    await llenarCliente(usuario, { nombre: 'Ana Pérez', email: 'ana@empresa.com' });
    await agregar(usuario, 'set de 600 hilos king');
    await waitFor(() => {
      expect(screen.getByLabelText(/cantidad/i)).toHaveValue(1);
    });

    await usuario.click(screen.getByRole('button', { name: /^cotizaciones$/i }));
    await waitFor(() => {
      expect(screen.getByLabelText(/filtrar por estado/i)).toBeInTheDocument();
    });
    // La pantalla de "Crear" ya no está en el árbol visible mientras se
    // mira "Cotizaciones" — el punto es que no se haya DESMONTADO (y por
    // lo tanto no perdió el estado), no que siga a la vista.
    expect(screen.queryByLabelText(/nombre del cliente/i)).not.toBeVisible();

    await usuario.click(screen.getByRole('button', { name: /^crear$/i }));
    await waitFor(() => {
      expect(screen.getByLabelText(/nombre del cliente/i)).toBeVisible();
    });
    expect(screen.getByLabelText(/nombre del cliente/i)).toHaveValue('Ana Pérez');
    expect(screen.getByLabelText(/correo del cliente/i)).toHaveValue('ana@empresa.com');
    expect(screen.getByLabelText(/cantidad/i)).toHaveValue(1);
  });
});
