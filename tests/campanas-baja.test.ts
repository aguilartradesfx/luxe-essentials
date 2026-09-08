// tests/campanas-baja.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  normalizarCorreo,
  generarTokenBaja,
  correoDeToken,
  enlacePaginaBaja,
  enlaceUnClicBaja,
  cabecerasListaBaja,
} from '@/lib/campanas/baja';

describe('normalizarCorreo', () => {
  it('recorta espacios y pasa a minúsculas', () => {
    expect(normalizarCorreo('  Ana@Hotel.com  ')).toBe('ana@hotel.com');
  });
});

describe('generarTokenBaja / correoDeToken', () => {
  beforeEach(() => {
    process.env.LUXE_BAJA_SECRETO = 'secreta-de-baja';
  });

  it('acepta un token que ella misma generó', () => {
    const token = generarTokenBaja('ana@hotel.com');
    expect(correoDeToken(token)).toBe('ana@hotel.com');
  });

  it('normaliza el correo al generar: mayúsculas y espacios producen el mismo correo verificado', () => {
    const token = generarTokenBaja('  Ana@Hotel.com  ');
    expect(correoDeToken(token)).toBe('ana@hotel.com');
  });

  it('sin LUXE_BAJA_SECRETO, no genera ningún token', () => {
    delete process.env.LUXE_BAJA_SECRETO;
    expect(() => generarTokenBaja('ana@hotel.com')).toThrow(/LUXE_BAJA_SECRETO/);
  });

  it('sin correo, no genera ningún token', () => {
    expect(() => generarTokenBaja('   ')).toThrow(/correo/i);
  });

  it('rechaza un token inventado', () => {
    expect(correoDeToken('esto-no-es-un-token-valido')).toBeNull();
  });

  it('rechaza si no hay token', () => {
    expect(correoDeToken('')).toBeNull();
  });

  it('sin LUXE_BAJA_SECRETO configurada, no valida ningún token, aunque el token sea legítimo', () => {
    const token = generarTokenBaja('ana@hotel.com');
    delete process.env.LUXE_BAJA_SECRETO;
    expect(correoDeToken(token)).toBeNull();
  });

  // Sin LUXE_BAJA_SECRETO configurada, `firmar()` igual "funciona": calcula
  // HMAC con una clave vacía, y HMAC-SHA256 con clave vacía es una función
  // perfectamente pública -- cualquiera puede calcularla sin saber ningún
  // secreto. Sin el corte explícito por "no hay secreto configurado", un
  // token FORJADO con esa clave vacía (mismo cálculo que haría el propio
  // `firmar()`) pasaría la comparación de todos modos. Esta prueba arma ese
  // token a mano, sin pasar nunca por `generarTokenBaja`, para separar "la
  // firma coincide" de "hay de verdad un secreto configurado en el
  // servidor".
  it('sin LUXE_BAJA_SECRETO, un token forjado con la clave vacía tampoco valida', () => {
    delete process.env.LUXE_BAJA_SECRETO;
    const codificado = Buffer.from('atacante@evil.com', 'utf8').toString('base64url');
    const firmaConClaveVacia = createHmac('sha256', '').update(codificado).digest('hex');
    expect(correoDeToken(`${codificado}.${firmaConClaveVacia}`)).toBeNull();
  });

  it('un token firmado con otra clave no valida (rotación de LUXE_BAJA_SECRETO)', () => {
    const token = generarTokenBaja('ana@hotel.com');
    process.env.LUXE_BAJA_SECRETO = 'otra-clave-distinta';
    expect(correoDeToken(token)).toBeNull();
  });

  // Mata el mutante que compara sólo la LONGITUD de la firma, o que use
  // `===` en vez de una comparación de verdad: un carácter distinto en la
  // firma tiene que alcanzar para rechazar el token entero.
  it('un solo carácter distinto en la firma invalida el token entero', () => {
    const token = generarTokenBaja('ana@hotel.com');
    const [codificado, firma] = token.split('.');
    const primerCaracter = firma[0] === 'a' ? 'b' : 'a';
    const firmaAlterada = primerCaracter + firma.slice(1);
    expect(correoDeToken(`${codificado}.${firmaAlterada}`)).toBeNull();
  });

  // Mata el mutante que verifica la firma pero después decodifica el correo
  // de un valor distinto al que realmente firmó (o que ignora el payload por
  // completo): alterar el correo codificado, SIN volver a firmar, tiene que
  // invalidar el token — la firma vieja ya no corresponde al payload nuevo.
  it('alterar el correo codificado sin volver a firmar invalida el token', () => {
    const tokenAna = generarTokenBaja('ana@hotel.com');
    const tokenOtro = generarTokenBaja('otro@hotel.com');
    const [, firmaAna] = tokenAna.split('.');
    const [codificadoOtro] = tokenOtro.split('.');
    // Payload de "otro@hotel.com" con la firma de "ana@hotel.com": ninguna
    // de las dos firmas legítimas corresponde a esta combinación.
    expect(correoDeToken(`${codificadoOtro}.${firmaAna}`)).toBeNull();
  });

  // Ancla el algoritmo de firma en sí (HMAC-SHA256 sobre el correo
  // codificado en base64url) contra una implementación de referencia
  // calculada a mano en la prueba, para que un cambio silencioso de
  // algoritmo o de qué se firma se note acá.
  it('firma con HMAC-SHA256 sobre el correo codificado en base64url', () => {
    const correo = 'ana@hotel.com';
    const codificadoEsperado = Buffer.from(correo, 'utf8').toString('base64url');
    const firmaEsperada = createHmac('sha256', 'secreta-de-baja').update(codificadoEsperado).digest('hex');
    const token = generarTokenBaja(correo);
    expect(token).toBe(`${codificadoEsperado}.${firmaEsperada}`);
  });

  it('rechaza un token con más o menos de dos partes', () => {
    const token = generarTokenBaja('ana@hotel.com');
    expect(correoDeToken(`${token}.algo-de-mas`)).toBeNull();
    expect(correoDeToken(token.split('.')[0] ?? '')).toBeNull();
  });

  it('rechaza base64url no canónico aunque la firma sea correcta (viaje de ida y vuelta)', () => {
    // 'ab' decodifica a 'i' (bits sobrantes descartados), pero re-codificar
    // 'i' da 'aQ', no 'ab': un `codificado` con bits de relleno distintos de
    // cero puede tener una firma perfectamente válida para sí mismo y
    // todavía no ser la codificación canónica de ningún correo real.
    // Firmarlo y validarlo sin el chequeo de ida y vuelta aceptaría basura.
    const codificadoNoCanonico = 'ab';
    const firma = createHmac('sha256', 'secreta-de-baja').update(codificadoNoCanonico).digest('hex');
    expect(correoDeToken(`${codificadoNoCanonico}.${firma}`)).toBeNull();
  });
});

describe('enlaces', () => {
  beforeEach(() => {
    process.env.LUXE_BAJA_SECRETO = 'secreta-de-baja';
    process.env.NEXT_PUBLIC_SITE_URL = 'https://luxeessentialscr.com';
  });

  it('enlacePaginaBaja apunta a /baja con el token, y ese token verifica al mismo correo', () => {
    const url = enlacePaginaBaja('ana@hotel.com');
    expect(url).toMatch(/^https:\/\/luxeessentialscr\.com\/baja\?t=/);
    const token = new URL(url).searchParams.get('t') ?? '';
    expect(correoDeToken(token)).toBe('ana@hotel.com');
  });

  it('enlaceUnClicBaja apunta a /api/baja (no a /baja), con un token que también verifica', () => {
    const url = enlaceUnClicBaja('ana@hotel.com');
    expect(url).toMatch(/^https:\/\/luxeessentialscr\.com\/api\/baja\?t=/);
    const token = new URL(url).searchParams.get('t') ?? '';
    expect(correoDeToken(token)).toBe('ana@hotel.com');
  });

  it('cabecerasListaBaja arma List-Unsubscribe entre <> y List-Unsubscribe-Post fijo', () => {
    const cabeceras = cabecerasListaBaja('ana@hotel.com');
    expect(cabeceras['List-Unsubscribe']).toMatch(/^<https:\/\/luxeessentialscr\.com\/api\/baja\?t=.+>$/);
    expect(cabeceras['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });
});
