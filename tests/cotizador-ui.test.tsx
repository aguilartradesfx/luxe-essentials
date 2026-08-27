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

const SKUS = [
  { id: 'set-600-hilos-king', nombre: 'set de 600 hilos king', familia: 'Sets de cama' },
  { id: 'uni-filipina-tradicional-manga-corta', nombre: 'filipina tradicional manga corta', familia: 'Uniformes' },
  { id: 'inserto-duvet-king', nombre: 'inserto de duvet king', familia: 'Edredones' },
];

// Réplica mínima de lo que hace `calcular()` en el servidor para las dos
// líneas que estas pruebas necesitan: sets de cama (escalón de 16 → 10%) y
// todo lo demás sin descuento. No es el motor real —vive en el servidor y
// esta prueba no debe reimportarlo, sería volver a arrastrar el catálogo—,
// solo lo justo para que la pantalla tenga algo coherente que pintar.
function cotizacionSimulada(lineas: { skuId: string; cantidad: number }[], tasaIva: number, bordadoEspecial: boolean) {
  const totalSetsDeCama = lineas
    .filter((l) => l.skuId === 'set-600-hilos-king')
    .reduce((acc, l) => acc + l.cantidad, 0);
  const pct = totalSetsDeCama >= 16 ? 10 : totalSetsDeCama >= 10 ? 5 : 0;

  const calculadas = lineas.map((l) => {
    const esSet = l.skuId === 'set-600-hilos-king';
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

function mockFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const cuerpo = init?.body ? JSON.parse(init.body as string) : {};

    if (url.endsWith('/api/cotizacion/catalogo')) {
      if (cuerpo.clave !== 'correcta') {
        return new Response(JSON.stringify({ ok: false, error: 'Clave incorrecta.' }), { status: 401 });
      }
      return new Response(JSON.stringify({ ok: true, skus: SKUS }), { status: 200 });
    }

    if (url.endsWith('/api/cotizacion/previsualizar')) {
      const cotizacion = cotizacionSimulada(cuerpo.lineas ?? [], cuerpo.tasaIva ?? 0.13, cuerpo.bordadoEspecial ?? false);
      return new Response(JSON.stringify({ ok: true, cotizacion }), { status: 200 });
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
    await usuario.type(screen.getByLabelText(/buscar/i), 'set de 600 hilos king');
    await usuario.click(screen.getByRole('button', { name: /agregar/i }));
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
    await usuario.type(screen.getByLabelText(/buscar/i), 'set de 600 hilos king');
    await usuario.click(screen.getByRole('button', { name: /agregar/i }));
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
    await usuario.type(screen.getByLabelText(/buscar/i), 'set de 600 hilos king');
    await usuario.click(screen.getByRole('button', { name: /agregar/i }));
    expect(screen.getByRole('button', { name: /enviar cotización/i })).toBeDisabled();
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
});
