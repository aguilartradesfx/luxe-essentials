import { config } from 'dotenv';

// `import 'dotenv/config'` sólo lee `.env`. Las credenciales de este
// proyecto viven en `.env.local`, así que hay que pedirlo explícitamente.
config({ path: '.env.local' });
config();

const apiKey = process.env.LUXE_GHL_API_KEY;
const locationId = process.env.LUXE_GHL_LOCATION_ID;

if (!apiKey || !locationId) {
  console.error('Faltan LUXE_GHL_API_KEY o LUXE_GHL_LOCATION_ID en .env.local');
  process.exit(1);
}

async function probar(nombre, url, headers) {
  try {
    const res = await fetch(url, { headers });
    const texto = await res.text();
    console.log(`\n=== ${nombre} → ${res.status} ===`);
    console.log(texto.slice(0, 600));
    return res.ok;
  } catch (err) {
    console.log(`\n=== ${nombre} → error de red: ${err.message} ===`);
    return false;
  }
}

const v2 = {
  Authorization: `Bearer ${apiKey}`,
  Version: '2021-07-28',
  Accept: 'application/json',
};

const okV2 = await probar('v2 · location', `https://services.leadconnectorhq.com/locations/${locationId}`, v2);

if (okV2) {
  await probar(
    'v2 · pipelines',
    `https://services.leadconnectorhq.com/opportunities/pipelines?locationId=${locationId}`,
    v2,
  );
  await probar(
    'v2 · custom fields',
    `https://services.leadconnectorhq.com/locations/${locationId}/customFields`,
    v2,
  );
} else {
  await probar('v1 · contacts', 'https://rest.gohighlevel.com/v1/contacts/?limit=1', {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
  });
}
