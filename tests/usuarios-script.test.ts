import { describe, it, expect, vi } from 'vitest';
import { construirSql, completarArgumentos, huellaDe as huellaDeScript } from '../scripts/usuarios.mjs';
import { verificarClave } from '@/lib/cotizador/credenciales.mjs';
import { huellaDe, generarInvitacion, HORAS_VIGENCIA } from '@/lib/cotizador/invitaciones';

describe('construirSql: invitar', () => {
  it('invitar guarda la huella y nunca el enlace', async () => {
    const { texto, valores, enlace } = await construirSql('invitar', ['g@luxe.cr', 'Guillermo Rojas']);
    expect(texto).toContain('insert into public.usuarios_panel');
    expect(valores).toContain('g@luxe.cr');
    expect(valores).not.toContain(enlace);
    // `construirSql` sólo agrega `enlace` al resultado en la orden `invitar`
    // (las demás órdenes ni lo devuelven): TypeScript infiere el tipo de
    // retorno como una unión de esas formas distintas, así que acá llega
    // como `string | undefined` aunque en este caso concreto sí está.
    expect(valores).toContain(huellaDe(enlace!));
  });

  it('acepta el rol de superadmin', async () => {
    const { valores } = await construirSql('invitar', ['g@luxe.cr', 'Guillermo Rojas', '--superadmin']);
    expect(valores).toContain('superadmin');
  });

  it('por defecto invita como vendedor', async () => {
    const { valores } = await construirSql('invitar', ['g@luxe.cr', 'Guillermo Rojas']);
    expect(valores).toContain('vendedor');
  });

  it('normaliza el correo a minusculas y sin espacios de sobra', async () => {
    const { valores } = await construirSql('invitar', ['  G@LUXE.CR  ', 'Guillermo Rojas']);
    expect(valores).toContain('g@luxe.cr');
  });

  it('ni el nombre ni el enlace se interpolan en el texto de la consulta', async () => {
    const { texto, valores } = await construirSql('invitar', ['g@luxe.cr', "Guillermo O'Rojas"]);
    expect(texto).not.toContain("O'Rojas");
    expect(valores).toContain("Guillermo O'Rojas");
  });

  it('exige correo y nombre', async () => {
    await expect(construirSql('invitar', ['g@luxe.cr'])).rejects.toThrow();
    await expect(construirSql('invitar', [])).rejects.toThrow();
  });

  // Ronda de correcciones 1: cambiar `HORAS_VIGENCIA` de 72 a 24 en el
  // módulo TypeScript (la fuente de verdad) dejaba las 23 pruebas de
  // entonces en verde igual, porque ninguna leía `invitacion_expira`. Esta
  // prueba compara el vencimiento que guarda `invitar` contra
  // `HORAS_VIGENCIA` importado de `lib/cotizador/invitaciones.ts`, así que
  // una divergencia entre esa constante y la copia del script (ver arriba)
  // la pone roja.
  it('la invitación vence a las HORAS_VIGENCIA horas, no a otro plazo', async () => {
    const antes = Date.now();
    const { valores } = await construirSql('invitar', ['g@luxe.cr', 'Guillermo Rojas']);
    const despues = Date.now();
    const expira = new Date(valores[valores.length - 1] as string).getTime();

    const esperadoMin = antes + HORAS_VIGENCIA * 3_600_000;
    const esperadoMax = despues + HORAS_VIGENCIA * 3_600_000;
    expect(expira).toBeGreaterThanOrEqual(esperadoMin);
    expect(expira).toBeLessThanOrEqual(esperadoMax);
  });

  it('reconoce --sin-correo para no mandar la invitacion por Resend', async () => {
    const { sinCorreo } = await construirSql('invitar', ['g@luxe.cr', 'Guillermo Rojas', '--sin-correo']);
    expect(sinCorreo).toBe(true);
    const { sinCorreo: porDefecto } = await construirSql('invitar', ['g@luxe.cr', 'Guillermo Rojas']);
    expect(porDefecto).toBe(false);
  });
});

// La huella se calcula dos veces en el proyecto: una en
// `lib/cotizador/invitaciones.ts` (la usa el panel, vía `lib/cotizador/equipo.ts`)
// y otra, duplicada a propósito, en `scripts/usuarios.mjs` (un `.mjs` no puede
// importar ese `.ts`). Esta prueba es lo único que impide que las dos
// diverjan: si un enlace generado por el script no verificara contra la
// huella que calcula el módulo del panel, `fijar-clave/route.ts` rechazaría
// como inválida una invitación recién creada.
describe('cruce de huellas entre el script y lib/cotizador/invitaciones.ts', () => {
  it('huellaDe del script coincide con huellaDe del modulo TypeScript, para el mismo enlace', () => {
    const muestras = ['abc123', 'ff00ff00', randomHex(), randomHex(), ''];
    for (const enlace of muestras) {
      expect(huellaDeScript(enlace)).toBe(huellaDe(enlace));
    }
  });

  it('la huella que guarda `invitar` verifica contra huellaDe del modulo TypeScript', async () => {
    const { enlace, valores } = await construirSql('invitar', ['cruce@luxe.cr', 'Cruce De Modulos']);
    expect(valores).toContain(huellaDe(enlace!));
  });

  it('un enlace generado por generarInvitacion() del modulo produce la misma huella con huellaDe del script', () => {
    const { enlace, huella } = generarInvitacion();
    expect(huellaDeScript(enlace)).toBe(huella);
  });
});

function randomHex(): string {
  return Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

describe('construirSql: correo en vez de usuario', () => {
  it('las órdenes buscan por correo, no por usuario', async () => {
    for (const orden of ['desactivar', 'activar', 'desbloquear']) {
      const { texto } = await construirSql(orden, ['g@luxe.cr']);
      expect(texto).toContain('correo = $1');
      // No `not.toContain('usuario')` a secas: la tabla sigue llamándose
      // `usuarios_panel` (así la dejó la migración 0014, no se toca acá) y
      // esa palabra CONTIENE "usuario" como substring. Lo que esta prueba
      // tiene que impedir es que la columna del filtro vuelva a llamarse
      // `usuario`, no que la palabra aparezca en cualquier lado del texto.
      expect(texto).not.toMatch(/\busuario\s*=/);
    }
  });

  it('clave busca por correo, y de paso limpia bloqueo e intentos', async () => {
    const { texto, valores } = await construirSql('clave', ['g@luxe.cr', 'Turrialba-2027']);
    expect(texto).toContain('correo = $3');
    expect(texto).toContain('bloqueado_hasta = null');
    expect(texto).toContain('intentos = 0');
    const [hash, sal] = valores;
    expect(await verificarClave('Turrialba-2027', hash, sal)).toBe(true);
  });

  // Ronda de correcciones 1: sin esto, fijar una clave a mano no invalida el
  // enlace de invitación viejo (`fijar-clave/route.ts` sólo mira huella,
  // vencimiento y `activo` — nunca si `clave_hash` ya está puesto), y de
  // paso `listar` seguía mostrando a esa persona como "invitada"/"vencida"
  // porque `derivarEstado` usa `invitacion_expira === null` como señal de
  // "ya tiene clave".
  it('clave también limpia la invitación pendiente: invitacion_hash e invitacion_expira quedan en null', async () => {
    const { texto } = await construirSql('clave', ['g@luxe.cr', 'Turrialba-2027']);
    expect(texto).toContain('invitacion_hash = null');
    expect(texto).toContain('invitacion_expira = null');
  });

  it('desactivar y activar nunca borran la fila, sólo cambian activo', async () => {
    const { texto: textoDesactivar } = await construirSql('desactivar', ['g@luxe.cr']);
    expect(textoDesactivar).toContain('update');
    expect(textoDesactivar).toContain('activo = false');
    expect(textoDesactivar).not.toMatch(/\bdelete\b/i);

    const { texto: textoActivar } = await construirSql('activar', ['g@luxe.cr']);
    expect(textoActivar).toContain('update');
    expect(textoActivar).toContain('activo = true');
    expect(textoActivar).not.toMatch(/\bdelete\b/i);
  });

  it('desbloquear limpia el bloqueo y el contador', async () => {
    const { texto } = await construirSql('desbloquear', ['g@luxe.cr']);
    expect(texto).toContain('bloqueado_hasta = null');
    expect(texto).toContain('intentos = 0');
  });

  it('rechaza una orden desconocida', async () => {
    await expect(construirSql('borrar-todo', [])).rejects.toThrow();
  });

  it('exige los argumentos de cada orden', async () => {
    await expect(construirSql('desactivar', [])).rejects.toThrow();
    await expect(construirSql('clave', ['g@luxe.cr'])).rejects.toThrow();
  });
});

// La lista es para saber quién tiene acceso, no para exfiltrar hashes.
describe('construirSql: listar', () => {
  it('listar muestra el rol y no filtra el hash', async () => {
    const { texto } = await construirSql('listar', []);
    expect(texto).toContain('rol');
    expect(texto).not.toContain('clave_hash');
    expect(texto).not.toContain('invitacion_hash');
    expect(texto).not.toContain('clave_sal');
  });
});

// Revisión final, M2: pasar la clave como argumento la deja en
// `~/.zsh_history` y visible en `ps` mientras el comando corre. La forma con
// argumento se conserva (la usan las pruebas de arriba, y sirve para
// automatizar), pero la recomendada es la interactiva. `invitar` ya no pide
// nada por acá: no lleva clave, la elige la persona invitada al fijarla.
describe('completarArgumentos', () => {
  it('pide la clave nueva de `clave` por consola cuando no viene como argumento', async () => {
    const pedir = vi.fn().mockResolvedValue('Turrialba-2027');
    const completos = await completarArgumentos('clave', ['g@luxe.cr'], pedir);

    expect(completos).toEqual(['g@luxe.cr', 'Turrialba-2027']);
    // Dos veces: sin eco, una clave mal tecleada no se ve, y el síntoma llega
    // días después como "no puedo entrar" de alguien que sí la escribió bien.
    expect(pedir).toHaveBeenCalledTimes(2);
  });

  it('no pregunta nada si la clave ya vino como argumento', async () => {
    const pedir = vi.fn();
    const completos = await completarArgumentos('clave', ['g@luxe.cr', 'ya-la-tengo'], pedir);
    expect(completos).toEqual(['g@luxe.cr', 'ya-la-tengo']);
    expect(pedir).not.toHaveBeenCalled();
  });

  it('no pregunta nada en las órdenes que no llevan clave, incluida invitar', async () => {
    const pedir = vi.fn();
    for (const orden of ['listar', 'invitar', 'desactivar', 'activar', 'desbloquear']) {
      await completarArgumentos(orden, ['g@luxe.cr', 'Guillermo Rojas'], pedir);
    }
    expect(pedir).not.toHaveBeenCalled();
  });

  it('rechaza si las dos veces no coinciden, sin tocar nada', async () => {
    const pedir = vi.fn().mockResolvedValueOnce('una').mockResolvedValueOnce('otra');
    await expect(completarArgumentos('clave', ['g@luxe.cr'], pedir)).rejects.toThrow(/no coinciden/i);
  });

  it('rechaza una clave vacía sin llegar a preguntar la segunda vez', async () => {
    const pedir = vi.fn().mockResolvedValue('');
    await expect(completarArgumentos('clave', ['g@luxe.cr'], pedir)).rejects.toThrow(/vac[ií]a/i);
    expect(pedir).toHaveBeenCalledTimes(1);
  });

  // Si falta el correo, la orden va a fallar igual: preguntar una clave antes
  // de eso haría teclear un secreto para nada.
  it('no pregunta si falta el argumento anterior a la clave', async () => {
    const pedir = vi.fn();
    await completarArgumentos('clave', [], pedir);
    expect(pedir).not.toHaveBeenCalled();
  });
});
