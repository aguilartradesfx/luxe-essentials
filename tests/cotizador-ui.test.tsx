import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Cotizador from '@/app/cotizador/Cotizador';

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
};

function mockFetch(opciones: OpcionesFetch = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const cuerpo = init?.body ? JSON.parse(init.body as string) : {};

    if (url.endsWith('/api/cotizacion/catalogo')) {
      if (cuerpo.clave !== 'correcta') {
        return new Response(JSON.stringify({ ok: false, error: 'Clave incorrecta.' }), { status: 401 });
      }
      return new Response(JSON.stringify({ ok: true, skus: SKUS }), { status: 200 });
    }

    if (url.endsWith('/api/cotizacion/borradores')) {
      // Tarea 10: se llama justo al entrar. Vacío salvo que la prueba pida
      // otra cosa vía `opciones.borradores`.
      return new Response(JSON.stringify({ ok: true, borradores: opciones.borradores ?? [] }), { status: 200 });
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
      return new Response(
        JSON.stringify({ ok: true, id: 'cot-1', cotizacion: cotizacionSimulada(cuerpo.lineas ?? [], cuerpo.tasaIva ?? 0.13, cuerpo.bordadoEspecial ?? false), ghl: { estimateId: 'est-1' } }),
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

async function llenarCliente(usuario: ReturnType<typeof userEvent.setup>, { nombre, email }: { nombre?: string; email?: string }) {
  if (nombre !== undefined) await usuario.type(screen.getByLabelText(/nombre del cliente/i), nombre);
  if (email !== undefined) await usuario.type(screen.getByLabelText(/correo del cliente/i), email);
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
    expect(screen.getByRole('button', { name: /enviar cotización/i })).toBeDisabled();
  });

  it('no deja enviar sin el nombre del cliente, aunque haya correo (el servidor también lo exige)', async () => {
    mockFetch();
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await entrar(usuario);
    await agregar(usuario, 'set de 600 hilos king');
    await llenarCliente(usuario, { email: 'cliente@empresa.com' });
    expect(screen.getByRole('button', { name: /enviar cotización/i })).toBeDisabled();
    await llenarCliente(usuario, { nombre: 'Ana Pérez' });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /enviar cotización/i })).not.toBeDisabled();
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
    expect(screen.getByRole('button', { name: /enviar cotización/i })).toBeDisabled();
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
    const boton = screen.getByRole('button', { name: /enviar cotización/i });
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

  it('el cuerpo del envío final lleva la clave real y las líneas tal cual están en pantalla, sin un total inventado', async () => {
    // Mata el mutante "mandar total: 1 y quitar la clave": si el envío deja
    // de mandar la clave, o agrega un campo `total` que el servidor no debe
    // recibir (lo calcula él con el catálogo real), esta prueba lo detecta.
    const fetchEspiado = mockFetch();
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await entrar(usuario);
    await agregar(usuario, 'set de 600 hilos king');
    await llenarCliente(usuario, { nombre: 'Ana Pérez', email: 'ana@empresa.com' });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /enviar cotización/i })).not.toBeDisabled();
    });
    await usuario.click(screen.getByRole('button', { name: /enviar cotización/i }));

    await waitFor(() => {
      expect(screen.getByText(/cotización guardada/i)).toBeInTheDocument();
    });

    const llamada = fetchEspiado.mock.calls.find(([input]) =>
      (typeof input === 'string' ? input : input.toString()).endsWith('/api/cotizacion'),
    );
    expect(llamada).toBeDefined();
    const init = llamada![1] as RequestInit;
    const cuerpo = JSON.parse(init.body as string);

    expect(cuerpo).toEqual({
      clave: 'correcta',
      cliente: { nombre: 'Ana Pérez', email: 'ana@empresa.com' },
      lineas: [{ skuId: 'set-600-king', cantidad: 1 }],
      tasaIva: 0.13,
      bordadoEspecial: false,
    });
    expect('total' in cuerpo).toBe(false);
  });

  it('el mensaje de éxito dice la verdad: creada en GoHighLevel, falta enviarla al cliente', async () => {
    // Ronda de correcciones 2 (hallazgo C1): antes decía "enviada en
    // GoHighLevel", y crearEstimate (lib/cotizador/ghl.ts) nunca envía nada
    // — solo crea el Estimate ahí en borrador. El vendedor tiene que abrirlo
    // en GoHighLevel y mandarlo a mano; la pantalla se lo tiene que decir.
    mockFetch();
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await entrar(usuario);
    await agregar(usuario, 'set de 600 hilos king');
    await llenarCliente(usuario, { nombre: 'Ana Pérez', email: 'ana@empresa.com' });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /enviar cotización/i })).not.toBeDisabled();
    });
    await usuario.click(screen.getByRole('button', { name: /enviar cotización/i }));

    await waitFor(() => {
      expect(screen.getByText(/falta enviarla al cliente/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/enviada en gohighlevel/i)).not.toBeInTheDocument();
  });

  it('no permite un segundo envío tras uno exitoso (protección contra doble clic)', async () => {
    const fetchEspiado = mockFetch();
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await entrar(usuario);
    await agregar(usuario, 'set de 600 hilos king');
    await llenarCliente(usuario, { nombre: 'Ana Pérez', email: 'ana@empresa.com' });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /enviar cotización/i })).not.toBeDisabled();
    });
    const boton = screen.getByRole('button', { name: /enviar cotización/i });
    await usuario.click(boton);

    await waitFor(() => {
      expect(screen.getByText(/cotización guardada/i)).toBeInTheDocument();
    });

    // Ronda de correcciones 2 (hallazgo C1): el botón decía "Cotización
    // enviada", pero crearEstimate nunca envía nada — solo la crea en
    // borrador dentro de GoHighLevel. "Cotización creada" es lo cierto.
    const botonTrasEnvio = screen.getByRole('button', { name: /cotización creada/i });
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
      expect(screen.getByRole('button', { name: /enviar cotización/i })).not.toBeDisabled();
    });
    await usuario.click(screen.getByRole('button', { name: /enviar cotización/i }));

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
      expect(screen.getByRole('button', { name: /enviar cotización/i })).not.toBeDisabled();
    });
    await usuario.click(screen.getByRole('button', { name: /enviar cotización/i }));

    await waitFor(() => {
      expect(screen.getByText(/cotización guardada/i)).toBeInTheDocument();
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
      expect(screen.getByRole('button', { name: /enviar cotización/i })).not.toBeDisabled();
    });
    await usuario.click(screen.getByRole('button', { name: /enviar cotización/i }));

    await waitFor(() => {
      expect(screen.getByText(/cotización guardada/i)).toBeInTheDocument();
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
      expect(screen.getByRole('button', { name: /enviar cotización/i })).not.toBeDisabled();
    });
    await usuario.click(screen.getByRole('button', { name: /enviar cotización/i }));

    await waitFor(() => {
      expect(screen.getByText(/cotización guardada/i)).toBeInTheDocument();
    });

    expect(screen.queryByText(/carlos rojas/i)).not.toBeInTheDocument();
    expect(screen.getByText('No hay borradores pendientes.')).toBeInTheDocument();
  });
});
