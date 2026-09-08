// tests/campanas-marcadores.test.ts
import { describe, it, expect } from 'vitest';
import {
  escaparHtml,
  pareceNombrePersona,
  marcadorNombre,
  renderizarPlantilla,
} from '@/lib/campanas/marcadores';

describe('escaparHtml', () => {
  it('escapa &, <, >, "', () => {
    expect(escaparHtml('a & b < c > d " e')).toBe('a &amp; b &lt; c &gt; d &quot; e');
  });

  it('deja intacto un texto sin caracteres especiales', () => {
    expect(escaparHtml('Hotel Papagayo')).toBe('Hotel Papagayo');
  });
});

describe('pareceNombrePersona', () => {
  // Los tres ejemplos exactos del diseño
  // (docs/superpowers/specs/2026-09-08-campanas-design.md): el campo casi
  // siempre trae el nombre del negocio en esta base, y estos son los
  // ejemplos que el propio diseño cita como "no es una persona".
  it.each([
    ['supermercado poval'],
    ['restaurante ardere'],
    ['cafe rojo'],
  ])('"%s" no parece una persona (ejemplo del diseño)', (nombre) => {
    expect(pareceNombrePersona(nombre)).toBe(false);
  });

  it('un nombre y apellido, sin nada raro, sí parece una persona', () => {
    expect(pareceNombrePersona('Ana Rodríguez')).toBe(true);
  });

  it('nombre + dos apellidos (tres palabras) también parece una persona', () => {
    expect(pareceNombrePersona('Marco Antonio Herrera')).toBe(true);
  });

  it('con tildes y eñe sigue pareciendo una persona', () => {
    expect(pareceNombrePersona('Iñaki Muñoz')).toBe(true);
  });

  it('una sola palabra no alcanza (ambiguo): genérico', () => {
    expect(pareceNombrePersona('Ana')).toBe(false);
  });

  it('cuatro palabras o más: genérico', () => {
    expect(pareceNombrePersona('Hotel y Restaurante El Bosque')).toBe(false);
  });

  // Límite exacto: CUATRO palabras, ninguna en la lista de negocio. Mata el
  // mutante que corriera el límite de ">3" a ">4" -- con ese corrido, este
  // nombre (que no tiene ningún indicador de negocio) pasaría a "sí parece
  // persona" por error.
  it('exactamente cuatro palabras limpias (sin indicador de negocio): igual genérico', () => {
    expect(pareceNombrePersona('Juan Carlos Perez Solano')).toBe(false);
  });

  it('vacío o sólo espacios: genérico', () => {
    expect(pareceNombrePersona('')).toBe(false);
    expect(pareceNombrePersona('   ')).toBe(false);
  });

  it('un sufijo legal (S.A.) en la tercera palabra: genérico', () => {
    expect(pareceNombrePersona('Distribuidora Central SA')).toBe(false);
  });

  it('un token con dígitos: genérico', () => {
    expect(pareceNombrePersona('Soda 2000')).toBe(false);
  });

  // Mata el mutante que compararía el indicador de negocio como substring
  // del nombre completo en vez de por palabra exacta: "Barrantes" contiene
  // "bar" como substring, pero es un apellido real y no debe marcarse
  // como negocio.
  it('un apellido que CONTIENE un indicador de negocio como substring no se marca como negocio', () => {
    expect(pareceNombrePersona('Ana Barrantes')).toBe(true);
  });

  it('un apellido compuesto con guión no pasa el chequeo de "sólo letras": genérico', () => {
    expect(pareceNombrePersona('Ana Solís-Vindas')).toBe(false);
  });

  it('cualquier palabra de la lista de negocio en cualquier posición marca genérico', () => {
    expect(pareceNombrePersona('Hotel Papagayo')).toBe(false);
    expect(pareceNombrePersona('Papagayo Hotel')).toBe(false);
  });
});

describe('marcadorNombre', () => {
  it('para un nombre que parece persona, devuelve ", PrimerNombre" (con la coma DENTRO)', () => {
    expect(marcadorNombre('ana rodríguez')).toBe(', Ana');
  });

  it('para un nombre genérico, devuelve la cadena vacía -- nunca un saludo cojo', () => {
    expect(marcadorNombre('supermercado poval')).toBe('');
  });

  it('capitaliza el primer nombre aunque venga en minúsculas', () => {
    expect(marcadorNombre('ana rodríguez')).toContain('Ana');
    expect(marcadorNombre('ana rodríguez')).not.toContain('ana ');
  });

  it('capitaliza aunque el primer nombre empiece con una letra acentuada', () => {
    expect(marcadorNombre('ítalo rodríguez')).toBe(', Ítalo');
  });
});

describe('renderizarPlantilla', () => {
  const datos = { nombreCrm: 'Ana Rodríguez', unsubscribeUrl: 'https://luxeessentialscr.com/baja?t=abc' };

  it('sustituye los tres marcadores', () => {
    const html = 'Hola{{nombre}}, de {{empresa}}. Baja: {{unsubscribe_url}}';
    const resultado = renderizarPlantilla(html, datos);
    expect(resultado).toBe(
      'Hola, Ana, de Ana Rodríguez. Baja: https://luxeessentialscr.com/baja?t=abc',
    );
  });

  it('reemplaza TODAS las apariciones repetidas del mismo marcador, no sólo la primera', () => {
    const html = '{{empresa}} ... {{empresa}} ... {{empresa}}';
    const resultado = renderizarPlantilla(html, datos);
    expect(resultado).toBe('Ana Rodríguez ... Ana Rodríguez ... Ana Rodríguez');
  });

  it('{{empresa}} lleva el nombre TAL CUAL del CRM, sin la heurística de persona', () => {
    const html = '{{empresa}}';
    expect(renderizarPlantilla(html, { ...datos, nombreCrm: 'supermercado poval' })).toBe(
      'supermercado poval',
    );
  });

  it('con un nombre de negocio, {{nombre}} se resuelve vacío pero {{empresa}} conserva el nombre', () => {
    const html = 'Buenos días{{nombre}}: le escribimos de parte de {{empresa}}.';
    const resultado = renderizarPlantilla(html, { ...datos, nombreCrm: 'supermercado poval' });
    expect(resultado).toBe('Buenos días: le escribimos de parte de supermercado poval.');
    // Sin coma suelta ni doble espacio -- el "saludo cojo" que el diseño
    // pide evitar.
    expect(resultado).not.toMatch(/días\s*,\s*:/);
    expect(resultado).not.toContain('días  :');
  });

  it('escapa un nombre malicioso antes de interpolarlo en {{empresa}}: no se puede inyectar una etiqueta', () => {
    const payload = '</p><a/href=https://sitio-falso.cr>Reclamá</a><p>';
    const html = 'De: {{empresa}}';
    const resultado = renderizarPlantilla(html, { ...datos, nombreCrm: payload });
    expect(resultado).not.toMatch(/<a\/href=https:\/\/sitio-falso\.cr/i);
    expect(resultado).toContain('&lt;/p&gt;&lt;a/href=https://sitio-falso.cr&gt;');
  });

  it('escapa el enlace de baja antes de interpolarlo', () => {
    const html = '{{unsubscribe_url}}';
    const resultado = renderizarPlantilla(html, {
      ...datos,
      unsubscribeUrl: 'https://x.cr/baja?t=a&b="raro"',
    });
    expect(resultado).toBe('https://x.cr/baja?t=a&amp;b=&quot;raro&quot;');
  });

  it('un html sin ningún marcador vuelve sin cambios', () => {
    expect(renderizarPlantilla('texto plano sin marcadores', datos)).toBe(
      'texto plano sin marcadores',
    );
  });
});
