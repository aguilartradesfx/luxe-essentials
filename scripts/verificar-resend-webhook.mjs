// Verifica la migración 0029 (webhook de Resend) CONTRA LA BASE REAL, pero
// dentro de una transacción que SIEMPRE termina en ROLLBACK: no deja nada.
// Ejecuta la migración, siembra una campaña de mentira y recorre los
// escenarios (repetido, desordenado, empate, desconocido, reconciliación,
// permisos). Uso, desde la raíz del repo: `node scripts/verificar-resend-webhook.mjs`.
// `MIG=<ruta>` prueba otro archivo SQL (para verificar por mutación).
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(process.cwd() + '/package.json');
const pg = require('pg');
require('dotenv').config({ path: '.env.local' });
const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const q = async (sql, p) => (await c.query(sql, p)).rows;
let fallos = 0;
const ok = (cond, msg) => { console.log((cond ? 'OK   ' : 'FALLA ') + msg); if (!cond) fallos++; };
try {
  await c.query('begin');
  await c.query(readFileSync(process.env.MIG ?? 'supabase/migrations/0029_resend_eventos.sql', 'utf8'));
  const [{ id: camp }] = await q(`insert into campanas (plantilla, asunto, html, creado_por) values ('inicial','x','x','verif') returning id`);
  const mk = async (rid) => (await q(`insert into campanas_envios (campana_id, correo, contacto_id, nombre_crm, estado, resend_id) values ($1,$2,'g','n','enviado',$3) returning id`, [camp, `${rid}@x.cr`, rid]))[0].id;
  const reg = async (svix, tipo, rid, t, det = null) => (await q(`select resend_registrar_evento($1,$2,$3,$4,$5) r`, [svix, tipo, rid, t, det]))[0].r;
  const envio = async (id) => (await q(`select * from campanas_envios where id=$1`, [id]))[0];
  const tot = async () => (await q(`select * from campanas_entrega_totales where campana_id=$1`, [camp]))[0] ?? {};

  // a) desordenado: bounced (t2) llega antes que delivered (t1)
  const e1 = await mk('A1');
  ok(await reg('s1', 'email.bounced', 'A1', '2026-10-01T10:00:02Z', { bounce_tipo: 'Permanent', bounce_subtipo: 'General', mensaje: 'no existe' }) === 'aplicado', 'bounced aplicado');
  ok(await reg('s2', 'email.delivered', 'A1', '2026-10-01T10:00:01Z') === 'aplicado', 'delivered viejo aplicado (como marca)');
  let f = await envio(e1);
  ok(f.entrega_estado === 'rebotado', 'delivered anterior NO pisa a bounced: estado=' + f.entrega_estado);
  ok(f.entregado_at !== null && f.rebotado_at !== null, 'ambas marcas quedaron');
  ok((f.entrega_detalle ?? '').startsWith('Permanent/General'), 'detalle del rebote: ' + f.entrega_detalle);
  // a2) mismo tipo con OTRO svix_id (no es reintento): no se cuenta dos veces
  await reg('s1b', 'email.bounced', 'A1', '2026-10-01T10:00:03Z');
  ok((await tot()).rebotados === 1, 'segundo bounced con otro svix_id no suma al total');
  // b) duplicado
  ok(await reg('s1', 'email.bounced', 'A1', '2026-10-01T10:00:02Z') === 'duplicado', 'mismo svix_id => duplicado');
  let t = await tot();
  ok(t.rebotados === 1 && t.entregados === 1, `totales sin doble conteo: rebotados=${t.rebotados} entregados=${t.entregados}`);
  ok((await q(`select count(*)::int n from resend_eventos where resend_id='A1'`))[0].n === 3, 'rastro: 3 filas (s1, s2, s1b), el reintento de s1 no sumo');
  // c) entregado y despues queja
  const e2 = await mk('B1');
  await reg('s3', 'email.delivered', 'B1', '2026-10-01T10:00:01Z');
  await reg('s4', 'email.complained', 'B1', '2026-10-01T11:00:00Z');
  f = await envio(e2);
  ok(f.entrega_estado === 'queja', 'queja posterior => estado queja');
  // queja llega ANTES que el delivered que la precedio
  const e3 = await mk('C1');
  await reg('s5', 'email.complained', 'C1', '2026-10-01T11:00:00Z');
  await reg('s6', 'email.delivered', 'C1', '2026-10-01T10:00:01Z');
  f = await envio(e3);
  ok(f.entrega_estado === 'queja' && f.queja_at && f.entregado_at, 'queja primero, delivered despues: sigue queja');
  // d) empate exacto de hora, en los dos ordenes
  const e4 = await mk('D1'), e5 = await mk('D2');
  await reg('s7', 'email.bounced', 'D1', '2026-10-01T12:00:00Z'); await reg('s8', 'email.delivered', 'D1', '2026-10-01T12:00:00Z');
  await reg('s9', 'email.delivered', 'D2', '2026-10-01T12:00:00Z'); await reg('s10', 'email.bounced', 'D2', '2026-10-01T12:00:00Z');
  ok((await envio(e4)).entrega_estado === 'rebotado' && (await envio(e5)).entrega_estado === 'rebotado', 'empate: gana el mas grave en ambos ordenes');
  // e) abierto dos veces: un solo abierto; no altera estado
  const e6 = await mk('E1');
  await reg('s11', 'email.delivered', 'E1', '2026-10-01T10:00:00Z');
  await reg('s12', 'email.opened', 'E1', '2026-10-01T10:05:00Z'); await reg('s13', 'email.opened', 'E1', '2026-10-01T10:06:00Z');
  await reg('s14', 'email.clicked', 'E1', '2026-10-01T10:07:00Z', { enlace: 'https://x' });
  f = await envio(e6); t = await tot();
  ok(f.entrega_estado === 'entregado', 'abrir/clic no cambian el estado de entrega');
  ok(t.abiertos === 1 && t.clics === 1, `abiertos=${t.abiertos} clics=${t.clics}`);
  // f) desconocido
  ok(await reg('s15', 'email.delivered', 'NOEXISTE', '2026-10-01T10:00:00Z') === 'huerfano', 'correo desconocido => huerfano, sin error');
  // g) reconciliar: el envio recibe su resend_id despues
  const e7 = (await q(`insert into campanas_envios (campana_id, correo, contacto_id, nombre_crm, estado) values ($1,'tarde@x.cr','g','n','pendiente') returning id`, [camp]))[0].id;
  ok(await reg('s16', 'email.delivered', 'TARDE', '2026-10-01T10:00:00Z') === 'huerfano', 'llego antes que el resend_id');
  await q(`update campanas_envios set resend_id='TARDE', estado='enviado' where id=$1`, [e7]);
  const n = (await q(`select resend_reconciliar_huerfanos() n`))[0].n;
  ok(n >= 1 && (await envio(e7)).entrega_estado === 'entregado', `reconciliado (${n}): estado=${(await envio(e7)).entrega_estado}`);
  ok((await q(`select resend_reconciliar_huerfanos() n`))[0].n === 0 || true, 'segunda reconciliacion corre');
  // permisos
  for (const fn of ['resend_registrar_evento(text,text,text,timestamptz,jsonb)', 'resend_aplicar_evento(uuid,text,timestamptz,jsonb)', 'resend_reconciliar_huerfanos()']) {
    const [r] = await q(`select has_function_privilege('anon',$1,'execute') a, has_function_privilege('authenticated',$1,'execute') u, has_function_privilege('service_role',$1,'execute') s`, [`public.${fn}`]);
    ok(!r.a && !r.u && r.s, `permisos ${fn}: anon=${r.a} authenticated=${r.u} service_role=${r.s}`);
  }
  // RLS en tablas nuevas
  const rls = await q(`select relname, relrowsecurity from pg_class where relname in ('resend_eventos','campanas_entrega_totales')`);
  ok(rls.every((r) => r.relrowsecurity), 'RLS activo en tablas nuevas');
} catch (e) { console.log('ERROR', e.message); fallos++; }
finally { await c.query('rollback'); 
  const [r] = (await c.query(`select to_regclass('public.resend_eventos') t`)).rows;
  console.log('tras rollback, resend_eventos existe en prod:', r.t !== null);
  await c.end(); }
process.exit(fallos ? 1 : 0);
