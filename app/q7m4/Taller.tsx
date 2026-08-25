'use client';

import { useEffect, useRef, useState } from 'react';

type Turno = { de: 'cliente' | 'agente'; texto: string; frases?: number };
type Datos = {
  nombre: string | null;
  email: string | null;
  telefono: string | null;
  producto: string | null;
  ubicacion: string | null;
};

const VACIOS: Datos = { nombre: null, email: null, telefono: null, producto: null, ubicacion: null };

const ETIQUETAS: Record<keyof Datos, string> = {
  nombre: 'Nombre',
  email: 'Correo',
  telefono: 'Teléfono',
  producto: 'Producto',
  ubicacion: 'Ubicación',
};

// El prompt le pide de una a tres frases. Contarlas hace visible de un vistazo
// si la regla se está respetando, que a ojo cuesta juzgar.
function contarFrases(texto: string): number {
  return texto.split(/(?<=[.?!])\s+/).filter((f) => f.trim().length > 0).length;
}

export function Taller() {
  const [clave, setClave] = useState('');
  const [dentro, setDentro] = useState(false);
  const [claveError, setClaveError] = useState('');

  const [canal, setCanal] = useState<'WhatsApp' | 'Email'>('WhatsApp');
  const [turnos, setTurnos] = useState<Turno[]>([]);
  const [datos, setDatos] = useState<Datos>(VACIOS);
  const [borrador, setBorrador] = useState('');
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState('');

  const [notas, setNotas] = useState('');
  const [etiqueta, setEtiqueta] = useState('');
  const [copiado, setCopiado] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [guardado, setGuardado] = useState('');
  const finRef = useRef<HTMLDivElement>(null);
  const notasRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const g = sessionStorage.getItem('taller-clave');
    if (g) { setClave(g); setDentro(true); }
    setNotas(localStorage.getItem('taller-notas') ?? '');
  }, []);

  useEffect(() => { localStorage.setItem('taller-notas', notas); }, [notas]);
  useEffect(() => { finRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [turnos, cargando]);

  async function pedir(historial: Turno[]) {
    setCargando(true);
    setError('');
    try {
      const res = await fetch('/api/q7m4', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clave,
          canal,
          datos,
          turnos: historial.map(({ de, texto }) => ({ de, texto })),
        }),
      });
      const d = await res.json();
      if (!res.ok || !d.ok) {
        if (res.status === 401) { setDentro(false); sessionStorage.removeItem('taller-clave'); }
        setError(d.error ?? `Error ${res.status}`);
        return;
      }
      setTurnos([...historial, { de: 'agente', texto: d.respuesta, frases: contarFrases(d.respuesta) }]);
      setDatos(d.datos);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Fallo de red');
    } finally {
      setCargando(false);
    }
  }

  async function entrar(e: React.FormEvent) {
    e.preventDefault();
    setClaveError('');
    const res = await fetch('/api/q7m4', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clave, turnos: [{ de: 'cliente', texto: 'hola' }], canal: 'WhatsApp' }),
    });
    if (res.status === 401) { setClaveError('Clave incorrecta.'); return; }
    sessionStorage.setItem('taller-clave', clave);
    setDentro(true);
  }

  function enviar(e: React.FormEvent) {
    e.preventDefault();
    const texto = borrador.trim();
    if (!texto || cargando) return;
    const historial: Turno[] = [...turnos, { de: 'cliente', texto }];
    setTurnos(historial);
    setBorrador('');
    void pedir(historial);
  }

  function anotar(t: Turno, i: number) {
    const cita = t.texto.length > 90 ? `${t.texto.slice(0, 90)}…` : t.texto;
    setNotas((n) => `${n}${n && !n.endsWith('\n') ? '\n' : ''}\n[turno ${i + 1} · ${t.de}] "${cita}"\n→ `);
    notasRef.current?.focus();
  }

  function reiniciar() {
    setTurnos([]);
    setDatos(VACIOS);
    setError('');
  }

  function comoMarkdown(): string {
    const faltan = (Object.keys(ETIQUETAS) as (keyof Datos)[]).filter((k) => !datos[k]);
    return [
      `# Sesión de prueba — agente Luxe`,
      `Canal: ${canal} · ${new Date().toLocaleString('es-CR')}`,
      ``,
      `## Conversación`,
      ...turnos.map((t, i) =>
        t.de === 'cliente'
          ? `**${i + 1}. Cliente:** ${t.texto}`
          : `**${i + 1}. Agente** _(${t.frases} ${t.frases === 1 ? 'frase' : 'frases'})_**:** ${t.texto}`,
      ),
      ``,
      `## Datos que extrajo`,
      ...(Object.keys(ETIQUETAS) as (keyof Datos)[]).map((k) => `- ${ETIQUETAS[k]}: ${datos[k] ?? '—'}`),
      faltan.length ? `\nSin capturar: ${faltan.map((k) => ETIQUETAS[k].toLowerCase()).join(', ')}.` : '',
      ``,
      `## Notas`,
      notas.trim() || '(sin notas)',
    ].join('\n');
  }

  async function copiarSesion() {
    await navigator.clipboard.writeText(comoMarkdown());
    setCopiado(true);
    setTimeout(() => setCopiado(false), 2000);
  }

  // Respaldo cuando la base no responde: la sesión se descarga en vez de
  // perderse. El objetivo de guardar es que estas observaciones lleguen a
  // alguien; un error en pantalla no cumple eso.
  function descargar() {
    const url = URL.createObjectURL(new Blob([comoMarkdown()], { type: 'text/markdown' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `taller-${etiqueta.trim().replace(/\s+/g, '-') || 'sesion'}-${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function guardar() {
    if (guardando) return;
    setGuardando(true);
    setGuardado('');
    try {
      const res = await fetch('/api/q7m4/notas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clave, etiqueta, canal, turnos, datos, notas }),
      });
      const d = await res.json();
      if (res.ok && d.ok) {
        setGuardado(`Guardado en la base · ${String(d.id).slice(0, 8)}`);
      } else {
        descargar();
        setGuardado(`La base no respondió, así que se descargó el archivo. (${d.error ?? res.status})`);
      }
    } catch (e) {
      descargar();
      setGuardado(`Sin conexión con la base; se descargó el archivo. (${e instanceof Error ? e.message : 'red'})`);
    } finally {
      setGuardando(false);
    }
  }

  if (!dentro) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6">
        <form onSubmit={entrar} className="w-full max-w-xs">
          <h1 className="font-display text-2xl text-navy">Banco de pruebas</h1>
          <p className="mt-2 text-sm text-teal">Agente de respuesta · Luxe Essentials</p>
          <input
            type="password"
            value={clave}
            onChange={(e) => setClave(e.target.value)}
            placeholder="Clave"
            autoFocus
            className="mt-6 w-full rounded-lg border border-[var(--carta-border)] bg-white px-4 py-3 text-sm text-navy placeholder:text-teal/60"
          />
          {claveError && <p className="mt-2 text-sm text-red-700">{claveError}</p>}
          <button
            type="submit"
            className="mt-3 w-full rounded-lg bg-navy px-4 py-3 text-sm font-medium text-beige hover:bg-teal"
          >
            Entrar
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--carta-border)] pb-4">
        <div>
          <h1 className="font-display text-xl text-navy">Banco de pruebas</h1>
          <p className="text-xs text-teal">
            Prueba el cerebro del agente: el prompt, el tono y la extracción de datos. No toca
            GoHighLevel ni la base de datos.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={canal}
            onChange={(e) => { setCanal(e.target.value as 'WhatsApp' | 'Email'); reiniciar(); }}
            className="rounded-lg border border-[var(--carta-border)] bg-white px-3 py-2 text-sm text-navy"
          >
            <option value="WhatsApp">WhatsApp / IG / FB</option>
            <option value="Email">Correo (respuesta única)</option>
          </select>
          <button onClick={reiniciar} className="rounded-lg border border-[var(--carta-border)] px-3 py-2 text-sm text-teal hover:text-navy">
            Reiniciar
          </button>
          <button onClick={copiarSesion} className="rounded-lg bg-navy px-3 py-2 text-sm text-beige hover:bg-teal">
            {copiado ? 'Copiado' : 'Copiar sesión'}
          </button>
        </div>
      </header>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_20rem]">
        <section className="flex min-h-[26rem] flex-col rounded-xl border border-[var(--carta-border)] bg-[var(--carta-fill)] p-4">
          <div className="flex-1 space-y-4 overflow-y-auto">
            {turnos.length === 0 && (
              <p className="py-12 text-center text-sm text-teal">
                Escribe como si fueras un cliente. Prueba a pedirle precios, a mandarle tres
                mensajes seguidos, o a escribirle en inglés.
              </p>
            )}
            {turnos.map((t, i) => (
              <div key={i} className={t.de === 'cliente' ? 'flex justify-end' : ''}>
                <div className={t.de === 'cliente' ? 'max-w-[85%]' : 'max-w-[90%]'}>
                  <div
                    className={
                      t.de === 'cliente'
                        ? 'rounded-2xl rounded-br-sm bg-sky px-4 py-2.5 text-sm text-navy'
                        : 'rounded-2xl rounded-bl-sm bg-beige px-4 py-2.5 text-sm text-navy'
                    }
                  >
                    {t.texto}
                  </div>
                  <div className="mt-1 flex items-center gap-3 px-1 text-[11px] text-teal">
                    {t.de === 'agente' && (
                      <span className={t.frases && t.frases > 3 ? 'font-medium text-red-700' : ''}>
                        {t.frases} {t.frases === 1 ? 'frase' : 'frases'}
                        {t.frases && t.frases > 3 ? ' · se pasa de 3' : ''}
                      </span>
                    )}
                    <button onClick={() => anotar(t, i)} className="underline hover:text-navy">
                      anotar
                    </button>
                  </div>
                </div>
              </div>
            ))}
            {cargando && <p className="text-sm text-teal">pensando…</p>}
            {error && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>
            )}
            <div ref={finRef} />
          </div>

          <form onSubmit={enviar} className="mt-4 flex gap-2 border-t border-[var(--carta-border)] pt-4">
            <input
              value={borrador}
              onChange={(e) => setBorrador(e.target.value)}
              placeholder="Escribe como cliente…"
              className="flex-1 rounded-lg border border-[var(--carta-border)] px-3 py-2.5 text-sm text-navy placeholder:text-teal/60"
            />
            <button
              type="submit"
              disabled={cargando || !borrador.trim()}
              className="rounded-lg bg-navy px-4 py-2.5 text-sm text-beige hover:bg-teal disabled:opacity-40"
            >
              Enviar
            </button>
          </form>
        </section>

        <aside className="space-y-6">
          <div className="rounded-xl border border-[var(--carta-border)] bg-[var(--carta-fill)] p-4">
            <h2 className="text-xs font-medium uppercase tracking-wide text-teal">Datos que va extrayendo</h2>
            <dl className="mt-3 space-y-2 text-sm">
              {(Object.keys(ETIQUETAS) as (keyof Datos)[]).map((k) => (
                <div key={k} className="flex justify-between gap-3">
                  <dt className="text-teal">{ETIQUETAS[k]}</dt>
                  <dd className={datos[k] ? 'text-right text-navy' : 'text-right text-teal/40'}>
                    {datos[k] ?? '—'}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="rounded-xl border border-[var(--carta-border)] bg-[var(--carta-fill)] p-4">
            <h2 className="text-xs font-medium uppercase tracking-wide text-teal">Notas</h2>
            <p className="mt-1 text-[11px] text-teal/70">Se guardan solas en este navegador.</p>
            <textarea
              ref={notasRef}
              value={notas}
              onChange={(e) => setNotas(e.target.value)}
              rows={12}
              placeholder="Lo que detectes: respuestas largas, datos que no captó, tono raro…"
              className="mt-3 w-full resize-y rounded-lg border border-[var(--carta-border)] bg-white p-3 font-mono text-xs leading-relaxed text-navy placeholder:text-teal/50"
            />
            <input
              value={etiqueta}
              onChange={(e) => setEtiqueta(e.target.value)}
              placeholder="Nombre de esta sesión (opcional)"
              className="mt-3 w-full rounded-lg border border-[var(--carta-border)] bg-white px-3 py-2 text-xs text-navy placeholder:text-teal/50"
            />
            <button
              onClick={guardar}
              disabled={guardando || turnos.length === 0}
              className="mt-2 w-full rounded-lg bg-navy px-4 py-2.5 text-sm font-medium text-beige hover:bg-teal disabled:opacity-40"
            >
              {guardando ? 'Guardando…' : 'Guardar sesión'}
            </button>
            {guardado && <p className="mt-2 text-[11px] leading-relaxed text-teal">{guardado}</p>}
          </div>
        </aside>
      </div>
    </main>
  );
}
