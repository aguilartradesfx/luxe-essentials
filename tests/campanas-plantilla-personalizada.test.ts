// tests/campanas-plantilla-personalizada.test.ts
//
// Punto 3 del encargo ("plantilla personalizada"): el blindaje sobre el
// HTML pegado a mano. Tres cosas se prueban acá, en el mismo orden que las
// pide el encargo:
//   1. `{{unsubscribe_url}}` es OBLIGATORIO -- nunca se inyecta solo.
//   2. Lo que no debería viajar en un correo (`<script>`, formularios,
//      recursos externos que no sean imágenes) se quita, con un aviso de
//      qué se quitó.
//   3. La firma de "ya se previsualizó" es real -- distinta para cada
//      asunto+html, y sólo válida para el contenido exacto que la generó.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  validarMarcadorBaja,
  sanitizarHtmlPersonalizado,
  firmarPrevisualizacion,
  previsualizacionValida,
} from '@/lib/campanas/plantilla-personalizada';

describe('validarMarcadorBaja', () => {
  it('ok cuando el html trae {{unsubscribe_url}}', () => {
    const r = validarMarcadorBaja('<a href="{{unsubscribe_url}}">Darse de baja</a>');
    expect(r).toEqual({ ok: true });
  });

  // La prueba que más importa de todo este encargo, según el propio dueño:
  // "si alguien afloja la exigencia del enlace de baja, ¿se pone roja
  // alguna prueba?". Mata al mutante que devolviera `{ ok: true }` siempre,
  // o que cambiara `MARCADOR_BAJA` por una cadena vacía (que "incluye"
  // cualquier html), o que invirtiera la condición.
  it('rechaza un html que no trae el marcador -- con un error que explica por qué', () => {
    const r = validarMarcadorBaja('<p>Hola, esto no tiene enlace de baja.</p>');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('{{unsubscribe_url}}');
      expect(r.error.toLowerCase()).toContain('baja');
    }
  });

  it('un marcador mal escrito (sin las dos llaves, con espacio adentro) no cuenta -- no es un match parcial', () => {
    expect(validarMarcadorBaja('{{ unsubscribe_url }}').ok).toBe(false);
    expect(validarMarcadorBaja('{unsubscribe_url}').ok).toBe(false);
    expect(validarMarcadorBaja('unsubscribe_url').ok).toBe(false);
  });
});

describe('sanitizarHtmlPersonalizado', () => {
  it('un html inocente sale exactamente igual, sin advertencias', () => {
    const html = '<p>Buenos días. <a href="{{unsubscribe_url}}">Darse de baja</a></p>';
    const r = sanitizarHtmlPersonalizado(html);
    expect(r.html).toBe(html);
    expect(r.advertencias).toEqual([]);
  });

  it('deja pasar <img> con un recurso externo -- "que no sean imágenes" es la excepción explícita', () => {
    const html = '<img src="https://cdn.example.com/foto.png" alt="Uniformes">';
    const r = sanitizarHtmlPersonalizado(html);
    expect(r.html).toBe(html);
    expect(r.advertencias).toEqual([]);
  });

  it('quita un <script>...</script> entero, con su contenido, y avisa', () => {
    const r = sanitizarHtmlPersonalizado('<p>Hola</p><script>fetch("https://evil.example");</script><p>Chau</p>');
    expect(r.html).not.toContain('<script');
    expect(r.html).not.toContain('evil.example');
    expect(r.html).toBe('<p>Hola</p><p>Chau</p>');
    expect(r.advertencias.some((a) => a.includes('<script>'))).toBe(true);
  });

  it('quita un <script src="..."> suelto (sin cierre)', () => {
    const r = sanitizarHtmlPersonalizado('<p>Hola</p><script src="https://evil.example/x.js">');
    expect(r.html).not.toContain('<script');
    expect(r.html).not.toContain('evil.example');
  });

  it('quita un <form>...</form> entero, con su contenido, y avisa', () => {
    const r = sanitizarHtmlPersonalizado('<form action="/x"><input name="correo"><button>Enviar</button></form>');
    expect(r.html).not.toContain('<form');
    expect(r.html).not.toContain('<input');
    expect(r.advertencias.some((a) => a.includes('<form>'))).toBe(true);
  });

  it('quita <iframe>, <object>, <video>, <audio> -- recursos externos que no son imágenes', () => {
    const html =
      '<iframe src="https://evil.example"></iframe>' +
      '<object data="https://evil.example/x.swf"></object>' +
      '<video src="https://evil.example/x.mp4"></video>' +
      '<audio src="https://evil.example/x.mp3"></audio>';
    const r = sanitizarHtmlPersonalizado(html);
    expect(r.html).toBe('');
    expect(r.advertencias.some((a) => a.includes('<iframe>'))).toBe(true);
    expect(r.advertencias.some((a) => a.includes('<object>'))).toBe(true);
    expect(r.advertencias.some((a) => a.includes('<video>'))).toBe(true);
    expect(r.advertencias.some((a) => a.includes('<audio>'))).toBe(true);
  });

  it('quita <embed>, <link>, <base> -- etiquetas vacías, sin cierre', () => {
    const html =
      '<embed src="https://evil.example/x.swf">' +
      '<link rel="stylesheet" href="https://evil.example/x.css">' +
      '<base href="https://evil.example/">';
    const r = sanitizarHtmlPersonalizado(html);
    expect(r.html).toBe('');
    expect(r.advertencias.some((a) => a.includes('<embed>'))).toBe(true);
    expect(r.advertencias.some((a) => a.includes('<link>'))).toBe(true);
    expect(r.advertencias.some((a) => a.includes('<base>'))).toBe(true);
  });

  it('quita <meta http-equiv="refresh"> (redirección) pero conserva un <meta charset> normal', () => {
    const html = '<meta charset="utf-8"><meta http-equiv="refresh" content="0;url=https://evil.example">';
    const r = sanitizarHtmlPersonalizado(html);
    expect(r.html).toBe('<meta charset="utf-8">');
    expect(r.advertencias.some((a) => a.includes('meta'))).toBe(true);
  });

  it('quita atributos de evento en línea (onclick, onerror...) en cualquier estilo de comillas', () => {
    const html =
      '<img src="x.png" onerror="fetch(\'https://evil.example\')">' +
      "<button onclick='alert(1)'>Click</button>" +
      '<div onmouseover=roba()>hola</div>';
    const r = sanitizarHtmlPersonalizado(html);
    expect(r.html).not.toMatch(/on\w+\s*=/i);
    expect(r.html).toContain('<img src="x.png">');
    expect(r.advertencias.some((a) => a.includes('evento en línea'))).toBe(true);
  });

  it('neutraliza href="javascript:..." y src="vbscript:..." (esquemas ejecutables)', () => {
    const html =
      '<a href="javascript:alert(1)">Click acá</a>' +
      "<a href='JAVASCRIPT:alert(2)'>Click</a>" +
      '<img src="vbscript:msgbox(1)">';
    const r = sanitizarHtmlPersonalizado(html);
    expect(r.html).not.toContain('javascript:');
    expect(r.html).not.toMatch(/javascript\s*:/i);
    expect(r.html).not.toContain('vbscript:');
    expect(r.advertencias.some((a) => a.includes('javascript:/vbscript:'))).toBe(true);
  });

  it('un href="{{unsubscribe_url}}" normal no se toca -- no es un esquema ejecutable', () => {
    const html = '<a href="{{unsubscribe_url}}">Darse de baja</a>';
    const r = sanitizarHtmlPersonalizado(html);
    expect(r.html).toBe(html);
  });

  it('combina varias amenazas a la vez y las quita todas, dejando el resto intacto', () => {
    const html =
      '<p>Buenos días{{nombre}}: gracias por su interés.</p>' +
      '<script>document.location="https://evil.example"</script>' +
      '<form action="https://evil.example/robar"><input name="tarjeta"></form>' +
      '<img src="https://cdn.luxe.cr/logo.png" alt="Luxe">' +
      '<a href="{{unsubscribe_url}}">Darse de baja</a>';
    const r = sanitizarHtmlPersonalizado(html);
    expect(r.html).toContain('Buenos días{{nombre}}: gracias por su interés.');
    expect(r.html).toContain('<img src="https://cdn.luxe.cr/logo.png" alt="Luxe">');
    expect(r.html).toContain('<a href="{{unsubscribe_url}}">Darse de baja</a>');
    expect(r.html).not.toContain('<script');
    expect(r.html).not.toContain('<form');
    expect(r.advertencias.length).toBeGreaterThanOrEqual(2);
  });
});

describe('firmarPrevisualizacion / previsualizacionValida', () => {
  beforeEach(() => {
    process.env.LUXE_BAJA_SECRETO = 'secreta-de-prueba';
  });

  it('la firma de un asunto+html es válida para ese mismo asunto+html', () => {
    const firma = firmarPrevisualizacion('Asunto', '<p>Hola {{unsubscribe_url}}</p>');
    expect(previsualizacionValida('Asunto', '<p>Hola {{unsubscribe_url}}</p>', firma)).toBe(true);
  });

  // El corazón de "imposible mandar sin haber previsualizado": editar el
  // html (o el asunto) después de previsualizar invalida la firma vieja --
  // hay que previsualizar de nuevo.
  it('la firma deja de valer si el html cambia un solo carácter', () => {
    const firma = firmarPrevisualizacion('Asunto', '<p>Hola {{unsubscribe_url}}</p>');
    expect(previsualizacionValida('Asunto', '<p>Hola! {{unsubscribe_url}}</p>', firma)).toBe(false);
  });

  it('la firma deja de valer si el asunto cambia', () => {
    const firma = firmarPrevisualizacion('Asunto original', '<p>Hola {{unsubscribe_url}}</p>');
    expect(previsualizacionValida('Asunto editado', '<p>Hola {{unsubscribe_url}}</p>', firma)).toBe(false);
  });

  it('una firma inventada (no generada por firmarPrevisualizacion) no vale', () => {
    expect(previsualizacionValida('Asunto', '<p>Hola {{unsubscribe_url}}</p>', 'firma-inventada')).toBe(false);
  });

  it('sin LUXE_BAJA_SECRETO configurada, ninguna firma vale -- ni siquiera una calculada con la clave vacía', () => {
    delete process.env.LUXE_BAJA_SECRETO;
    const firma = firmarPrevisualizacion('Asunto', '<p>Hola</p>');
    expect(previsualizacionValida('Asunto', '<p>Hola</p>', firma)).toBe(false);
  });

  it('una firma vacía nunca vale, aunque LUXE_BAJA_SECRETO esté configurada', () => {
    expect(previsualizacionValida('Asunto', '<p>Hola</p>', '')).toBe(false);
  });
});
