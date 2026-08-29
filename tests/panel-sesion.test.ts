// tests/panel-sesion.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { emitirSesion, sesionValida, csrfValido, csrfDeSesion, nombreDeSesion } from '@/lib/sesion';

function conCookie(valor: string, cabeceras: Record<string, string> = {}) {
  return new Request('http://localhost/x', { headers: { cookie: valor, ...cabeceras } });
}

describe('sesión', () => {
  beforeEach(() => {
    process.env.LUXE_SESION_SECRETO = 'secreta';
  });

  it('la cookie es httpOnly, secure y sameSite=none', () => {
    const { cookie } = emitirSesion('Guillermo Rojas');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toMatch(/SameSite=None/i);
  });

  it('dura 30 días', () => {
    const { cookie } = emitirSesion('Guillermo Rojas');
    expect(cookie).toMatch(/Max-Age=2592000/);
  });

  it('acepta una sesión que ella misma emitió', () => {
    const { cookie } = emitirSesion('Guillermo Rojas');
    const valor = cookie.split(';')[0];
    expect(sesionValida(conCookie(valor))).toBe(true);
  });

  it('rechaza una cookie inventada', () => {
    expect(sesionValida(conCookie('luxe_sesion=inventado'))).toBe(false);
  });

  it('rechaza si no hay cookie', () => {
    expect(sesionValida(new Request('http://localhost/x'))).toBe(false);
  });

  it('rechaza una sesión firmada con otra clave', () => {
    const { cookie } = emitirSesion('Guillermo Rojas');
    const valor = cookie.split(';')[0];
    process.env.LUXE_SESION_SECRETO = 'otra';
    expect(sesionValida(conCookie(valor))).toBe(false);
  });

  // --- Revisión final, Crítico 1: la clave del taller ya no firma nada ---
  // `LUXE_TALLER_CLAVE` NO es un secreto de servidor: es la contraseña que un
  // humano teclea en /q7m4, viaja en el cuerpo de cada petición a /api/q7m4 y
  // queda en texto plano en `sessionStorage`. Mientras firmara esta cookie,
  // quien la conociera podía fabricarse una sesión válida a nombre de quien
  // quisiera — sin fila en `usuarios_panel`, sin `activo`, sin contador de
  // intentos. Estas dos pruebas anclan el corte: la firma sale ahora de
  // `LUXE_SESION_SECRETO`, y NO hay respaldo a la clave del taller.
  describe('LUXE_TALLER_CLAVE ya no es la llave del panel', () => {
    // Fabrica una cookie con el formato exacto que produce `emitirSesion`
    // (`<emitidoEn>.<nombre en base64url>.<firma>`), pero firmada con el
    // secreto que se le pase. Con `LUXE_TALLER_CLAVE` es exactamente lo que
    // podía armar cualquiera que hubiera usado el taller.
    function cookieFirmadaCon(secreto: string, nombre: string): string {
      const emitidoEn = String(Date.now());
      const codificado = Buffer.from(nombre, 'utf8').toString('base64url');
      const contenido = `${emitidoEn}.${codificado}`;
      const firma = createHmac('sha256', secreto).update(contenido).digest('hex');
      return `luxe_sesion=${contenido}.${firma}`;
    }

    it('una cookie firmada con LUXE_TALLER_CLAVE no valida', () => {
      process.env.LUXE_SESION_SECRETO = 'secreto-de-firma-del-panel';
      process.env.LUXE_TALLER_CLAVE = 'la-clave-que-se-teclea-en-q7m4';

      const forjada = cookieFirmadaCon(
        process.env.LUXE_TALLER_CLAVE,
        'Vendedor Despedido',
      );
      expect(sesionValida(conCookie(forjada))).toBe(false);
      expect(nombreDeSesion(conCookie(forjada))).toBeNull();
      expect(csrfDeSesion(conCookie(forjada))).toBeNull();

      // Control: la misma fábrica, con el secreto correcto, SÍ produce una
      // sesión válida. Sin esto, la prueba de arriba pasaría también si la
      // fábrica estuviera mal armada y nunca validara nada.
      const legitima = cookieFirmadaCon(
        process.env.LUXE_SESION_SECRETO,
        'Guillermo Rojas',
      );
      expect(nombreDeSesion(conCookie(legitima))).toBe('Guillermo Rojas');
    });

    it('sin LUXE_SESION_SECRETO no hay respaldo: no se emite ni se valida ninguna sesión', () => {
      process.env.LUXE_SESION_SECRETO = 'secreto-de-firma-del-panel';
      const { cookie } = emitirSesion('Guillermo Rojas');
      const valor = cookie.split(';')[0];

      delete process.env.LUXE_SESION_SECRETO;
      process.env.LUXE_TALLER_CLAVE = 'la-clave-que-se-teclea-en-q7m4';

      expect(() => emitirSesion('Guillermo Rojas')).toThrow(/LUXE_SESION_SECRETO/);
      expect(sesionValida(conCookie(valor))).toBe(false);
      expect(
        sesionValida(conCookie(cookieFirmadaCon('la-clave-que-se-teclea-en-q7m4', 'X'))),
      ).toBe(false);
    });
  });

  it('el token anti-CSRF debe coincidir con el de la sesión', () => {
    const { cookie, csrf } = emitirSesion('Guillermo Rojas');
    const valor = cookie.split(';')[0];
    expect(csrfValido(conCookie(valor), csrf)).toBe(true);
    expect(csrfValido(conCookie(valor), 'otro')).toBe(false);
    expect(csrfValido(conCookie(valor), undefined)).toBe(false);
  });

  it('la cookie lleva Partitioned (CHIPS): sin esto es de terceros dentro del iframe y Safari/Chrome pueden bloquearla', () => {
    const { cookie } = emitirSesion('Guillermo Rojas');
    expect(cookie).toMatch(/Partitioned/i);
  });

  // --- Ronda de correcciones 1 (hallazgo crítico): la sesión nunca caducaba.
  // `sesionValida` verificaba la firma pero no comparaba `emitidoEn` contra
  // la hora actual, así que una cookie firmada hace 100 días —o con fecha en
  // el año 3000— validaba igual. Con estas dos pruebas, revertir el chequeo
  // de caducidad las pone en rojo.

  describe('caducidad', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('rechaza una sesión firmada hace más de 30 días', () => {
      vi.useFakeTimers();
      const { cookie } = emitirSesion('Guillermo Rojas');
      const valor = cookie.split(';')[0];
      // 30 días + 1 segundo: justo pasado el borde de Max-Age.
      vi.advanceTimersByTime(2592000 * 1000 + 1000);
      expect(sesionValida(conCookie(valor))).toBe(false);
    });

    it('acepta una sesión firmada hace 29 días (dentro de los 30)', () => {
      vi.useFakeTimers();
      const { cookie } = emitirSesion('Guillermo Rojas');
      const valor = cookie.split(';')[0];
      vi.advanceTimersByTime(29 * 24 * 60 * 60 * 1000);
      expect(sesionValida(conCookie(valor))).toBe(true);
    });

    it('rechaza una sesión con fecha de emisión en el futuro (reloj adelantado o cookie forjada)', () => {
      vi.useFakeTimers();
      const ahoraReal = Date.now();
      vi.setSystemTime(ahoraReal + 60 * 60 * 1000); // "ahora" adelantado 1 hora.
      const { cookie } = emitirSesion('Guillermo Rojas');
      const valor = cookie.split(';')[0];
      vi.setSystemTime(ahoraReal); // vuelve al presente real: emitidoEn queda en el futuro.
      expect(sesionValida(conCookie(valor))).toBe(false);
    });

    // Ronda de correcciones final (hallazgo menor): sin tolerancia de reloj,
    // el desvío normal entre el reloj del proceso que emite la cookie y el
    // que la valida (unos pocos segundos, típico incluso con NTP) bastaría
    // para rechazar una cookie recién emitida y legítima.
    it('acepta una sesión emitida hasta 60 segundos en el futuro (tolerancia de reloj)', () => {
      vi.useFakeTimers();
      const ahoraReal = Date.now();
      vi.setSystemTime(ahoraReal + 60 * 1000); // "emitida" 60s adelantada.
      const { cookie } = emitirSesion('Guillermo Rojas');
      const valor = cookie.split(';')[0];
      vi.setSystemTime(ahoraReal);
      expect(sesionValida(conCookie(valor))).toBe(true);
    });

    it('rechaza una sesión emitida más de 60 segundos en el futuro (fuera de la tolerancia)', () => {
      vi.useFakeTimers();
      const ahoraReal = Date.now();
      vi.setSystemTime(ahoraReal + 61 * 1000); // "emitida" 61s adelantada: justo pasado el margen.
      const { cookie } = emitirSesion('Guillermo Rojas');
      const valor = cookie.split(';')[0];
      vi.setSystemTime(ahoraReal);
      expect(sesionValida(conCookie(valor))).toBe(false);
    });
  });

  // --- Ronda de correcciones 1 (Tarea 9, hallazgo crítico) ---
  describe('csrfDeSesion: deriva el token anti-CSRF de una cookie ya válida', () => {
    beforeEach(() => {
      process.env.LUXE_SESION_SECRETO = 'secreta';
    });

    it('con cookie válida, devuelve el mismo token que csrfValido acepta', () => {
      const { cookie, csrf } = emitirSesion('Guillermo Rojas');
      const valor = cookie.split(';')[0];
      const derivado = csrfDeSesion(conCookie(valor));
      expect(derivado).toBe(csrf);
      expect(csrfValido(conCookie(valor), derivado ?? undefined)).toBe(true);
    });

    it('sin cookie, devuelve null', () => {
      expect(csrfDeSesion(new Request('http://localhost/x'))).toBeNull();
    });

    it('con una cookie inventada, devuelve null (nunca inventa un token para quien no la tiene)', () => {
      expect(csrfDeSesion(conCookie('luxe_sesion=inventado'))).toBeNull();
    });

    it('con una sesión firmada con otra clave, devuelve null', () => {
      const { cookie } = emitirSesion('Guillermo Rojas');
      const valor = cookie.split(';')[0];
      process.env.LUXE_SESION_SECRETO = 'otra';
      expect(csrfDeSesion(conCookie(valor))).toBeNull();
    });
  });
});

// Ayuda: convierte la cabecera Set-Cookie en una cabecera Cookie de petición.
function pedirCon(cookie: string): Request {
  const valor = cookie.split(';')[0];
  return new Request('https://luxeessentialscr.com/api/cotizacion/listado', {
    headers: { cookie: valor },
  });
}

describe('la sesión recuerda al vendedor', () => {
  it('devuelve el nombre con el que se emitió', () => {
    const { cookie } = emitirSesion('Guillermo Rojas');
    expect(nombreDeSesion(pedirCon(cookie))).toBe('Guillermo Rojas');
  });

  it('conserva tildes y eñes', () => {
    const { cookie } = emitirSesion('José Peña');
    expect(nombreDeSesion(pedirCon(cookie))).toBe('José Peña');
  });

  it('rechaza una cookie con el nombre alterado', () => {
    const { cookie } = emitirSesion('Guillermo Rojas');
    const valor = cookie.split(';')[0].split('=')[1];
    const [emitido, , firma] = valor.split('.');
    const otro = Buffer.from('Gerente General', 'utf8').toString('base64url');
    const falsa = `luxe_sesion=${emitido}.${otro}.${firma}`;
    const req = new Request('https://luxeessentialscr.com/x', { headers: { cookie: falsa } });
    expect(nombreDeSesion(req)).toBeNull();
    expect(sesionValida(req)).toBe(false);
  });

  // Las cookies del formato viejo (`<emitidoEn>.<firma>`) no traen vendedor.
  // Aceptarlas dejaría entrar con la clave compartida a quien tuviera una
  // guardada, que es justo el hueco que esta fase cierra.
  it('rechaza una cookie del formato anterior, de dos partes', () => {
    const req = new Request('https://luxeessentialscr.com/x', {
      headers: { cookie: 'luxe_sesion=1756000000000.deadbeef' },
    });
    expect(sesionValida(req)).toBe(false);
    expect(nombreDeSesion(req)).toBeNull();
  });

  it('no emite una sesión sin nombre', () => {
    expect(() => emitirSesion('')).toThrow();
    expect(() => emitirSesion('   ')).toThrow();
  });

  it('sigue entregando el token anti-CSRF de la sesión', () => {
    const { cookie, csrf } = emitirSesion('Guillermo Rojas');
    expect(csrfDeSesion(pedirCon(cookie))).toBe(csrf);
  });
});
