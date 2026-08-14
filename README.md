# Luxe Essentials — Landing

Landing B2B de captación de cotizaciones. Next.js, Supabase y GoHighLevel.

## Puesta en marcha

```bash
npm install
cp .env.example .env.local   # y rellenar los valores
npm run db:migrate
npm run images               # requiere IMÁGENES/ con los originales
npm run dev
```

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor de desarrollo |
| `npm test` | Pruebas con Vitest |
| `npm run images` | Optimiza `IMÁGENES/` a `public/images/` |
| `npm run db:migrate` | Aplica las migraciones de `supabase/migrations/` |
| `node scripts/ghl-discover.mjs` | Diagnostica la conexión con GoHighLevel |

## Dónde tocar qué

- **Texto del sitio:** `content/copy.ts`. No hay texto visible en los componentes.
- **Imágenes:** `content/media.ts` declara cada una. Para añadir una pendiente, colocar el
  archivo en `public/images/<id>.webp` y quitar `pending: true` de su entrada.
- **Fotografía pendiente:** toda la línea de hogar y seis de los siete pasos de proceso.

## Leads

Cada envío se guarda en `public.leads` y luego se sincroniza a GoHighLevel. Si GHL falla, la
fila queda con `ghl_error` poblado y el lead sigue recuperable:

```sql
select id, created_at, email, ghl_error from public.leads where ghl_contact_id is null;
```
