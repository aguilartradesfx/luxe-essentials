// Convierte `Database/00_Indice_Rutas_Luxe_2026.xlsx` en CSV listo para importar
// a GoHighLevel. Lee la hoja `Base consolidada` (encabezados en la fila 3) y
// aplica las limpiezas que la importación de GHL no hace sola: teléfonos a
// E.164, emails múltiples separados, placeholders vaciados y campos derivados.
//
// Uso: node scripts/preparar-base-ghl.mjs
// Salida: out/ghl/base-ghl.csv y out/ghl/por-zona/<zona>.csv

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const ORIGEN = 'Database/00_Indice_Rutas_Luxe_2026.xlsx';
const SALIDA = 'out/ghl';

// Números que el ERP usa como relleno cuando no hay teléfono real. Si entran a
// GHL tal cual, la deduplicación los colapsa todos en un solo contacto.
const TELEFONOS_RELLENO = new Set([
  '88888888', '8888888', '888888888', '8888888888888',
  '00000000', '99999999', '12345678', '999999999', '88888',
]);
const SIN_DATO = new Set(['', 'ND', 'N/D', 'NA', 'NT', '.', '-']);
// GHL devuelve 422 con el punto pegado a la arroba, los puntos consecutivos y
// los TLD de una sola letra. No se filtran tildes ni eñes: la base trae
// dominios y buzones acentuados que la plataforma acepta sin problema.
// El TLD se ancla a letras: la base trae comentarios pegados al dominio como
// `ivonne@gruporello.com(pagos)`, que un `no-punto-no-arroba` deja pasar.
const EMAIL_RE = /^[^\s@.](?:[^\s@]*[^\s@.])?@(?:[^\s@.]+\.)+\p{L}{2,}$/u;
const emailValido = (s) => EMAIL_RE.test(s) && !s.includes('..');

const vacio = (v) => v === null || v === undefined || SIN_DATO.has(String(v).trim().toUpperCase());
const texto = (v) => (vacio(v) ? '' : String(v).trim());

// El ERP incrusta marcadores contables en la razón social: `-PAGOS-`, `(TK)`,
// `**CUENTA PAGOS**`. Sirven para facturación, no para hablarle al cliente.
function limpiarNombre(nombre) {
  return String(nombre ?? '')
    .replace(/\*+/g, ' ')
    .replace(/-?\s*(PAGOS|CUENTA MAESTRA|CUENTA PAGOS)\s*-?/gi, ' ')
    .replace(/\((TK|PAGOS)\)/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s,;-]+$/, '')
    .trim();
}

function esContable(nombre) {
  return /PAGOS|CUENTA MAESTRA|\(TK\)|CLIENTE CONTADO|TEST\s/i.test(String(nombre ?? ''));
}

// Devuelve { principal, adicionales, invalido }. GHL sólo acepta una dirección
// en el campo nativo; el resto se preserva en `emails_adicionales`.
function partirEmails(bruto) {
  if (vacio(bruto)) return { principal: '', adicionales: '', invalido: false };
  const partes = String(bruto)
    .split(/[;,/]|\s+/)
    .map((p) => p.trim())
    // El ERP antepone etiquetas al correo (`facturas:x@y.com`). El prefijo es
    // ruido de captura, no parte de la dirección.
    .map((p) => p.replace(/^[A-Za-z ]{2,20}:(?=\S+@)/, ''))
    .filter(Boolean);
  const validos = partes.filter((p) => emailValido(p));
  if (validos.length === 0) return { principal: '', adicionales: '', invalido: true };
  return {
    principal: validos[0].toLowerCase(),
    adicionales: validos.slice(1).map((e) => e.toLowerCase()).join('; '),
    invalido: validos.length < partes.length,
  };
}

// Costa Rica: 8 dígitos nacionales. GHL necesita E.164 o no envía SMS ni WhatsApp.
function normalizarTelefono(bruto) {
  if (vacio(bruto)) return { numero: '', relleno: false, invalido: false };
  const digitos = String(bruto).replace(/\D/g, '');
  if (TELEFONOS_RELLENO.has(digitos)) return { numero: '', relleno: true, invalido: false };
  if (digitos.length === 8) return { numero: `+506${digitos}`, relleno: false, invalido: false };
  if (digitos.length === 11 && digitos.startsWith('506')) {
    return { numero: `+506${digitos.slice(3)}`, relleno: false, invalido: false };
  }
  // Números extranjeros (proveedores, dueños fuera del país) que ya vienen con
  // indicativo. Se conservan; cualquier otra cosa es basura.
  if (String(bruto).trim().startsWith('+') && digitos.length >= 10 && digitos.length <= 15) {
    return { numero: `+${digitos}`, relleno: false, invalido: false };
  }
  return { numero: '', relleno: false, invalido: true };
}

// El ERP escribe `Alias/dirección`; el desplegable en GHL se llama
// `Alias y dirección`. Sin este mapeo la importación deja el campo vacío.
const CRITERIO_GHL = {
  'Dirección': 'Dirección',
  'Alias/dirección': 'Alias y dirección',
  'Sin coincidencia': 'Sin coincidencia',
};

function tipoContribuyente(cedula) {
  const s = texto(cedula);
  if (!s) return 'Sin dato';
  const d = s.replace(/\D/g, '');
  if (d.startsWith('3101')) return 'Jurídica S.A.';
  if (d.startsWith('3102')) return 'Jurídica S.R.L.';
  if (d.startsWith('310')) return 'Otra jurídica';
  if (d.length === 9) return 'Física';
  return 'Sin dato';
}

const slug = (s) =>
  String(s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// --- lectura del xlsx (openpyxl vía python, ya disponible en el entorno) ---
const filas = JSON.parse(
  execFileSync('python3', ['-c', `
import openpyxl, json, sys
wb = openpyxl.load_workbook(${JSON.stringify(ORIGEN)}, read_only=True, data_only=True)
ws = wb["Base consolidada"]
out = []
for r in ws.iter_rows(min_row=4, values_only=True):
    if any(c is not None for c in r):
        out.append([None if c is None else str(c) for c in r])
json.dump(out, sys.stdout)
`], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }),
);

const COLUMNAS = [
  'First Name', 'Last Name', 'Company Name', 'Email', 'Phone',
  'Address', 'City', 'Country', 'Source', 'Tags',
  'Cédula / Contribuyente', 'Tipo de contribuyente', 'Canal comercial', 'Estado en ERP',
  'ID origen ERP', 'Zona comercial', 'Subzona / ruta', 'Código de ruta',
  'Orden sugerido de visita', 'Confianza de ubicación', 'Criterio de ubicación',
  'Observaciones de ubicación', 'Dirección original ERP', 'Emails adicionales',
  'Teléfono alternativo', 'Calidad del dato', 'Segmento de negocio',
  'Fecha de próxima visita', 'Origen del registro',
];

const stats = { total: 0, sinEmail: 0, sinTel: 0, relleno: 0, emailInvalido: 0, telInvalido: 0, contable: 0, sinDireccion: 0, emailCompartido: 0 };
const registros = [];
const usoEmail = new Map();
const usoTel = new Map();

for (const f of filas) {
  const [filaOrigen, nombre, cedula, estado, email, alias, canal, tel, dirOriginal, dirNorm,
         zona, subzona, ruta, orden, confianza, criterio, observaciones] = f;

  const { principal, adicionales, invalido: emailRaro } = partirEmails(email);
  const { numero, relleno, invalido: telRaro } = normalizarTelefono(tel);

  const nombreLimpio = limpiarNombre(alias && !vacio(alias) ? alias : nombre) || limpiarNombre(nombre);
  const direccion = texto(dirNorm).length >= 8 ? texto(dirNorm) : '';
  const sinRuta = texto(ruta) === 'SIN RUTA — REVISAR';
  const codigo = sinRuta ? 'SIN RUTA' : texto(ruta).split('|')[0].trim();

  let calidad = 'Completo';
  if (relleno) calidad = 'Dato placeholder';
  else if (!principal && !numero) calidad = 'Falta email y teléfono';
  else if (!principal) calidad = 'Falta email';
  else if (!numero) calidad = 'Falta teléfono';
  else if (!direccion) calidad = 'Dirección insuficiente';

  const tags = ['origen-erp-2026'];
  tags.push(canal === 'ON' ? 'canal-on-premise' : 'canal-off-premise');
  tags.push(`zona-${slug(zona)}`);
  if (confianza === 'Media') tags.push('ubicacion-confirmar');
  if (confianza === 'Baja') tags.push('ubicacion-sin-datos');
  if (!principal) tags.push('sin-email');
  if (!numero) tags.push('sin-telefono');
  if (relleno) tags.push('telefono-placeholder');
  if (emailRaro) tags.push('email-formato-revisar');
  if (telRaro) tags.push('telefono-invalido');
  if (!direccion) tags.push('sin-direccion');
  if (esContable(nombre)) { tags.push('no-prospectar'); stats.contable++; }

  stats.total++;
  if (!principal) stats.sinEmail++;
  if (!numero) stats.sinTel++;
  if (relleno) stats.relleno++;
  if (emailRaro) stats.emailInvalido++;
  if (telRaro) stats.telInvalido++;
  if (!direccion) stats.sinDireccion++;
  if (principal) usoEmail.set(principal, (usoEmail.get(principal) ?? 0) + 1);
  if (numero) usoTel.set(numero, (usoTel.get(numero) ?? 0) + 1);

  registros.push({
    zonaSlug: slug(zona),
    email: principal,
    telefono: numero,
    tags,
    fila: [
      nombreLimpio, '', texto(nombre), principal, numero,
      direccion, sinRuta ? '' : texto(subzona), 'CR', 'Base ERP 2026', '',
      texto(cedula), tipoContribuyente(cedula),
      canal === 'ON' ? 'On-Premise (HORECA)' : 'Off-Premise (Retail)',
      texto(estado), texto(filaOrigen), texto(zona),
      texto(subzona), codigo, texto(orden), texto(confianza), CRITERIO_GHL[texto(criterio)] ?? texto(criterio),
      texto(observaciones), texto(dirOriginal), adicionales,
      '', calidad, 'Por clasificar', '', 'Base ERP 2026',
    ],
  });
}

// Marcar identificadores compartidos: son los que la deduplicación de GHL
// fusionaría si se deja activa.
for (const r of registros) {
  if (r.email && usoEmail.get(r.email) > 1) { r.tags.push('email-compartido'); stats.emailCompartido++; }
  if (r.telefono && usoTel.get(r.telefono) > 1) r.tags.push('telefono-compartido');
  r.fila[9] = r.tags.join(', ');
}

const csv = (filas) =>
  filas.map((f) => f.map((c) => {
    const s = String(c ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\r\n') + '\r\n';

mkdirSync(`${SALIDA}/por-zona`, { recursive: true });
writeFileSync(`${SALIDA}/base-ghl.csv`, '﻿' + csv([COLUMNAS, ...registros.map((r) => r.fila)]), 'utf8');

const porZona = new Map();
for (const r of registros) {
  if (!porZona.has(r.zonaSlug)) porZona.set(r.zonaSlug, []);
  porZona.get(r.zonaSlug).push(r.fila);
}
for (const [zona, filas] of porZona) {
  writeFileSync(`${SALIDA}/por-zona/${zona}.csv`, '﻿' + csv([COLUMNAS, ...filas]), 'utf8');
}

console.log(`Registros:            ${stats.total}`);
console.log(`Sin email:            ${stats.sinEmail}`);
console.log(`Sin teléfono:         ${stats.sinTel}`);
console.log(`  · placeholder:      ${stats.relleno}`);
console.log(`  · formato inválido: ${stats.telInvalido}`);
console.log(`Email a revisar:      ${stats.emailInvalido}`);
console.log(`Sin dirección:        ${stats.sinDireccion}`);
console.log(`Marcados no-prospectar: ${stats.contable}`);
console.log(`Con email compartido: ${stats.emailCompartido}`);
console.log(`\nArchivos por zona (${porZona.size}):`);
for (const [z, f] of [...porZona].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${z.padEnd(24)} ${f.length}`);
}
