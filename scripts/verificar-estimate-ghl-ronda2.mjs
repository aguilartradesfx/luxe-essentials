// Ronda de correcciones 1 sobre la Tarea 7: sondeo de cuatro puntos que solo
// se cierran preguntándole a GoHighLevel. Mismo cuidado que
// `scripts/verificar-estimate-ghl.mjs`: cada recurso que se crea se inspecciona
// y se borra siempre, en su propio `try/finally`, sin enviar nada a nadie
// (nunca se llama a un endpoint de "send").
//
// Ejecutar con: node --env-file=.env.local scripts/verificar-estimate-ghl-ronda2.mjs
//
// Preguntas de esta ronda:
//   A. El endpoint de oportunidades: ¿`pipelineStageName` mueve la etapa de
//      verdad, o hace falta `pipelineStageId`?
//   B. ¿`items[].description` y `contactDetails.companyName` los acepta el
//      DTO del Estimate, o hay whitelist que los tira (422)?
//   C. ¿`issueDate`/`expiryDate` son opcionales? Si se omiten, ¿qué pone GHL
//      por default?
//   D. ¿Qué hace `liveMode` si se omite?

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

const PIPELINE = 'vr8WB783pg2FsTQj6LiG';

let huerfanos = [];

function linea(titulo) {
  console.log(`\n${'='.repeat(3)} ${titulo} ${'='.repeat(3)}`);
}

// ---------------------------------------------------------------------------
// A. Pipeline y oportunidad: ¿pipelineStageName mueve la etapa de verdad?
// ---------------------------------------------------------------------------
async function sondaOportunidad() {
  linea('A. GET /opportunities/pipelines — etapas del pipeline');

  const resPipelines = await fetch(
    `${BASE}/opportunities/pipelines?locationId=${locationId}`,
    { headers: cabeceras },
  );
  const textoPipelines = await resPipelines.text();
  console.log(`GET /opportunities/pipelines -> ${resPipelines.status}`);
  if (!resPipelines.ok) {
    console.error('No se pudo leer el pipeline. Abortando la sonda de oportunidades.');
    console.log(textoPipelines.slice(0, 1000));
    return;
  }
  const datosPipelines = JSON.parse(textoPipelines);
  const pipeline = (datosPipelines.pipelines ?? []).find((p) => p.id === PIPELINE);
  if (!pipeline) {
    console.error(`No se encontró el pipeline ${PIPELINE} en la respuesta.`);
    console.log(JSON.stringify(datosPipelines, null, 2).slice(0, 2000));
    return;
  }
  console.log(`Pipeline "${pipeline.name}" (${pipeline.id}), etapas:`);
  for (const etapa of pipeline.stages ?? []) {
    console.log(`  - ${etapa.name} -> id ${etapa.id}`);
  }
  const etapaPropuesta = (pipeline.stages ?? []).find((e) => e.name === 'Proposal Sent');
  const primeraEtapa = (pipeline.stages ?? [])[0];
  console.log(
    `\n"Proposal Sent" ${etapaPropuesta ? `existe, id = ${etapaPropuesta.id}` : 'NO existe con ese nombre exacto'}.`,
  );

  // --- Un contacto desechable, solo para poder crear la oportunidad. Se
  // borra al final pase lo que pase. ---
  linea('Contacto desechable para las pruebas de oportunidad');
  let contactId = null;
  try {
    const resContacto = await fetch(`${BASE}/contacts/upsert`, {
      method: 'POST',
      headers: cabeceras,
      body: JSON.stringify({
        locationId,
        firstName: 'Sondeo',
        lastName: 'Ronda2 — borrar',
        email: 'sondeo-ronda2@example.invalid',
        source: 'Sondeo automatizado — Tarea 7 ronda 1',
        tags: ['sondeo-borrar'],
      }),
    });
    const textoContacto = await resContacto.text();
    console.log(`POST /contacts/upsert -> ${resContacto.status}`);
    if (!resContacto.ok) {
      console.error('No se pudo crear el contacto desechable. Abortando la sonda de oportunidades.');
      console.log(textoContacto.slice(0, 1000));
      return;
    }
    const datosContacto = JSON.parse(textoContacto);
    contactId = datosContacto.contact?.id ?? datosContacto.id ?? null;
    console.log(`Contacto desechable: ${contactId}`);

    if (etapaPropuesta) {
      await probarCreacionOportunidad({
        etiqueta: 'con pipelineStageName (código actual de lib/cotizador/ghl.ts)',
        contactId,
        cuerpoExtra: { pipelineStageName: 'Proposal Sent' },
        idEtapaEsperada: etapaPropuesta.id,
        etapas: pipeline.stages,
      });

      await probarCreacionOportunidad({
        etiqueta: 'con pipelineStageId (corrección propuesta)',
        contactId,
        cuerpoExtra: { pipelineStageId: etapaPropuesta.id },
        idEtapaEsperada: etapaPropuesta.id,
        etapas: pipeline.stages,
      });
    }

    // También: ¿qué pasa si no se manda NINGUNA etapa? (para saber el
    // comportamiento por default del endpoint, dato útil si algún día se
    // decide no fijar etapa).
    await probarCreacionOportunidad({
      etiqueta: 'sin pipelineStageName ni pipelineStageId',
      contactId,
      cuerpoExtra: {},
      idEtapaEsperada: primeraEtapa?.id,
      etapas: pipeline.stages,
    });
  } finally {
    if (contactId) {
      try {
        const del = await fetch(`${BASE}/contacts/${contactId}`, {
          method: 'DELETE',
          headers: cabeceras,
        });
        console.log(`\nDELETE /contacts/${contactId} -> ${del.status}`);
        if (!del.ok) {
          huerfanos.push(`Contacto ${contactId} (falló el DELETE)`);
          console.log((await del.text()).slice(0, 500));
        }
      } catch (err) {
        huerfanos.push(`Contacto ${contactId} (error de red al borrar: ${err.message})`);
      }
    }
  }
}

async function probarCreacionOportunidad({ etiqueta, contactId, cuerpoExtra, idEtapaEsperada, etapas }) {
  linea(`POST /opportunities/ — ${etiqueta}`);
  const cuerpo = {
    pipelineId: PIPELINE,
    locationId,
    name: 'PRUEBA RONDA 2 — borrar',
    status: 'open',
    contactId,
    monetaryValue: 1000,
    ...cuerpoExtra,
  };
  console.log(JSON.stringify(cuerpo, null, 2));

  let idOportunidad = null;
  try {
    const res = await fetch(`${BASE}/opportunities/`, {
      method: 'POST',
      headers: cabeceras,
      body: JSON.stringify(cuerpo),
    });
    const texto = await res.text();
    console.log(`\nPOST /opportunities/ -> ${res.status}`);
    console.log(texto.slice(0, 1500));

    if (!res.ok) {
      console.error('No se creó la oportunidad para esta variante.');
      return;
    }

    const datos = JSON.parse(texto);
    const opp = datos.opportunity ?? datos;
    idOportunidad = opp.id ?? opp._id ?? null;
    const etapaReal = opp.pipelineStageId;
    const nombreEtapaReal = (etapas ?? []).find((e) => e.id === etapaReal)?.name ?? '(desconocida)';

    console.log(`\nId de la oportunidad creada: ${idOportunidad}`);
    console.log(`pipelineStageId devuelto: ${etapaReal} (${nombreEtapaReal})`);
    console.log(`¿Coincide con la etapa esperada (${idEtapaEsperada})? ${etapaReal === idEtapaEsperada}`);

    // Doble chequeo por lectura directa, no solo por la respuesta del POST,
    // por si hay alguna inconsistencia eventual entre lo que se devuelve al
    // crear y lo que realmente queda guardado.
    if (idOportunidad) {
      const resGet = await fetch(`${BASE}/opportunities/${idOportunidad}`, { headers: cabeceras });
      const textoGet = await resGet.text();
      console.log(`\nGET /opportunities/${idOportunidad} -> ${resGet.status}`);
      if (resGet.ok) {
        const datosGet = JSON.parse(textoGet);
        const oppGet = datosGet.opportunity ?? datosGet;
        const etapaGuardada = oppGet.pipelineStageId;
        const nombreGuardada = (etapas ?? []).find((e) => e.id === etapaGuardada)?.name ?? '(desconocida)';
        console.log(`Etapa guardada según GET directo: ${etapaGuardada} (${nombreGuardada})`);
      } else {
        console.log(textoGet.slice(0, 500));
      }
    }
  } finally {
    if (idOportunidad) {
      try {
        const del = await fetch(`${BASE}/opportunities/${idOportunidad}`, {
          method: 'DELETE',
          headers: cabeceras,
        });
        console.log(`DELETE /opportunities/${idOportunidad} -> ${del.status}`);
        if (!del.ok) {
          huerfanos.push(`Oportunidad ${idOportunidad} (falló el DELETE)`);
          console.log((await del.text()).slice(0, 500));
        }
      } catch (err) {
        huerfanos.push(`Oportunidad ${idOportunidad} (error de red al borrar: ${err.message})`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// B, C, D. Un Estimate con description, companyName, sin issueDate/expiryDate
// ni liveMode, para ver qué acepta el DTO y qué defaults pone GHL.
// ---------------------------------------------------------------------------
async function sondaCamposEstimate() {
  linea('B/C/D. POST /invoices/estimate — description, companyName, sin fechas ni liveMode');

  const cuerpo = {
    altId: locationId,
    altType: 'location',
    name: 'PRUEBA RONDA 2 — borrar',
    title: 'Cotización de prueba ronda 2',
    currency: 'CRC',
    // Sin liveMode a propósito: para ver el default.
    businessDetails: { name: 'Luxe Essentials' },
    contactDetails: {
      id: '000000000000000000000000',
      name: 'Prueba Automatizada Ronda 2',
      email: 'prueba-ronda2@example.invalid',
      // Sin probar antes: puede que el DTO tenga whitelist y lo tire con 422.
      companyName: 'Hotel de Prueba S.A.',
    },
    items: [
      {
        name: 'Filipina tradicional manga corta',
        // Sin probar antes: mismo riesgo de whitelist que companyName.
        description: 'Incluye: prueba de descripción con dos puntos y coma; y una lista, de items.',
        currency: 'CRC',
        amount: 15500,
        qty: 24,
        type: 'one_time',
      },
    ],
    discount: { type: 'percentage', value: 0 },
    // Sin issueDate ni expiryDate a propósito: para ver si son obligatorios y,
    // si no lo son, qué pone GHL por default.
    termsNotes: 'Cotización de prueba ronda 2. No representa un pedido real.',
    frequencySettings: { enabled: false },
  };

  console.log(JSON.stringify(cuerpo, null, 2));

  let idCreado = null;
  try {
    const res = await fetch(`${BASE}/invoices/estimate`, {
      method: 'POST',
      headers: cabeceras,
      body: JSON.stringify(cuerpo),
    });
    const texto = await res.text();
    console.log(`\nPOST /invoices/estimate -> ${res.status}`);
    console.log(texto.slice(0, 3000));

    if (!res.ok) {
      console.error('\nNo se pudo crear el Estimate de esta prueba. El mensaje de arriba dice qué campo rechazó.');
      return;
    }

    let creado = null;
    try {
      creado = JSON.parse(texto);
    } catch (err) {
      console.error(`\nATENCIÓN: 2xx pero JSON inválido: ${err.message}`);
    }

    if (creado) {
      idCreado = creado._id ?? creado.id ?? null;
      console.log('\n=== Respuesta completa ===');
      console.log(JSON.stringify(creado, null, 2));

      console.log('\n=== Respuestas a B/C/D ===');
      console.log('B. ¿companyName sobrevivió en contactDetails?', creado.contactDetails?.companyName);
      console.log('B. ¿description sobrevivió en items[0]?', creado.items?.[0]?.description);
      console.log('C. issueDate en la respuesta (sin mandarlo):', creado.issueDate);
      console.log('C. expiryDate en la respuesta (sin mandarlo):', creado.expiryDate);
      console.log('D. liveMode en la respuesta (sin mandarlo):', creado.liveMode);
    } else {
      const rescate = texto.match(/"_id"\s*:\s*"([a-fA-F0-9]{24})"/);
      idCreado = rescate ? rescate[1] : null;
      if (idCreado) console.error(`Id rescatado por regex: ${idCreado}`);
    }
  } finally {
    if (idCreado) {
      try {
        const del = await fetch(`${BASE}/invoices/estimate/${idCreado}`, {
          method: 'DELETE',
          headers: cabeceras,
          body: JSON.stringify({ altId: locationId, altType: 'location' }),
        });
        const delTexto = await del.text();
        console.log(`\nDELETE /invoices/estimate/${idCreado} -> ${del.status}`);
        console.log(delTexto.slice(0, 500));
        if (!del.ok) {
          huerfanos.push(`Estimate ${idCreado} (falló el DELETE)`);
        }
      } catch (err) {
        huerfanos.push(`Estimate ${idCreado} (error de red al borrar: ${err.message})`);
      }
    } else {
      console.log('\nNo se creó ningún Estimate en esta prueba, nada que borrar.');
    }
  }
}

try {
  await sondaOportunidad();
} catch (err) {
  console.error('Error inesperado en la sonda de oportunidades:', err);
}

try {
  await sondaCamposEstimate();
} catch (err) {
  console.error('Error inesperado en la sonda de campos del Estimate:', err);
}

linea('RESUMEN');
if (huerfanos.length > 0) {
  console.error('*** QUEDARON RECURSOS HUÉRFANOS, revisar a mano en GoHighLevel: ***');
  for (const h of huerfanos) console.error(` - ${h}`);
  process.exitCode = 1;
} else {
  console.log('Todo lo creado en esta corrida se borró correctamente. Sin huérfanos.');
}
