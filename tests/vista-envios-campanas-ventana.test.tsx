import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VistaEnviosCampanas } from '@/app/cotizador/VistaEnviosCampanas';
import { listarEnvios } from '@/lib/campanas/envios-listado';
import { crearDb, envio, uuid, type Datos } from './helpers/db-envios';

// La ventana que se abre al hacer clic en una fila de «Correos enviados».
// El `fetch` simulado ejecuta el listado REAL sobre un doble de la base; la
// ruta del correo la responde cada prueba (para poder demorarla o romperla).

const C1 = uuid(9001);
const BAJA = 'https://luxeessentialscr.com/baja?t=YW5hQGhvdGVsLmNy.firma';

function datosBase(): Datos {
  const d: Datos = {
    campanas: [{ id: C1, zona: 'Zona Norte', plantilla: 'inicial', creado_at: '2026-09-01T10:00:00+00:00' }],
    envios: [],
  };
  d.envios.push(
    envio({ campana_id: C1, correo: 'ana@hotel.cr', nombre_crm: 'Hotel Arenal', actualizado_at: '2026-09-20T15:00:02.000000+00:00' }),
    envio({ campana_id: C1, correo: 'luis@soda.cr', nombre_crm: 'Soda Luis', actualizado_at: '2026-09-20T15:00:01.000000+00:00' }),
  );
  return d;
}

const HTML_AJENO =
  `<html><head><style>p{display:none} body{background:red}</style></head><body onload="x()">` +
  `<p>Texto del correo ajeno</p><a href="${BAJA}" onclick="x()">Darme de baja</a>` +
  `<form action="${BAJA}"><button>x</button></form><script>alert(1)</script></body></html>`;

function correoDe(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    destinatario: 'ana@hotel.cr',
    empresa: 'Hotel Arenal',
    zona: 'Zona Norte',
    plantilla: 'inicial',
    campanaId: C1,
    enviadoAt: '2026-09-20T15:00:02.000000+00:00',
    salio: true,
    asunto: 'Cotizacion para Hotel Arenal',
    html: HTML_AJENO,
    ...extra,
  };
}

type Resp = () => Promise<Response> | Response;
function simular(datos: Datos, correo: Resp = () => new Response(JSON.stringify({ ok: true, correo: correoDe('x') }), { status: 200 })) {
  const pedidosCorreo: any[] = [];
  const pedidosListado: any[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const cuerpo = JSON.parse(String(init?.body ?? '{}'));
    if (url.endsWith('/api/campanas/envios/correo')) {
      pedidosCorreo.push({ cuerpo, signal: init?.signal });
      return correo();
    }
    if (url.endsWith('/api/campanas/envios')) {
      pedidosListado.push(cuerpo);
      const pagina = await listarEnvios(crearDb(datos), {}, cuerpo.despues ?? null, cuerpo.tamano ?? 10);
      return new Response(JSON.stringify({ ok: true, ...pagina }), { status: 200 });
    }
    throw new Error(`Fetch no simulado: ${url}`);
  });
  return { pedidosCorreo, pedidosListado };
}
const responde = (id: string, extra?: Record<string, unknown>): Resp => () =>
  new Response(JSON.stringify({ ok: true, correo: correoDe(id, extra) }), { status: 200 });

const fila = (correo: string) => screen.getByText(correo).closest('tr')!;
async function abrir(user: ReturnType<typeof userEvent.setup>, correo = 'ana@hotel.cr') {
  render(<VistaEnviosCampanas onSesionInvalida={() => {}} />);
  await screen.findByText(correo);
  await user.click(fila(correo));
  return screen.findByRole('dialog');
}

afterEach(() => vi.restoreAllMocks());

describe('ventana del correo enviado', () => {
  it('el cuerpo NO se pide con el listado: sólo cuando se abre la ventana, con el id de la fila', async () => {
    const d = datosBase();
    const { pedidosCorreo, pedidosListado } = simular(d, () => new Response(JSON.stringify({ ok: true, correo: correoDe(d.envios[0].id) }), { status: 200 }));
    const user = userEvent.setup();
    render(<VistaEnviosCampanas onSesionInvalida={() => {}} />);
    await screen.findByText('ana@hotel.cr');
    expect(pedidosListado.length).toBeGreaterThan(0);
    expect(pedidosCorreo).toHaveLength(0);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(fila('ana@hotel.cr'));
    await screen.findByRole('dialog');
    expect(pedidosCorreo).toHaveLength(1);
    expect(pedidosCorreo[0].cuerpo).toEqual({ id: d.envios[0].id });
  });

  it('muestra a quién, de qué empresa, zona y campaña, cuándo salió y el asunto', async () => {
    const d = datosBase();
    simular(d, responde(d.envios[0].id));
    const dialogo = await abrir(userEvent.setup());
    const v = within(dialogo);
    await v.findByText('Cotizacion para Hotel Arenal');
    expect(v.getByRole('heading')).toHaveTextContent('Hotel Arenal');
    expect(v.getByText('ana@hotel.cr')).toBeInTheDocument();
    expect(v.getByText('Zona Norte')).toBeInTheDocument();
    expect(v.getByText('Correo inicial')).toBeInTheDocument();
    expect(dialogo.textContent).toMatch(/2026|sep/i);
    expect(dialogo.textContent).not.toMatch(/resend|webhook|\bapi\b|\bcron\b/i);
  });

  it('mientras carga se nota (estado «cargando», sin el marco); al llegar, aparece el correo', async () => {
    const d = datosBase();
    let soltar!: () => void;
    simular(d, () => new Promise<Response>((r) => (soltar = () => r(responde(d.envios[0].id)() as Response))));
    const dialogo = await abrir(userEvent.setup());
    expect(dialogo).toHaveAttribute('aria-busy', 'true');
    expect(within(dialogo).getByRole('status')).toHaveTextContent(/cargando el correo/i);
    expect(dialogo.querySelector('iframe')).toBeNull();
    // Mientras tanto ya se sabe a quien (viene de la fila).
    expect(within(dialogo).getByText('ana@hotel.cr')).toBeInTheDocument();

    soltar();
    await waitFor(() => expect(dialogo.querySelector('iframe')).not.toBeNull());
    expect(dialogo).toHaveAttribute('aria-busy', 'false');
    expect(within(dialogo).queryByRole('status')).not.toBeInTheDocument();
  });

  describe('el HTML ajeno va aislado y los enlaces no navegan', () => {
    async function conCorreo() {
      const d = datosBase();
      simular(d, responde(d.envios[0].id));
      const dialogo = await abrir(userEvent.setup());
      const marco = (await waitFor(() => {
        const f = dialogo.querySelector('iframe');
        expect(f).not.toBeNull();
        return f;
      })) as HTMLIFrameElement;
      return { dialogo, marco };
    }

    it('el marco no tiene NINGÚN permiso (sandbox vacío): ni scripts, ni navegar arriba, ni ventanas, ni formularios', async () => {
      const { marco } = await conCorreo();
      expect(marco.hasAttribute('sandbox')).toBe(true);
      expect(marco.getAttribute('sandbox')).toBe('');
    });

    it('lo que entra al marco ya no tiene destino en ningún enlace, ni formularios, ni scripts, ni on...', async () => {
      const { marco } = await conCorreo();
      const srcdoc = marco.getAttribute('srcdoc')!;
      expect(srcdoc).toContain('Texto del correo ajeno');
      expect(srcdoc).not.toContain('baja?t=');
      const doc = new DOMParser().parseFromString(srcdoc, 'text/html');
      expect(doc.querySelectorAll('[href],[action],[formaction]')).toHaveLength(0);
      expect(doc.querySelector('script')).toBeNull();
      expect(doc.querySelector('form')).toBeNull();
      expect(Array.from(doc.querySelectorAll('*')).some((e) => e.getAttributeNames().some((n) => n.startsWith('on')))).toBe(false);
      expect(doc.querySelector('meta[http-equiv="Content-Security-Policy"]')).not.toBeNull();
    });

    it('el correo no se mete en el panel: ni su texto ni sus estilos están en el documento de la página', async () => {
      await conCorreo();
      expect(screen.queryByText('Texto del correo ajeno')).not.toBeInTheDocument();
      expect(screen.queryByText('Darme de baja')).not.toBeInTheDocument();
      const estilos = Array.from(document.querySelectorAll('style')).map((s) => s.textContent).join('');
      expect(estilos).not.toContain('display:none');
      expect(document.querySelector('a[href*="baja"]')).toBeNull();
    });

    it('el enlace de baja no se ofrece como enlace en NINGUNA parte de la página, ni en la ventana', async () => {
      const { dialogo } = await conCorreo();
      expect(within(dialogo).queryAllByRole('link')).toHaveLength(0);
      expect(document.body.innerHTML).not.toContain('baja?t=YW5h');
    });

    it('el marco no recibe el foco con Tab', async () => {
      const { marco } = await conCorreo();
      expect(marco.tabIndex).toBe(-1);
    });
  });

  describe('cierre y foco', () => {
    async function abierta() {
      const d = datosBase();
      simular(d, responde(d.envios[0].id));
      const user = userEvent.setup();
      const dialogo = await abrir(user);
      await within(dialogo).findByText('Cotizacion para Hotel Arenal');
      return { user, dialogo };
    }

    it('Escape cierra la ventana', async () => {
      const { user } = await abierta();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('un clic fuera la cierra; un clic adentro no', async () => {
      const { user, dialogo } = await abierta();
      await user.click(within(dialogo).getByText('Cotizacion para Hotel Arenal'));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      await user.click(dialogo.parentElement!);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('el botón «Cerrar» la cierra', async () => {
      const { user, dialogo } = await abierta();
      await user.click(within(dialogo).getByRole('button', { name: 'Cerrar' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('al abrir, el foco pasa a la ventana; Tab no se escapa; al cerrar vuelve a la fila', async () => {
      const { user, dialogo } = await abierta();
      const cerrar = within(dialogo).getByRole('button', { name: 'Cerrar' });
      expect(cerrar).toHaveFocus();
      await user.tab();
      expect(dialogo.contains(document.activeElement)).toBe(true);
      await user.tab({ shift: true });
      expect(dialogo.contains(document.activeElement)).toBe(true);
      await user.keyboard('{Escape}');
      expect(fila('ana@hotel.cr')).toHaveFocus();
    });

    it('si el marco se queda con el foco (un clic en el correo), se lo devolvemos a la ventana para que Escape siga andando', async () => {
      const { dialogo } = await abierta();
      const marco = dialogo.querySelector('iframe') as HTMLIFrameElement;
      marco.focus();
      expect(marco).toHaveFocus();
      fireEvent.blur(window);
      await waitFor(() => expect(within(dialogo).getByRole('button', { name: 'Cerrar' })).toHaveFocus());
    });

    it('mientras está abierta la página de atrás no se desplaza, y al cerrar se restablece', async () => {
      const { user } = await abierta();
      expect(document.body.style.overflow).toBe('hidden');
      await user.keyboard('{Escape}');
      expect(document.body.style.overflow).not.toBe('hidden');
    });

    it('con Enter sobre la fila también se abre (sin mouse)', async () => {
      const d = datosBase();
      simular(d, responde(d.envios[0].id));
      render(<VistaEnviosCampanas onSesionInvalida={() => {}} />);
      await screen.findByText('ana@hotel.cr');
      fila('ana@hotel.cr').focus();
      await userEvent.setup().keyboard('{Enter}');
      expect(await screen.findByRole('dialog')).toBeInTheDocument();
    });
  });

  describe('cuando algo sale mal', () => {
    it('un error se dice en la ventana y se puede reintentar', async () => {
      const d = datosBase();
      let n = 0;
      const { pedidosCorreo } = simular(d, () =>
        ++n === 1
          ? new Response(JSON.stringify({ ok: false, error: 'No se pudo consultar el correo.' }), { status: 500 })
          : (responde(d.envios[0].id)() as Response),
      );
      const user = userEvent.setup();
      const dialogo = await abrir(user);
      expect(await within(dialogo).findByRole('alert')).toHaveTextContent('No se pudo consultar el correo.');
      await user.click(within(dialogo).getByRole('button', { name: 'Reintentar' }));
      await within(dialogo).findByText('Cotizacion para Hotel Arenal');
      expect(pedidosCorreo).toHaveLength(2);
      expect(within(dialogo).queryByRole('alert')).not.toBeInTheDocument();
    });

    it('una sesión vencida (401) avisa al panel', async () => {
      const d = datosBase();
      simular(d, () => new Response(JSON.stringify({ ok: false, error: 'x' }), { status: 401 }));
      const onSesionInvalida = vi.fn();
      const user = userEvent.setup();
      render(<VistaEnviosCampanas onSesionInvalida={onSesionInvalida} />);
      await screen.findByText('ana@hotel.cr');
      await user.click(fila('ana@hotel.cr'));
      await waitFor(() => expect(onSesionInvalida).toHaveBeenCalled());
    });

    it('si se cierra con la respuesta en camino, se cancela y no pinta nada después', async () => {
      const d = datosBase();
      let soltar!: () => void;
      const { pedidosCorreo } = simular(d, () => new Promise<Response>((r) => (soltar = () => r(responde(d.envios[0].id)() as Response))));
      const user = userEvent.setup();
      await abrir(user);
      await user.keyboard('{Escape}');
      expect(pedidosCorreo[0].signal.aborted).toBe(true);
      soltar();
      await new Promise((r) => setTimeout(r, 30));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(document.querySelector('iframe')).toBeNull();
    });

    it('un envío que nunca salió se muestra, con el aviso de que no llegó a salir', async () => {
      const d = datosBase();
      simular(d, responde(d.envios[0].id, { salio: false }));
      const dialogo = await abrir(userEvent.setup());
      expect(await within(dialogo).findByText(/nunca llegó a salir/i)).toBeInTheDocument();
    });

    it('el aviso de «nunca salió» NO aparece en un correo que sí salió', async () => {
      const d = datosBase();
      simular(d, responde(d.envios[0].id));
      const dialogo = await abrir(userEvent.setup());
      await within(dialogo).findByText('Cotizacion para Hotel Arenal');
      expect(within(dialogo).queryByText(/nunca llegó a salir/i)).not.toBeInTheDocument();
    });
  });

  it('abrir otra fila pide el correo de ESA fila', async () => {
    const d = datosBase();
    const { pedidosCorreo } = simular(d, responde('x'));
    const user = userEvent.setup();
    render(<VistaEnviosCampanas onSesionInvalida={() => {}} />);
    await screen.findByText('luis@soda.cr');
    await user.click(fila('luis@soda.cr'));
    await screen.findByRole('dialog');
    expect(pedidosCorreo[0].cuerpo).toEqual({ id: d.envios[1].id });
  });
});
