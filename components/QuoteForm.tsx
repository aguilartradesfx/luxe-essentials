'use client';

import { useState, type FormEvent } from 'react';
import { copy } from '@/content/copy';
import { Button } from '@/components/ui/Button';

type Estado = 'reposo' | 'enviando' | 'exito' | 'invalido' | 'error';

// Sin utilidad de border-color: cada estado aplica exactamente una (abajo).
// Dos utilidades de border-color con la misma especificidad compiten por el
// orden en que Tailwind las EMITE en la hoja generada, no por el orden en
// el string de className — concatenarlas aquí fue el bug que dejaba el
// borde de campo inválido sin efecto. Verificado compilando la hoja real:
// ver la nota en el reporte de la tarea.
const CAMPO_BASE =
  'mt-2 w-full rounded-xl border bg-white/5 px-4 py-3 text-beige placeholder:text-sky/50 focus:border-sky focus:outline-none';

const CAMPO_VALIDO = 'border-white/15';
const CAMPO_INVALIDO = 'border-beige';

function utmDeLaUrl(): Record<string, string> | undefined {
  if (typeof window === 'undefined') return undefined;
  const params = new URLSearchParams(window.location.search);
  const utm: Record<string, string> = {};
  for (const [k, v] of params) {
    if (k.startsWith('utm_')) utm[k] = v;
  }
  return Object.keys(utm).length > 0 ? utm : undefined;
}

export function QuoteForm() {
  const [estado, setEstado] = useState<Estado>('reposo');
  const [errores, setErrores] = useState<Record<string, string>>({});
  const c = copy.formulario;

  async function enviar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // No depender solo de que el botón llegue deshabilitado a tiempo: si dos
    // envíos se disparan antes de que React repinte, esto corta el segundo.
    if (estado === 'enviando') return;
    setEstado('enviando');
    setErrores({});

    const datos = Object.fromEntries(new FormData(event.currentTarget));

    try {
      const res = await fetch('/api/lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...datos, utm: utmDeLaUrl() }),
      });

      if (res.ok) {
        setEstado('exito');
        return;
      }

      // 400 trae los mensajes por campo que produjo el esquema del servidor.
      if (res.status === 400) {
        const cuerpo = await res.json().catch(() => null);
        setErrores(cuerpo?.errores ?? {});
        setEstado('invalido');
        return;
      }

      setEstado('error');
    } catch {
      setEstado('error');
    }
  }

  // El navegador no valida (el formulario lleva `noValidate`): así los
  // mensajes salen siempre del esquema, en español, y no del idioma del
  // navegador de cada visitante.
  const marca = (campo: string) =>
    errores[campo]
      ? {
          'aria-invalid': true,
          'aria-describedby': `err-${campo}`,
          className: `${CAMPO_BASE} ${CAMPO_INVALIDO}`,
        }
      : { className: `${CAMPO_BASE} ${CAMPO_VALIDO}` };

  function ErrorCampo({ campo }: { campo: string }) {
    if (!errores[campo]) return null;
    return (
      <p id={`err-${campo}`} role="alert" className="mt-2 text-sm text-beige">
        {errores[campo]}
      </p>
    );
  }

  if (estado === 'exito') {
    return (
      <div role="status" className="py-10 text-center">
        <p className="font-[family-name:var(--font-display)] text-2xl text-beige">
          {c.exitoTitulo}
        </p>
        <p className="mt-3 text-sky">{c.exitoDetalle}</p>
      </div>
    );
  }

  return (
    <form onSubmit={enviar} noValidate className="grid gap-5 sm:grid-cols-2">
      {/*
        El párrafo de error va FUERA del <label>, no dentro: `getByLabelText`
        (y el cálculo de nombre accesible en general) toma como texto de la
        etiqueta todo el contenido de texto del <label> salvo el propio
        control de formulario. Si el mensaje de error viviera dentro del
        <label>, el nombre accesible del campo pasaría de "Correo" a
        "CorreoEscribe un correo válido." en cuanto apareciera un error,
        rompiendo la asociación que este mismo formulario depende de leer.
      */}
      <div className="block">
        <label>
          <span className="text-sm text-sky">{c.campos.nombre}</span>
          <input name="nombre" {...marca('nombre')} />
        </label>
        <ErrorCampo campo="nombre" />
      </div>

      <div className="block">
        <label>
          <span className="text-sm text-sky">{c.campos.empresa}</span>
          <input name="empresa" {...marca('empresa')} />
        </label>
        <ErrorCampo campo="empresa" />
      </div>

      <div className="block">
        <label>
          <span className="text-sm text-sky">{c.campos.email}</span>
          <input name="email" type="email" {...marca('email')} />
        </label>
        <ErrorCampo campo="email" />
      </div>

      <div className="block">
        <label>
          <span className="text-sm text-sky">{c.campos.telefono}</span>
          <input name="telefono" type="tel" {...marca('telefono')} />
        </label>
        <ErrorCampo campo="telefono" />
      </div>

      <div className="block">
        <label>
          <span className="text-sm text-sky">{c.campos.linea}</span>
          <select name="linea" defaultValue="" {...marca('linea')}>
            <option value="" disabled />
            {c.opcionesLinea.map((o) => (
              <option key={o.valor} value={o.valor} className="bg-navy">
                {o.texto}
              </option>
            ))}
          </select>
        </label>
        <ErrorCampo campo="linea" />
      </div>

      <div className="block">
        <label>
          <span className="text-sm text-sky">{c.campos.cantidad}</span>
          <input name="cantidad" {...marca('cantidad')} />
        </label>
        <ErrorCampo campo="cantidad" />
      </div>

      <div className="block sm:col-span-2">
        <label>
          <span className="text-sm text-sky">{c.campos.mensaje}</span>
          <textarea name="mensaje" rows={4} {...marca('mensaje')} />
        </label>
        <ErrorCampo campo="mensaje" />
      </div>

      {estado === 'invalido' && (
        <p role="alert" className="text-sm text-beige sm:col-span-2">
          {c.errorValidacion}
        </p>
      )}

      {estado === 'error' && (
        <p role="alert" className="text-sm text-beige sm:col-span-2">
          {c.errorGeneral}
        </p>
      )}

      <div className="sm:col-span-2">
        <Button type="submit" disabled={estado === 'enviando'}>
          {estado === 'enviando' ? c.enviando : c.enviar}
        </Button>
      </div>
    </form>
  );
}
