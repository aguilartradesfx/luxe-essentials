// En qué quedó cada correo de una campaña, para la pantalla «Correos
// enviados». Sin `server-only` a propósito: lo comparten la ruta (para
// traducir un filtro a condiciones de la base) y el componente (para
// pintar la pastilla) -- una sola definición, no dos que puedan divergir.
//
// QUÉ NO SE SABE, y ningún rótulo de acá lo finge: Resend no sabe si un
// correo cayó en la carpeta de spam; nadie lo sabe desde afuera, porque los
// proveedores no informan dónde dejaron el mensaje. Lo que sí existe es
// `queja` (email.complained): la persona lo RECIBIÓ en su bandeja y le dio
// «marcar como spam». Es otra cosa, y más grave. Ninguna etiqueta de este
// archivo dice «cayó en spam».

// Los estados que ve quien mira la pantalla. Se derivan de DOS columnas de
// `campanas_envios`:
//   - `estado` ('enviado' | 'error' | 'pendiente'): lo que pasó al MANDAR.
//   - `entrega_estado` (migración 0029): lo que Resend contó DESPUÉS, por
//     webhook. `null` si todavía no llegó ningún evento.
export const ESTADOS_ENTREGA = [
  'sin_confirmar',
  'retrasado',
  'entregado',
  'rebotado',
  'fallido',
  'queja',
  'no_salio',
] as const;
export type EstadoEntrega = (typeof ESTADOS_ENTREGA)[number];

export function esEstadoEntrega(valor: unknown): valor is EstadoEntrega {
  return typeof valor === 'string' && (ESTADOS_ENTREGA as readonly string[]).includes(valor);
}

export const ETIQUETAS_ENTREGA: Record<EstadoEntrega, string> = {
  sin_confirmar: 'Sin confirmar',
  retrasado: 'Retrasado',
  entregado: 'Entregado',
  rebotado: 'Rebotado',
  fallido: 'Fallido',
  queja: 'Lo marcó como spam',
  no_salio: 'No salió',
};

// Qué dice cada estado cuando se pasa el cursor por encima (y en la ayuda
// de la pantalla).
//
// Reporte del dueño (2026-10-04): esta ayuda nombraba a «Resend» y al
// «webhook» -- las dos son piezas internas del sistema. Quien abre este
// panel es el equipo comercial de Luxe y, a través de ellos, el cliente:
// nadie ahí sabe ni tiene por qué saber qué es Resend. Un texto que explica
// un estado nombrando la herramienta que lo produjo no explica nada; sólo
// deja claro que está escrito para quien la programó.
//
// La regla ahora: cada estado se dice desde el punto de vista de la empresa
// que mandó el correo -- qué le pasó al correo, no qué hizo el proveedor.
// La de `queja` es la única que, además, no puede quedar ambigua.
export const AYUDA_ENTREGA: Record<EstadoEntrega, string> = {
  sin_confirmar:
    'El correo salió, pero todavía no hay confirmación de que haya llegado. No quiere decir que haya fallado.',
  retrasado: 'El correo del destinatario todavía no lo recibió. Se sigue intentando.',
  entregado:
    'Llegó al correo del destinatario. No dice si quedó en la bandeja de entrada o en la de spam: eso no lo informa ningún proveedor de correo.',
  rebotado: 'El correo del destinatario lo rechazó. No llegó. Suele ser una dirección que ya no existe.',
  fallido: 'No se pudo enviar. No llegó.',
  queja:
    'La persona lo recibió en su bandeja y le dio «marcar como spam». No es lo mismo que haber caído en la carpeta de spam, y es más grave.',
  no_salio: 'El correo nunca salió. Suele ser una dirección mal escrita.',
};

export type FilaParaEstado = {
  estado: string;
  entrega_estado: string | null;
};

// El estado que se muestra. `entrega_estado` 'enviado' (email.sent) y `null`
// son lo mismo para quien mira: Resend lo despachó, nadie confirmó la
// entrega -> «Sin confirmar». Un correo recién salido está así, no «falló».
export function estadoDeEntrega(fila: FilaParaEstado): EstadoEntrega {
  if (fila.estado === 'error') return 'no_salio';
  switch (fila.entrega_estado) {
    case 'retrasado':
      return 'retrasado';
    case 'entregado':
      return 'entregado';
    case 'rebotado':
      return 'rebotado';
    case 'fallido':
      return 'fallido';
    case 'queja':
      return 'queja';
    default:
      return 'sin_confirmar';
  }
}

// Cada estado, un color distinto -- la regla de esta pantalla es que un
// estado se distinga de otro a simple vista. «Sin confirmar» es el único
// gris: ni verde ni rojo, porque todavía no se sabe.
export type Pastilla = { texto: string; clase: string };

const CLASES: Record<EstadoEntrega, string> = {
  sin_confirmar: 'bg-[var(--carta-fill)] text-teal',
  retrasado: 'bg-amber-50 text-amber-800',
  entregado: 'bg-emerald-50 text-emerald-800',
  rebotado: 'bg-red-50 text-red-800',
  fallido: 'bg-rose-100 text-rose-900',
  queja: 'bg-orange-100 text-orange-900',
  no_salio: 'bg-red-100 text-red-900',
};

export function pastillaDeEntrega(estado: EstadoEntrega): Pastilla {
  return { texto: ETIQUETAS_ENTREGA[estado], clase: CLASES[estado] };
}
