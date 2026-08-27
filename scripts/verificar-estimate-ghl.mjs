// Crea un Estimate de prueba en GoHighLevel, imprime lo que devuelve y lo borra.
// Objetivo: confirmar que se puede emitir sin pasarela de pago, y documentar el
// cuerpo exacto que la API acepta.
//
// Ejecutar con: node --env-file=.env.local scripts/verificar-estimate-ghl.mjs
//
// IMPORTANTE: esto escribe en el CRM de producción de un cliente real. Crea UN
// solo Estimate de prueba y lo borra siempre (try/finally), pase lo que pase.
// No envía nada a nadie: nunca llama a un endpoint de "send".
//
// Este cuerpo es el resultado de iterar contra la API real (ver
// docs/ghl-estimate-payload.md para el detalle de qué rechazó qué). Puntos
// que NO son obvios desde la documentación:
//   - contactDetails.id es obligatorio y debe ser un string no vacío. La API
//     NO valida que corresponda a un contacto real, así que para la prueba
//     se usa un ObjectId ficticio (24 ceros) sin tocar contactos reales.
//   - frequencySettings.enabled (boolean) es obligatorio, aunque el Estimate
//     no sea recurrente.
//   - title (además de name) es obligatorio a nivel de esquema de Mongo,
//     aunque el DTO no lo exija.
//   - items[].type es un enum obligatorio; "one_time" es el valor válido
//     para una línea no recurrente ("service" no es un valor válido).
//   - DELETE /invoices/estimate/:id NO acepta altId/altType como query
//     params (da 422 "altId must be a string" aunque venga en la URL).
//     Los espera en el BODY del DELETE.

const apiKey = process.env.LUXE_GHL_API_KEY;
const locationId = process.env.LUXE_GHL_LOCATION_ID;
if (!apiKey || !locationId) {
  console.error('Faltan LUXE_GHL_API_KEY o LUXE_GHL_LOCATION_ID');
  process.exit(1);
}

const BASE = 'https://services.leadconnectorhq.com';
const cabeceras = {
  Authorization: `Bearer ${apiKey}`,
  Version: '2021-07-28',
  'Content-Type': 'application/json',
  Accept: 'application/json',
};

const cuerpo = {
  altId: locationId,
  altType: 'location',
  name: 'PRUEBA — borrar',
  title: 'Cotización de prueba',
  currency: 'CRC',
  liveMode: false,
  businessDetails: { name: 'Luxe Essentials' },
  contactDetails: {
    // ObjectId ficticio: la API exige un string no vacío pero no lo valida
    // contra un contacto real. No se asocia a ningún contacto real.
    id: '000000000000000000000000',
    name: 'Prueba Automatizada',
    email: 'prueba@example.invalid',
  },
  items: [
    {
      name: 'Filipina tradicional manga corta',
      currency: 'CRC',
      amount: 15500,
      qty: 24,
      type: 'one_time',
    },
  ],
  discount: { type: 'percentage', value: 5 },
  issueDate: '2026-08-26',
  expiryDate: '2026-09-25',
  termsNotes: 'Cotización de prueba automatizada. No representa un pedido real.',
  frequencySettings: { enabled: false },
};

let idCreado = null;

try {
  console.log('--- POST /invoices/estimate ---');
  console.log(JSON.stringify(cuerpo, null, 2));

  const res = await fetch(`${BASE}/invoices/estimate`, {
    method: 'POST',
    headers: cabeceras,
    body: JSON.stringify(cuerpo),
  });
  const texto = await res.text();
  console.log(`\nPOST /invoices/estimate -> ${res.status}`);
  console.log(texto.slice(0, 3000));

  if (!res.ok) {
    console.error('\nNo se pudo crear el Estimate.');
    process.exitCode = 1;
  } else {
    const creado = JSON.parse(texto);
    idCreado = creado._id ?? creado.id ?? null;

    console.log('\n=== Respuesta completa ===');
    console.log(JSON.stringify(creado, null, 2));

    console.log('\n=== Preguntas clave ===');
    console.log('1. ¿Hay algún campo de pasarela, paymentMethods, payNow o similar?');
    console.log('   Claves presentes en la raíz:', Object.keys(creado).join(', '));
    console.log('2. ¿Qué trae liveMode?', creado.liveMode);
    console.log('3. ¿El estimateNumber viene asignado?', creado.estimateNumber);
    console.log('4. ¿Dónde viene el id?', creado._id ? '_id' : creado.id ? 'id' : 'NO ENCONTRADO');
  }
} finally {
  if (idCreado) {
    console.log(`\nBorrando Estimate de prueba ${idCreado}...`);
    try {
      // OJO: altId/altType van en el BODY del DELETE, no en la query string.
      // Como query string, la API responde 422 "altId must be a string".
      const del = await fetch(`${BASE}/invoices/estimate/${idCreado}`, {
        method: 'DELETE',
        headers: cabeceras,
        body: JSON.stringify({ altId: locationId, altType: 'location' }),
      });
      const delTexto = await del.text();
      console.log(`DELETE /invoices/estimate/${idCreado} -> ${del.status}`);
      console.log(delTexto.slice(0, 1000));
      if (!del.ok) {
        console.error(
          `\n*** ATENCIÓN: el borrado falló. Queda huérfano el Estimate ${idCreado} en el location ${locationId}. Un humano debe borrarlo a mano en GoHighLevel. ***`,
        );
      }
    } catch (err) {
      console.error(
        `\n*** ATENCIÓN: error de red al borrar. Queda huérfano el Estimate ${idCreado} en el location ${locationId}. Un humano debe borrarlo a mano en GoHighLevel. Error: ${
          err instanceof Error ? err.message : String(err)
        } ***`,
      );
    }
  } else {
    console.log('\nNo se creó ningún Estimate, nada que borrar.');
  }
}
