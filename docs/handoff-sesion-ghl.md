# Handoff — sesión de carga de la base comercial a GoHighLevel

Contexto para otra sesión que vaya a commitear o desplegar. **Nada de esto tocó
la aplicación web**: no hay cambios en componentes, rutas, estilos ni build.
Todo el trabajo fue de datos contra la API de GHL, más tres scripts de utilería.

## Qué se hizo

1. **Análisis de `Database/`** — 14 archivos `.xlsx` con 3.340 clientes potenciales
   de Costa Rica. Los archivos `01`–`13` resultaron ser una partición exacta del
   maestro `00_Indice_Rutas_Luxe_2026.xlsx`, así que la fuente única es la hoja
   `Base consolidada` de ese archivo (encabezados en la fila 3).

2. **19 campos personalizados creados en GHL** — carpeta `Luxe · Base Comercial 2026`,
   en la subcuenta `NvzW6XEGkUCoKxulcRGG`. Se crearon desde la UI de GHL con el
   prompt de `docs/ghl-prompt-campos-personalizados.md` y se verificaron por API.

3. **3.340 contactos importados**, sin duplicados. Se usó `POST /contacts/` y **no**
   `/contacts/upsert`, porque en esta base los emails y teléfonos repetidos son
   sucursales distintas (9 Starbucks comparten un correo de facturación), no
   duplicados a fusionar. Requirió `allowDuplicateContact: true` en la subcuenta.

4. **`segmento_negocio` inferido** para 1.785 de 3.340 (53%), por patrones sobre el
   nombre comercial. Verificado por API: la distribución en GHL coincide con el CSV.

## Archivos que dejó esta sesión

**Sin trackear — hay que decidir si entran al repo:**

| Archivo | Qué es |
|---|---|
| `scripts/preparar-base-ghl.mjs` | xlsx → CSV limpio (E.164, emails separados, placeholders vaciados, campos derivados, tags) |
| `scripts/importar-base-ghl.mjs` | Importador vía API v2, reanudable |
| `scripts/clasificar-segmento.mjs` | Inferencia de `segmento_negocio`, reanudable |
| `Database/` | **1,2 MB de datos personales de 3.340 clientes reales**: nombres, cédulas, teléfonos, correos, direcciones |

**Modificado:** `docs/ghl-base-comercial-2026.md` (se le agregaron las secciones 8 y 9).

**Ya commiteado:** `docs/ghl-base-comercial-2026.md` y `docs/ghl-prompt-campos-personalizados.md`
entraron en el commit `243ba14`, que es de otro tema — quedaron barridos por un `git add -A`.

**Ignorado por `.gitignore` (`out/`):** `base-ghl.csv`, `import-state.json`,
`segmentos.csv`, `segmento-aplicados.json`, `por-zona/`.

## Dos advertencias antes de commitear

**1. `Database/` son datos personales de clientes reales.** Si el remoto es público
o compartido con terceros, no debería entrar al repo. Es una decisión del dueño
del proyecto, no algo que deba resolverse con un `git add -A`.

**2. `out/ghl/import-state.json` es el único registro del mapa `ID origen ERP → contactId`.**
Está en `out/`, que está ignorado. Si se borra, se pierde la trazabilidad entre el
ERP y GHL, y un reintento del importador crearía 3.340 contactos duplicados.
Conviene respaldarlo fuera de `out/` antes de cualquier limpieza.

## Lo que NO es de esta sesión

Estos archivos aparecen modificados en el árbol pero los tocó otra ventana, no esta:

```
.env.example
app/metadata.ts
app/robots.ts
app/sitemap.ts
components/sections/Footer.tsx
content/copy.ts
content/media.ts
```

## Estado de despliegue

Los tres scripts son herramientas de línea de comandos que se corren a mano. No
se importan desde la app, no entran al bundle y no afectan el build. **No hay nada
en este trabajo que requiera desplegarse.** Si se despliega, es por los cambios de
la otra ventana, no por estos.

Los scripts leen credenciales de `.env.local` (`LUXE_GHL_API_KEY`, `LUXE_GHL_LOCATION_ID`).
No agregan variables de entorno nuevas ni requieren configuración en Vercel.
