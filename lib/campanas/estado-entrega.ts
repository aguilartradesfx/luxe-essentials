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
// de la pantalla). La de `queja` es la que no puede quedar ambigua.
export const AYUDA_ENTREGA: Record<EstadoEntrega, string> = {
  sin_confirmar:
    'Resend lo aceptó, pero todavía no llegó ninguna confirmación de entrega. No significa que haya fallado: el aviso puede tardar o el webhook puede no estar configurado.',
  retrasado: 'El proveedor del destinatario todavía no lo recibió; Resend sigue intentando.',
  entregado: 'El proveedor del destinatario lo aceptó. No dice si quedó en la bandeja o en la carpeta de spam: eso no lo informa nadie.',
  rebotado: 'El proveedor rechazó la dirección o el mensaje. No se entregó.',
  fallido: 'Resend no pudo enviarlo. No se entregó.',
  queja:
    'La persona lo recibió en su bandeja y le dio «marcar como spam». No es lo mismo que haber caído en la carpeta de spam, y es más grave.',
  no_salio: 'Se intentó mandar y Resend no lo aceptó. Nunca salió.',
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
