// Infiere `segmento_negocio` a partir del nombre comercial y la razón social,
// y lo escribe en los contactos ya importados a GHL.
//
//   node scripts/clasificar-segmento.mjs            # clasifica y reporta, no toca GHL
//   node scripts/clasificar-segmento.mjs --aplicar  # además actualiza los contactos
//
// Criterio: precisión por encima de cobertura. Ante duda se deja
// `Por clasificar`, porque un segmento equivocado manda la oferta de textil
// incorrecta y eso cuesta más que un campo vacío.

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';

const CSV = 'out/ghl/base-ghl.csv';
const ESTADO = 'out/ghl/import-state.json';
const SALIDA = 'out/ghl/segmentos.csv';
const ERRORES = 'out/ghl/segmento-errores.jsonl';
const APLICADOS = 'out/ghl/segmento-aplicados.json';
const aplicar = process.argv.includes('--aplicar');

function parseCSV(t) {
  const rows = []; let f = '', row = [], q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\r') { /* CRLF */ }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

const sinTildes = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toUpperCase();

// El orden es el criterio: gana la primera regla que coincida, así que van de
// más específica a más genérica. `MINI SUPER` antes que `SUPER`, `RESTAURANTE`
// antes que `CAFE` (un "Restaurante y Café" es un restaurante).
const REGLAS = [
  ['Catering', /\bCATERING\b|\bBANQUETES?\b|\bNEWREST\b|SERVICIO DE ALIMENTACION/],
  ['Resort', /\bRESORTS?\b|\bLODGE\b|\bECOLODGE\b/],
  ['Hotel', /\bHOTELE?S?\b|\bHOSTELS?\b|\bHOSTALS?\b|\bPOSADA\b|\bCABINAS\b|\bAPARTOTEL\b|\bAPART HOTEL\b|\bSUITES\b|\bINN\b|\bBOUTIQUE HOTEL\b/],
  ['Panadería', /\bPANADERIAS?\b|\bPASTELERIAS?\b|\bREPOSTERIA\b|\bBAKERY\b|\bBREAD\b|\bBOULANGERIE\b/],
  ['Tienda de conveniencia', /\bMINI ?SUPERE?S?\b|\bMINI ?MARKET\b|\bMINI ?MERCADO\b|\bCONVENIENCIA\b|\bTIENDAS?\b|\bMARKET\b|\bMART\b|\bSTORE\b/],
  ['Supermercado', /\bSUPERMERCADOS?\b|\bAUTOMERCADO\b|\bMEGA ?SUPER\b|\bSUPER\b|\bPALI\b|\bWALMART\b|\bMAS X MENOS\b|\bMAXI ?PALI\b/],
  ['Abastecedor', /\bABASTECEDORE?S?\b|\bABASTOS?\b|\bPULPERIAS?\b/],
  ['Distribuidor', /\bDISTRIBUIDORA?S?\b|\bDISTRIBUCION\b|\bCOMERCIALIZADORA\b|\bIMPORTADORA\b|\bMAYORISTA\b/],
  ['Restaurante', /\bRESTAURANTE?S?\b|\bREST\b|\bPIZZERIAS?\b|\bPIZZA\b|\bSUSHI\b|\bGRILL\b|\bBISTRO\b|\bGASTRO\w*\b|\bTRATTORIA\b|\bMARISQUERIA\b|\bSODA\b|\bSTEAK\w*\b|\bBURGERS?\b|\bTACOS?\b|\bPARRILL\w*\b|\bASADOS\b|\bWOK\b|\bRAMEN\b|\bCEVICHERIA\b|\bDELI\b|\bCOCINA\b|\bKITCHEN\b|\bCOMIDAS?\b|\bCUISINE\b|\bRESTO\b|\bBUFFET\b|\bMARISCOS\b|\bTAQUERIA\b|\bCHURRASQUERIA\b|\bCREPE\w*\b|\bNOODLE\w*\b|\bCANTONESA\b|\bHAMBURGUES\w*\b|\bPIZZAS?\b/],
  ['Cafetería', /\bCAFETERIAS?\b|\bCAFES?\b|\bCOFFEE\b|\bSTARBUCKS\b|\bPANACAFE\b|\bBRITT\b|\bESPRESSO\b|\bCAFFE\b|\bCOFFE\b|\bGELATERIAS?\b|\bGELATO\b|\bHELADERIAS?\b/],
  ['Spa & Wellness', /\bSPA\b|\bWELLNESS\b|\bGIMNASIOS?\b|\bGYM\b|\bYOGA\b/],
  ['Bar', /\bBARS?\b|\bPUB\b|\bCANTINA\b|\bTABERNA\b|\bCERVECERIA\b|\bBREWING\b|\bBREWERY\b|\bWINE\b|\bLOUNGE\b/],
];

// Una licorera vendiendo al público es retail; sirviendo trago en barra es bar.
// El canal del ERP es el único dato que los separa de forma confiable.
const LICOR = /\bLICORERAS?\b|\bLICORES\b/;

// La razón social describe a la sociedad dueña, no al local: "MATSURI SABANA"
// está inscrito como "CO DISTRIBUIDORA ORIENTAL S.A" y no es un distribuidor.
// Por eso el nombre comercial decide, y la razón social sólo entra como
// respaldo para los rubros que sí nombran al establecimiento.
const RESPALDO = new Set([
  'Hotel', 'Resort', 'Panadería', 'Supermercado', 'Restaurante',
  'Cafetería', 'Catering', 'Abastecedor', 'Tienda de conveniencia',
]);

function porTexto(t, canal) {
  for (const [segmento, re] of REGLAS) if (re.test(t)) return segmento;
  if (LICOR.test(t)) return canal.startsWith('Off') ? 'Tienda de conveniencia' : 'Bar';
  return 'Por clasificar';
}

function clasificar(nombre, empresa, canal) {
  const directo = porTexto(sinTildes(nombre), canal);
  if (directo !== 'Por clasificar') return directo;
  const respaldo = porTexto(sinTildes(empresa), canal);
  return RESPALDO.has(respaldo) ? respaldo : 'Por clasificar';
}

const rows = parseCSV(readFileSync(CSV, 'utf8').replace(/^﻿/, ''));
const hdr = rows[0];
const datos = rows.slice(1).filter((r) => r.length > 1);
const col = (r, n) => r[hdr.indexOf(n)] ?? '';

const clasificados = datos.map((r) => ({
  idOrigen: col(r, 'ID origen ERP'),
  nombre: col(r, 'First Name'),
  empresa: col(r, 'Company Name'),
  canal: col(r, 'Canal comercial'),
  segmento: clasificar(col(r, 'First Name'), col(r, 'Company Name'), col(r, 'Canal comercial')),
}));

const dist = new Map();
for (const c of clasificados) dist.set(c.segmento, (dist.get(c.segmento) ?? 0) + 1);
const resueltos = clasificados.length - (dist.get('Por clasificar') ?? 0);

console.log(`Clasificados: ${resueltos}/${clasificados.length} (${Math.round(resueltos / clasificados.length * 100)}%)\n`);
for (const [s, n] of [...dist].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${s}`);

console.log('\n--- muestra por segmento ---');
for (const [s] of [...dist].sort((a, b) => b[1] - a[1])) {
  if (s === 'Por clasificar') continue;
  const ej = clasificados.filter((c) => c.segmento === s).slice(0, 5).map((c) => c.nombre);
  console.log(`  ${s}: ${ej.join(' · ')}`);
}
console.log('\n--- sin clasificar (muestra) ---');
console.log('  ' + clasificados.filter((c) => c.segmento === 'Por clasificar').slice(0, 25).map((c) => c.nombre).join(' · '));

const csv = (f) => f.map((r) => r.map((c) => /[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c).join(',')).join('\r\n') + '\r\n';
writeFileSync(SALIDA, '﻿' + csv([['ID origen ERP', 'Nombre', 'Razón social', 'Canal', 'Segmento'],
  ...clasificados.map((c) => [c.idOrigen, c.nombre, c.empresa, c.canal, c.segmento])]), 'utf8');
console.log(`\nDetalle completo en ${SALIDA}`);

if (!aplicar) { console.log('\n(sin --aplicar: no se tocó GHL)'); process.exit(0); }

const env = {};
for (const l of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const headers = {
  Authorization: `Bearer ${env.LUXE_GHL_API_KEY}`, Version: '2021-07-28',
  'Content-Type': 'application/json', Accept: 'application/json',
};
const cf = JSON.parse(await (await fetch(
  `https://services.leadconnectorhq.com/locations/${env.LUXE_GHL_LOCATION_ID}/customFields`, { headers })).text()).customFields;
const campoId = cf.find((f) => f.fieldKey.endsWith('segmento_negocio')).id;
const estado = JSON.parse(readFileSync(ESTADO, 'utf8'));

// Sólo se actualiza lo que cambia: reescribir 3.340 contactos con el mismo
// `Por clasificar` que ya tienen es gastar cuota de API para nada.
// Reanudable: lo ya escrito con el mismo valor no se vuelve a mandar.
const aplicados = existsSync(APLICADOS) ? JSON.parse(readFileSync(APLICADOS, 'utf8')) : {};
const pendientes = clasificados.filter((c) =>
  c.segmento !== 'Por clasificar' && estado[c.idOrigen] && aplicados[c.idOrigen] !== c.segmento);
console.log(`\nActualizando ${pendientes.length} contactos...`);

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// GHL devuelve 429 con bastante más facilidad en PUT que en POST, sobre todo
// después de una carga grande. Sin backoff se pierde ~1 de cada 4 escrituras.
async function escribir(contactId, segmento, intento = 1) {
  const r = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
    method: 'PUT', headers,
    body: JSON.stringify({ customFields: [{ id: campoId, value: segmento }] }),
  });
  if (r.status === 429 && intento <= 6) {
    await dormir(1500 * intento);
    return escribir(contactId, segmento, intento + 1);
  }
  return r.ok ? { ok: true } : { ok: false, status: r.status, error: (await r.text()).slice(0, 300) };
}

let ok = 0, fallos = 0, hechos = 0;
const cola = [...pendientes];

async function trabajador() {
  while (cola.length) {
    const c = cola.shift();
    const r = await escribir(estado[c.idOrigen], c.segmento);
    hechos++;
    if (r.ok) { ok++; aplicados[c.idOrigen] = c.segmento; }
    else {
      fallos++;
      appendFileSync(ERRORES, JSON.stringify({ idOrigen: c.idOrigen, status: r.status, error: r.error }) + '\n');
    }
    if (hechos % 100 === 0) {
      writeFileSync(APLICADOS, JSON.stringify(aplicados, null, 0));
      console.log(`  ${hechos}/${pendientes.length}  ok=${ok} fallos=${fallos}`);
    }
    await dormir(250);
  }
}
await Promise.all(Array.from({ length: 3 }, trabajador));
writeFileSync(APLICADOS, JSON.stringify(aplicados, null, 0));
console.log(`\nActualizados: ${ok} | fallos: ${fallos}${fallos ? ` (ver ${ERRORES})` : ''}`);
console.log(`Acumulado en GHL: ${Object.keys(aplicados).length} contactos con segmento`);
