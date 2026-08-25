// Importa `out/ghl/base-ghl.csv` a GoHighLevel vía API v2.
//
//   node scripts/importar-base-ghl.mjs --limit 25    # piloto
//   node scripts/importar-base-ghl.mjs               # todo lo pendiente
//   node scripts/importar-base-ghl.mjs --dry         # sólo imprime payloads
//
// Es reanudable: `out/ghl/import-state.json` guarda el mapa
// `ID origen ERP -> contactId`, así que volver a correrlo salta lo ya creado.
// Usa POST /contacts/ y NO /contacts/upsert: en esta base los emails y
// teléfonos repetidos son sucursales distintas, no duplicados a fusionar.

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';

const BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';
const CSV = 'out/ghl/base-ghl.csv';
const ESTADO = 'out/ghl/import-state.json';
const ERRORES = 'out/ghl/import-errores.jsonl';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const limite = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;

const env = {};
for (const l of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const apiKey = env.LUXE_GHL_API_KEY;
const locationId = env.LUXE_GHL_LOCATION_ID;
if (!apiKey || !locationId) throw new Error('Faltan LUXE_GHL_API_KEY o LUXE_GHL_LOCATION_ID');

const headers = {
  Authorization: `Bearer ${apiKey}`,
  Version: VERSION,
  'Content-Type': 'application/json',
  Accept: 'application/json',
};

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

// Columnas nativas del contacto; el resto del CSV son campos personalizados.
const NATIVAS = new Set([
  'First Name', 'Last Name', 'Company Name', 'Email', 'Phone',
  'Address', 'City', 'Country', 'Source', 'Tags',
]);

const res = await fetch(`${BASE}/locations/${locationId}/customFields`, { headers });
if (!res.ok) throw new Error(`No se pudieron leer los campos personalizados: ${res.status}`);
const { customFields } = JSON.parse(await res.text());
const porNombre = new Map(customFields.map((f) => [f.name, f]));

const rows = parseCSV(readFileSync(CSV, 'utf8').replace(/^﻿/, ''));
const hdr = rows[0];
const datos = rows.slice(1).filter((r) => r.length > 1);

// Falla temprano si el CSV trae una columna personalizada que no existe en GHL:
// importar con el campo silenciosamente vacío es peor que no importar.
const faltantes = hdr.filter((h) => !NATIVAS.has(h) && !porNombre.has(h));
if (faltantes.length) throw new Error(`Campos sin equivalente en GHL: ${faltantes.join(', ')}`);

mkdirSync('out/ghl', { recursive: true });
const estado = existsSync(ESTADO) ? JSON.parse(readFileSync(ESTADO, 'utf8')) : {};

const col = (r, nombre) => r[hdr.indexOf(nombre)] ?? '';

function construirPayload(r) {
  const cf = [];
  hdr.forEach((h, i) => {
    if (NATIVAS.has(h)) return;
    const bruto = (r[i] ?? '').trim();
    if (!bruto) return;
    const campo = porNombre.get(h);
    cf.push({ id: campo.id, value: campo.dataType === 'NUMERICAL' ? Number(bruto) : bruto });
  });

  const p = {
    locationId,
    firstName: col(r, 'First Name'),
    companyName: col(r, 'Company Name'),
    country: col(r, 'Country') || 'CR',
    source: col(r, 'Source'),
    tags: col(r, 'Tags').split(',').map((t) => t.trim()).filter(Boolean),
    customFields: cf,
  };
  const opcionales = { email: 'Email', phone: 'Phone', address1: 'Address', city: 'City' };
  for (const [clave, columna] of Object.entries(opcionales)) {
    const v = col(r, columna);
    if (v) p[clave] = v;
  }
  return p;
}

// La API v2 permite 100 peticiones cada 10 s por subcuenta. Se queda holgado
// abajo del techo para no comerse la cuota de otros procesos.
const CONCURRENCIA = 5;
const PAUSA_MS = 120;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function crear(payload, intento = 1) {
  const r = await fetch(`${BASE}/contacts/`, {
    method: 'POST', headers, body: JSON.stringify(payload),
  });
  if (r.status === 429 && intento <= 5) {
    await dormir(2000 * intento);
    return crear(payload, intento + 1);
  }
  const txt = await r.text();
  if (!r.ok) return { ok: false, status: r.status, error: txt.slice(0, 400) };
  const j = JSON.parse(txt);
  return { ok: true, contactId: j.contact?.id ?? j.id };
}

const pendientes = datos.filter((r) => !estado[col(r, 'ID origen ERP')]).slice(0, limite);
console.log(`Total CSV: ${datos.length} | ya importados: ${Object.keys(estado).length} | a procesar: ${pendientes.length}`);

if (dry) {
  console.log(JSON.stringify(construirPayload(pendientes[0]), null, 2));
  process.exit(0);
}

let ok = 0, fallos = 0, hechos = 0;
const cola = [...pendientes];

async function trabajador() {
  while (cola.length) {
    const r = cola.shift();
    const idOrigen = col(r, 'ID origen ERP');
    const resultado = await crear(construirPayload(r));
    hechos++;
    if (resultado.ok) {
      estado[idOrigen] = resultado.contactId;
      ok++;
    } else {
      fallos++;
      appendFileSync(ERRORES, JSON.stringify({
        idOrigen, nombre: col(r, 'First Name'), status: resultado.status, error: resultado.error,
      }) + '\n');
    }
    if (hechos % 50 === 0) {
      writeFileSync(ESTADO, JSON.stringify(estado, null, 0));
      console.log(`  ${hechos}/${pendientes.length}  ok=${ok} fallos=${fallos}`);
    }
    await dormir(PAUSA_MS);
  }
}

await Promise.all(Array.from({ length: CONCURRENCIA }, trabajador));
writeFileSync(ESTADO, JSON.stringify(estado, null, 0));
console.log(`\nCreados: ${ok} | fallos: ${fallos}${fallos ? ` (ver ${ERRORES})` : ''}`);
console.log(`Estado acumulado: ${Object.keys(estado).length} contactos en ${ESTADO}`);
