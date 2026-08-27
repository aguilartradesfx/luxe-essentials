// Sondeo puntual para C2 (ronda de correcciones 2, ver
// docs/ghl-estimate-payload.md): ¿POST /contacts/upsert conserva
// firstName/source/tags cuando el segundo POST (mismo email) los omite del
// payload, o los limpia? Esto decide si `resolverContacto` puede usar un
// upsert mínimo (sólo locationId + email) para encontrar-o-crear un contacto
// sin arriesgarse a vaciar los campos que no manda.
//
// Ejecutar con: node --env-file=.env.local scripts/verificar-upsert-parcial-ghl.mjs
//
// Sigue el patrón de scripts/verificar-estimate-ghl.mjs: crea, inspecciona,
// borra siempre en try/finally. No deja huérfanos.
const apiKey = process.env.LUXE_GHL_API_KEY;
const locationId = process.env.LUXE_GHL_LOCATION_ID;
if (!apiKey || !locationId) {
  console.error('Faltan LUXE_GHL_API_KEY o LUXE_GHL_LOCATION_ID');
  process.exit(1);
}

const BASE = 'https://services.leadconnectorhq.com';
const H = {
  Authorization: `Bearer ${apiKey}`,
  Version: '2021-07-28',
  'Content-Type': 'application/json',
  Accept: 'application/json',
};

const email = `sondeo-c2-${Date.now()}@example.invalid`;
let contactId = null;

try {
  console.log('--- 1) POST /contacts/upsert (creación, con firstName/source/tags) ---');
  const res1 = await fetch(`${BASE}/contacts/upsert`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      locationId,
      firstName: 'HOTEL PLAYA GRANDE S.A.',
      email,
      source: 'Importacion ERP 2026',
      tags: ['base-2026', 'zona-caribe'],
    }),
  });
  const texto1 = await res1.text();
  console.log(`status ${res1.status}`);
  if (!res1.ok) throw new Error(`no se pudo crear: ${texto1.slice(0, 300)}`);
  const datos1 = JSON.parse(texto1);
  contactId = datos1.contact?.id ?? datos1.id;
  console.log(`contactId: ${contactId}`);
  console.log(`firstName: ${datos1.contact?.firstName ?? datos1.firstName}`);
  console.log(`tags: ${JSON.stringify(datos1.contact?.tags ?? datos1.tags)}`);

  console.log('\n--- 2) GET /contacts/:id (confirmar estado tras la creación) ---');
  const resGet1 = await fetch(`${BASE}/contacts/${contactId}`, { headers: H });
  const contactoAntes = (JSON.parse(await resGet1.text())).contact;
  console.log(`firstName antes: ${contactoAntes.firstName}`);
  console.log(`source antes: ${contactoAntes.source}`);
  console.log(`tags antes: ${JSON.stringify(contactoAntes.tags)}`);

  console.log('\n--- 3) POST /contacts/upsert de nuevo, MISMO email, SIN firstName/source/tags ---');
  const res2 = await fetch(`${BASE}/contacts/upsert`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ locationId, email }),
  });
  const texto2 = await res2.text();
  console.log(`status ${res2.status}`);
  console.log(texto2.slice(0, 1000));
  const datos2 = JSON.parse(texto2);
  const idSegundo = datos2.contact?.id ?? datos2.id;
  console.log(`\n¿mismo contactId? ${idSegundo === contactId}`);

  console.log('\n--- 4) GET /contacts/:id (estado final, tras el upsert vacío) ---');
  const resGet2 = await fetch(`${BASE}/contacts/${contactId}`, { headers: H });
  const contactoDespues = (JSON.parse(await resGet2.text())).contact;
  console.log(`firstName después: ${contactoDespues.firstName}`);
  console.log(`source después: ${contactoDespues.source}`);
  console.log(`tags después: ${JSON.stringify(contactoDespues.tags)}`);

  console.log('\n=== VEREDICTO ===');
  console.log(`firstName sobrevivió: ${contactoDespues.firstName === 'HOTEL PLAYA GRANDE S.A.'}`);
  console.log(`source sobrevivió: ${contactoDespues.source === 'Importacion ERP 2026'}`);
  console.log(`tags sobrevivieron: ${JSON.stringify(contactoDespues.tags) === JSON.stringify(['base-2026', 'zona-caribe'])}`);
} finally {
  if (contactId) {
    const del = await fetch(`${BASE}/contacts/${contactId}`, { method: 'DELETE', headers: H });
    console.log(`\nDELETE /contacts/${contactId} -> ${del.status}`);
    if (!del.ok) {
      console.error('*** HUÉRFANO: no se pudo borrar el contacto de prueba ***');
      console.error(await del.text());
      process.exitCode = 1;
    }
  }
}
