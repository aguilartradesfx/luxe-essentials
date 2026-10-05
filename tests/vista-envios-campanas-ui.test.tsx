import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Cotizador from '@/app/cotizador/Panel';
import { VistaEnviosCampanas } from '@/app/cotizador/VistaEnviosCampanas';
import { listarEnvios } from '@/lib/campanas/envios-listado';
import { ESTADOS_ENTREGA, ETIQUETAS_ENTREGA } from '@/lib/campanas/estado-entrega';
import { crearDb, envio, uuid, type Datos, type Envio } from './helpers/db-envios';

// La pestaña «Correos enviados». El `fetch` simulado NO devuelve lo que la
// prueba quiere: ejecuta el listado REAL (`listarEnvios`) sobre un doble de
// la base con los filtros que la pantalla mandó. Así «filtré por rebotados»
// sólo da resultado si la pantalla de verdad se lo pidió al servidor.

const CSRF = 'csrf';
const C_NORTE = uuid(9001);
const C_NORTE_2 = uuid(9002);
const C_CARIBE = uuid(9003);

function datosBase(): Datos {
  return {
    campanas: [
      { id: C_NORTE, zona: 'Zona Norte', plantilla: 'inicial', creado_at: '2026-09-01T10:00:00+00:00' },
      { id: C_NORTE_2, zona: 'Zona Norte', plantilla: 'seguimiento_1', creado_at: '2026-09-10T10:00:00+00:00' },
      { id: C_CARIBE, zona: 'Caribe', plantilla: 'inicial', creado_at: '2026-09-05T10:00:00+00:00' },
    ],
    envios: [],
  };
}

type Peticion = Record<string, unknown>;

function simularServidor(datos: Datos, tamano = 50) {
  const peticiones: Peticion[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/api/campanas/envios')) {
      const cuerpo = JSON.parse(String(init?.body ?? '{}'));
      peticiones.push(cuerpo);
      const pagina = await listarEnvios(
        crearDb(datos),
        { zona: cuerpo.zona, campanaId: cuerpo.campanaId, estado: cuerpo.estado, busqueda: cuerpo.busqueda },
        cuerpo.despues ?? null,
        tamano,
      );
      return new Response(JSON.stringify({ ok: true, ...pagina }), { status: 200 });
    }
    throw new Error(`Fetch no simulado en la prueba: ${url}`);
  });
  return { peticiones, spy };
}

const filas = () => within(screen.getByRole('table')).getAllByRole('row').slice(1);
const correosVisibles = () => filas().map((f) => within(f).getAllByRole('paragraph')[0].textContent);

afterEach(() => vi.restoreAllMocks());

describe('Panel -- pestaña «Correos enviados»', () => {
  function mockPanel(rol: 'vendedor' | 'superadmin') {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/cotizacion/catalogo'))
        return new Response(JSON.stringify({ ok: true, skus: [], csrf: CSRF, vendedor: 'Ana Solano', rol }), { status: 200 });
      if (url.endsWith('/api/cotizacion/borradores')) return new Response(JSON.stringify({ ok: true, borradores: [] }), { status: 200 });
      throw new Error(`Fetch no simulado: ${url}`);
    });
  }
  it('no se ofrece a un vendedor', async () => {
    mockPanel('vendedor');
    render(<Cotizador />);
    await waitFor(() => expect(screen.getByText(/sesión de ana solano/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /correos enviados/i })).not.toBeInTheDocument();
  });
  it('se ofrece a un superadmin, aparte del historial de campañas', async () => {
    mockPanel('superadmin');
    render(<Cotizador />);
    expect(await screen.findByRole('button', { name: /correos enviados/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /historial de campañas/i })).toBeInTheDocument();
  });
});

describe('VistaEnviosCampanas', () => {
  it('muestra a quién, de qué zona y campaña, cuándo y en qué quedó', async () => {
    const d = datosBase();
    d.envios.push(
      envio({ campana_id: C_NORTE, correo: 'ventas@hotelarenal.cr', nombre_crm: 'Hotel Arenal SA', entrega_estado: 'entregado' }),
    );
    simularServidor(d);
    render(<VistaEnviosCampanas onSesionInvalida={() => {}} />);
    const fila = (await screen.findAllByRole('row'))[1];
    expect(within(fila).getByText('ventas@hotelarenal.cr')).toBeInTheDocument();
    expect(within(fila).getByText('Hotel Arenal SA')).toBeInTheDocument();
    expect(within(fila).getByText('Zona Norte')).toBeInTheDocument();
    expect(within(fila).getByText('Correo inicial')).toBeInTheDocument();
    expect(within(fila).getByText(/\d{2}\/\d{2}\/2026 \d{2}:\d{2}/)).toBeInTheDocument();
    expect(within(fila).getByText('Entregado')).toBeInTheDocument();
  });

  it('cada estado se ve distinto: ninguna pastilla comparte color con otra', async () => {
    const d = datosBase();
    d.envios.push(
      envio({ campana_id: C_NORTE, correo: 'sc@x.cr' }),
      envio({ campana_id: C_NORTE, correo: 're@x.cr', entrega_estado: 'retrasado' }),
      envio({ campana_id: C_NORTE, correo: 'en@x.cr', entrega_estado: 'entregado' }),
      envio({ campana_id: C_NORTE, correo: 'rb@x.cr', entrega_estado: 'rebotado', entrega_detalle: 'hard/general: buzón inexistente' }),
      envio({ campana_id: C_NORTE, correo: 'fa@x.cr', entrega_estado: 'fallido' }),
      envio({ campana_id: C_NORTE, correo: 'qu@x.cr', entrega_estado: 'queja' }),
      envio({ campana_id: C_NORTE, correo: 'ns@x.cr', estado: 'error', error: 'dirección inválida' }),
    );
    simularServidor(d);
    render(<VistaEnviosCampanas onSesionInvalida={() => {}} />);
    await screen.findByText('sc@x.cr');
    const clasePorEtiqueta = new Map<string, string>();
    for (const e of ESTADOS_ENTREGA) {
      const pastilla = within(screen.getByRole('table')).getByText(ETIQUETAS_ENTREGA[e]);
      clasePorEtiqueta.set(e, pastilla.className);
    }
    expect(new Set(clasePorEtiqueta.values()).size).toBe(ESTADOS_ENTREGA.length);
    // El motivo del rebote y del no-salió se ve sin abrir nada.
    expect(screen.getByText('hard/general: buzón inexistente')).toBeInTheDocument();
    expect(screen.getByText('dirección inválida')).toBeInTheDocument();
  });

  it('«sin confirmar» no se pinta como un fallo: es el único gris, los fallos son rojizos', async () => {
    const d = datosBase();
    d.envios.push(envio({ campana_id: C_NORTE }), envio({ campana_id: C_NORTE, entrega_estado: 'fallido' }));
    simularServidor(d);
    render(<VistaEnviosCampanas onSesionInvalida={() => {}} />);
    await screen.findAllByRole('row');
    const sin = within(screen.getByRole('table')).getByText('Sin confirmar');
    const fallido = within(screen.getByRole('table')).getByText('Fallido');
    expect(sin.className).not.toMatch(/red|rose/);
    expect(fallido.className).toMatch(/rose|red/);
  });

  it('la queja se rotula «Lo marcó como spam», y en ninguna parte dice que un correo cayó en spam', async () => {
    const d = datosBase();
    d.envios.push(envio({ campana_id: C_NORTE, entrega_estado: 'queja' }), envio({ campana_id: C_NORTE, entrega_estado: 'entregado' }));
    simularServidor(d);
    const { container } = render(<VistaEnviosCampanas onSesionInvalida={() => {}} />);
    // Acotado a la TABLA: la misma etiqueta vive tambien en el <option> del
    // filtro, y `findByText` a secas encuentra las dos.
    await screen.findAllByRole('row');
    expect(within(screen.getByRole('table')).getByText('Lo marcó como spam')).toBeInTheDocument();
    const texto = container.textContent ?? '';
        expect(texto).toMatch(/no informa si un correo cay[oó] en la carpeta de spam/i);
    expect(texto).toMatch(/recibi[oó] en su bandeja/i);
    // El filtro de estado tampoco ofrece «spam» a secas.
    const opciones = within(screen.getByRole('combobox', { name: 'Estado' })).getAllByRole('option').map((o) => o.textContent);
    expect(opciones).toContain('Lo marcó como spam');
    expect(opciones).not.toContain('Spam');
  });

  // Reporte del dueno (2026-10-04). Antes, sin ninguna confirmacion, la
  // pantalla mostraba un aviso ambar nombrando el «webhook» MAS una columna
  // entera repitiendo «Sin confirmar». Las dos cosas estaban mal: la primera
  // nombra una pieza interna a quien no tiene por que conocerla, y la
  // segunda convierte la ausencia de un dato en lo que se lee como «mandamos
  // 948 correos y no sabemos que paso con ellos». Mientras no haya NI UNA
  // confirmacion, la pantalla no habla de entregas en absoluto.
  it('sin ninguna confirmacion: ni columna de estado, ni filtro, ni aviso, ni jerga', async () => {
    const d = datosBase();
    d.envios.push(envio({ campana_id: C_NORTE }), envio({ campana_id: C_NORTE }));
    simularServidor(d);
    render(<VistaEnviosCampanas onSesionInvalida={() => {}} />);
    await screen.findAllByRole('row');

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Estado' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Estado' })).not.toBeInTheDocument();
    expect(screen.queryByText('Sin confirmar')).not.toBeInTheDocument();
    expect(screen.queryByText(/qué significa cada estado/i)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/resend|webhook/i);

    // Y lo que SI se sabe se sigue contando completo.
    expect(screen.getByRole('columnheader', { name: 'Destinatario' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Enviado' })).toBeInTheDocument();
  });

  // La otra mitad: en cuanto entra la primera confirmacion, las tres cosas
  // vuelven solas. Sin esta prueba, esconderlas SIEMPRE pasaria.
  it('con al menos una confirmacion: vuelven la columna, el filtro y la ayuda', async () => {
    const d = datosBase();
    d.envios.push(envio({ campana_id: C_NORTE }), envio({ campana_id: C_NORTE, entrega_estado: 'entregado' }));
    simularServidor(d);
    render(<VistaEnviosCampanas onSesionInvalida={() => {}} />);
    await screen.findAllByRole('row');

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Estado' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Estado' })).toBeInTheDocument();
    expect(screen.getByText(/qué significa cada estado/i)).toBeInTheDocument();
    expect(within(screen.getByRole('table')).getByText('Entregado')).toBeInTheDocument();
  });

  describe('filtros (los resuelve el servidor)', () => {
    function datosVarios() {
      const d = datosBase();
      d.envios.push(
        envio({ campana_id: C_NORTE, correo: 'norte-ok@x.cr', entrega_estado: 'entregado', nombre_crm: 'Hotel Arenal' }),
        envio({ campana_id: C_NORTE, correo: 'norte-reb@x.cr', entrega_estado: 'rebotado', nombre_crm: 'Hotel Fortuna' }),
        envio({ campana_id: C_NORTE_2, correo: 'norte2-reb@x.cr', entrega_estado: 'rebotado', nombre_crm: 'Cafe Sol' }),
        envio({ campana_id: C_CARIBE, correo: 'caribe-reb@x.cr', entrega_estado: 'rebotado', nombre_crm: 'Hotel Limon' }),
        envio({ campana_id: C_CARIBE, correo: 'caribe-ok@x.cr', entrega_estado: 'entregado', nombre_crm: 'Soda Mar' }),
      );
      return d;
    }

    it('por estado: pide el estado al servidor y sólo quedan los de ese estado', async () => {
      const { peticiones } = simularServidor(datosVarios());
      const user = userEvent.setup();
      render(<VistaEnviosCampanas onSesionInvalida={() => {}} />);
      await screen.findByText('norte-ok@x.cr');
      expect(correosVisibles()).toHaveLength(5);

      await user.selectOptions(screen.getByRole('combobox', { name: 'Estado' }), 'rebotado');
      await waitFor(() => expect(correosVisibles()).toHaveLength(3));
      expect(peticiones[peticiones.length - 1]).toMatchObject({ estado: 'rebotado' });
      expect(correosVisibles().sort()).toEqual(['caribe-reb@x.cr', 'norte-reb@x.cr', 'norte2-reb@x.cr']);
      expect(screen.queryByText('norte-ok@x.cr')).not.toBeInTheDocument();
      expect(screen.queryByText('caribe-ok@x.cr')).not.toBeInTheDocument();
    });

    it('por zona: sólo esa zona, y la lista de campañas se acota a la zona', async () => {
      const { peticiones } = simularServidor(datosVarios());
      const user = userEvent.setup();
      render(<VistaEnviosCampanas onSesionInvalida={() => {}} />);
      await screen.findByText('norte-ok@x.cr');
      expect(within(screen.getByRole('combobox', { name: 'Campaña' })).getAllByRole('option')).toHaveLength(4);

      await user.selectOptions(screen.getByRole('combobox', { name: 'Zona' }), 'Caribe');
      await waitFor(() => expect(correosVisibles()).toHaveLength(2));
      expect(peticiones[peticiones.length - 1]).toMatchObject({ zona: 'Caribe' });
      expect(correosVisibles().sort()).toEqual(['caribe-ok@x.cr', 'caribe-reb@x.cr']);
      expect(within(screen.getByRole('combobox', { name: 'Campaña' })).getAllByRole('option')).toHaveLength(2);
    });

    it('por campaña: sólo esa campaña, aunque otra sea de la misma zona', async () => {
      const { peticiones } = simularServidor(datosVarios());
      const user = userEvent.setup();
      render(<VistaEnviosCampanas onSesionInvalida={() => {}} />);
      await screen.findByText('norte-ok@x.cr');
      await user.selectOptions(screen.getByRole('combobox', { name: 'Campaña' }), C_NORTE_2);
      await waitFor(() => expect(correosVisibles()).toEqual(['norte2-reb@x.cr']));
      expect(peticiones[peticiones.length - 1]).toMatchObject({ campanaId: C_NORTE_2 });
    });

    it('cambiar la zona suelta una campaña elegida de otra zona', async () => {
      const { peticiones } = simularServidor(datosVarios());
      const user = userEvent.setup();
      render(<VistaEnviosCampanas onSesionInvalida={() => {}} />);
      await screen.findByText('norte-ok@x.cr');
      await user.selectOptions(screen.getByRole('combobox', { name: 'Campaña' }), C_NORTE_2);
      await waitFor(() => expect(correosVisibles()).toHaveLength(1));
      await user.selectOptions(screen.getByRole('combobox', { name: 'Zona' }), 'Caribe');
      await waitFor(() => expect(correosVisibles()).toHaveLength(2));
      expect(peticiones[peticiones.length - 1].campanaId).toBeUndefined();
    });

    it('la búsqueda por correo o empresa va al servidor y filtra', async () => {
      const { peticiones } = simularServidor(datosVarios());
      const user = userEvent.setup();
      render(<VistaEnviosCampanas onSesionInvalida={() => {}} />);
      await screen.findByText('norte-ok@x.cr');
      await user.type(screen.getByRole('searchbox', { name: /buscar/i }), 'hotel');
      await waitFor(() => expect(correosVisibles().sort()).toEqual(['caribe-reb@x.cr', 'norte-ok@x.cr', 'norte-reb@x.cr']));
      expect(peticiones[peticiones.length - 1]).toMatchObject({ busqueda: 'hotel' });
      // No manda una petición por cada tecla.
      expect(peticiones.filter((p) => p.busqueda !== undefined)).toHaveLength(1);
      expect(screen.queryByText('caribe-ok@x.cr')).not.toBeInTheDocument();
    });

    it('combinados: zona + estado + búsqueda a la vez', async () => {
      const { peticiones } = simularServidor(datosVarios());
      const user = userEvent.setup();
      render(<VistaEnviosCampanas onSesionInvalida={() => {}} />);
      await screen.findByText('norte-ok@x.cr');
      await user.selectOptions(screen.getByRole('combobox', { name: 'Zona' }), 'Zona Norte');
      await user.selectOptions(screen.getByRole('combobox', { name: 'Estado' }), 'rebotado');
      await user.type(screen.getByRole('searchbox', { name: /buscar/i }), 'hotel');
      await waitFor(() => expect(correosVisibles()).toEqual(['norte-reb@x.cr']));
      expect(peticiones[peticiones.length - 1]).toMatchObject({ zona: 'Zona Norte', estado: 'rebotado', busqueda: 'hotel' });
    });

    it('sin resultados lo dice, y «Limpiar» devuelve todo', async () => {
      simularServidor(datosVarios());
      const user = userEvent.setup();
      render(<VistaEnviosCampanas onSesionInvalida={() => {}} />);
      await screen.findByText('norte-ok@x.cr');
      await user.type(screen.getByRole('searchbox', { name: /buscar/i }), 'nadie-se-llama-asi');
      expect(await screen.findByText(/ningún correo coincide/i)).toBeInTheDocument();
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Limpiar' }));
      await waitFor(() => expect(correosVisibles()).toHaveLength(5));
      expect(screen.getByRole('searchbox', { name: /buscar/i })).toHaveValue('');
    });
  });

  describe('paginado (lo resuelve el servidor)', () => {
    function siete() {
      const d = datosBase();
      for (let i = 1; i <= 7; i++) {
        d.envios.push(
          envio({
            campana_id: C_NORTE,
            correo: `n${i}@x.cr`,
            actualizado_at: `2026-09-20T15:00:0${i}.000000+00:00`,
            entrega_estado: i % 2 === 0 ? 'rebotado' : null,
          }),
        );
      }
      return d;
    }

    it('trae una página a la vez, avanza con el cursor del servidor y retrocede, sin repetir ni perder', async () => {
      const { peticiones } = simularServidor(siete(), 3);
      const user = userEvent.setup();
      render(<VistaEnviosCampanas onSesionInvalida={() => {}} />);
      await screen.findByText('n7@x.cr');
      expect(correosVisibles()).toEqual(['n7@x.cr', 'n6@x.cr', 'n5@x.cr']);
      expect(screen.getByText('1–3 de 7')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Anterior' })).toBeDisabled();

      await user.click(screen.getByRole('button', { name: 'Siguiente' }));
      await screen.findByText('n4@x.cr');
      expect(correosVisibles()).toEqual(['n4@x.cr', 'n3@x.cr', 'n2@x.cr']);
      expect(screen.getByText('4–6 de 7')).toBeInTheDocument();
      expect(peticiones[peticiones.length - 1].despues).toMatchObject({ id: expect.any(String), at: expect.any(String) });

      await user.click(screen.getByRole('button', { name: 'Siguiente' }));
      await screen.findByText('n1@x.cr');
      expect(correosVisibles()).toEqual(['n1@x.cr']);
      expect(screen.getByText('7–7 de 7')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Siguiente' })).toBeDisabled();

      await user.click(screen.getByRole('button', { name: 'Anterior' }));
      await screen.findByText('n4@x.cr');
      expect(correosVisibles()).toEqual(['n4@x.cr', 'n3@x.cr', 'n2@x.cr']);
    });

    it('cambiar un filtro estando en la página 2 vuelve a la primera (no usa el cursor viejo)', async () => {
      const { peticiones } = simularServidor(siete(), 3);
      const user = userEvent.setup();
      render(<VistaEnviosCampanas onSesionInvalida={() => {}} />);
      await screen.findByText('n7@x.cr');
      await user.click(screen.getByRole('button', { name: 'Siguiente' }));
      await screen.findByText('n4@x.cr');
      await user.selectOptions(screen.getByRole('combobox', { name: 'Estado' }), 'rebotado');
      await waitFor(() => expect(correosVisibles()).toEqual(['n6@x.cr', 'n4@x.cr', 'n2@x.cr']));
      expect(peticiones[peticiones.length - 1].despues).toBeUndefined();
      expect(screen.getByText('1–3 de 3')).toBeInTheDocument();
    });

    it('el total que se muestra es el del filtro, no el de la página', async () => {
      simularServidor(siete(), 3);
      const user = userEvent.setup();
      render(<VistaEnviosCampanas onSesionInvalida={() => {}} />);
      await screen.findByText('1–3 de 7');
      await user.selectOptions(screen.getByRole('combobox', { name: 'Estado' }), 'rebotado');
      expect(await screen.findByText('1–3 de 3')).toBeInTheDocument();
    });
  });

  it('si llega tarde la respuesta de un filtro anterior, no pisa la del filtro actual', async () => {
    const d = datosBase();
    d.envios.push(
      envio({ campana_id: C_NORTE, correo: 'rebotado@x.cr', entrega_estado: 'rebotado' }),
      envio({ campana_id: C_NORTE, correo: 'entregado@x.cr', entrega_estado: 'entregado' }),
    );
    const pendientes: Array<() => void> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const cuerpo = JSON.parse(String(init?.body ?? '{}'));
      const pagina = await listarEnvios(crearDb(d), { estado: cuerpo.estado }, null, 50);
      const respuesta = new Response(JSON.stringify({ ok: true, ...pagina }), { status: 200 });
      // La del filtro «rebotado» es lenta; la de «entregado», rápida.
      if (cuerpo.estado === 'rebotado') await new Promise<void>((r) => pendientes.push(r));
      return respuesta;
    });
    const user = userEvent.setup();
    render(<VistaEnviosCampanas onSesionInvalida={() => {}} />);
    await screen.findByText('entregado@x.cr');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Estado' }), 'rebotado');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Estado' }), 'entregado');
    await waitFor(() => expect(correosVisibles()).toEqual(['entregado@x.cr']));
    pendientes.forEach((r) => r());
    await new Promise((r) => setTimeout(r, 30));
    expect(correosVisibles()).toEqual(['entregado@x.cr']);
    expect(screen.queryByText('rebotado@x.cr')).not.toBeInTheDocument();
  });

  it('una sesión vencida (401) avisa al panel', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: false, error: 'x' }), { status: 401 }));
    const onSesionInvalida = vi.fn();
    render(<VistaEnviosCampanas onSesionInvalida={onSesionInvalida} />);
    await waitFor(() => expect(onSesionInvalida).toHaveBeenCalled());
  });

  it('un error del servidor se muestra, sin tumbar la pantalla', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: false, error: 'No se pudo consultar los correos enviados.' }), { status: 500 }));
    render(<VistaEnviosCampanas onSesionInvalida={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo consultar los correos enviados.');
  });
});
