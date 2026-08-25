# Base comercial 2026 → GoHighLevel

Análisis del folder `Database/` y esquema de campos personalizados para la importación.

## 1. Qué hay en el folder

14 archivos `.xlsx`, **todos con el mismo esquema de 17 columnas**.

| Archivo | Hojas | Registros |
|---|---|---|
| `00_Indice_Rutas_Luxe_2026.xlsx` | Resumen de rutas · Base consolidada · Revisión | 3.340 + 526 |
| `01`–`12` (por zona) | Resumen · Clientes | 2.814 en total |
| `13_Revision_manual.xlsx` | Resumen · Revisión | 526 |

**Los archivos 01–13 son una partición exacta del maestro** (500+199+234+200+289+199+312+27+201+236+327+90+526 = 3.340). Importar el maestro *y* los archivos por zona duplicaría toda la base.

> **Fuente única de verdad: `00_Indice_Rutas_Luxe_2026.xlsx` → hoja `Base consolidada`.** Los encabezados están en la **fila 3**; los datos arrancan en la fila 4.

## 2. Las 17 columnas

| # | Columna | Llenado | Únicos | Lectura |
|---|---|---|---|---|
| 0 | Fila origen | 100% | 3.340 | ID de la fila en el ERP. Sirve de trazabilidad. |
| 1 | Nombre | 100% | 3.091 | Razón social. Trae ruido contable (`-PAGOS-`, `(TK)`, `CUENTA MAESTRA`). |
| 2 | Contribuyente | 100% | 2.882 | Cédula. 1.621 son `3101` (S.A.), 949 `3102` (S.R.L.), 597 física, 9 `ND`. |
| 3 | Estado | 100% | 2 | 3.338 Activo · 2 Inactivo. |
| 4 | E-Mail | 79% | 2.438 | 2.568 válidos, 62 malformados, 23 `ND`, 687 vacíos. |
| 5 | Alias | 99% | 3.051 | Nombre comercial. 115 son `ND`. |
| 6 | Zona original | 100% | 2 | **ON / OFF = canal.** ON (2.309) = on-premise/HORECA. OFF (1.031) = off-premise/retail. |
| 7 | Teléfono | 99% | 2.776 | 3.297 con 8 dígitos. **124 son `88888888` (relleno).** 21 con formato roto. |
| 8 | Dirección original | 99% | 3.221 | Texto crudo del ERP con prefijo `DETALLE:`. |
| 9 | Dirección normalizada | 98% | 3.207 | Ya limpia. 87 son inservibles (`.`, `ND`, vacías). |
| 10 | Zona comercial | 100% | **13** | Macro-zona. |
| 11 | Subzona / ruta | 100% | **29** | Subzona operativa. |
| 12 | Ruta sugerida | 100% | **29** | `CÓDIGO \| Subzona`. Redundante con 10+11. |
| 13 | Orden sugerido de visita | 84% | 500 | Secuencia dentro del bloque. Vacío en los 526 sin ruta. |
| 14 | Confianza ubicación | 100% | 3 | Alta 2.510 · Media 304 · Baja 526. |
| 15 | Criterio de ubicación | 100% | 3 | Dirección 2.746 · Alias/dirección 68 · Sin coincidencia 526. |
| 16 | Observaciones | 100% | 5 | Frases fijas que explican la confianza. Derivable de 14+15. |

### Distribución por zona comercial

GAM Oeste 500 · Pacífico Sur 327 · Guanacaste Costa 312 · Alajuela/Occidente 289 · Pacífico Central 236 · GAM Este/Cartago 234 · Península Nicoya 201 · Heredia/Norte GAM 200 · GAM Centro 199 · Zona Norte 199 · Caribe 90 · Guanacaste Interior 27 · **Revisión manual 526**

## 3. Riesgos de la importación (leer antes de subir nada)

| Riesgo | Magnitud | Qué hacer |
|---|---|---|
| **GHL fusiona por email/teléfono** | 339 registros comparten email · 711 comparten teléfono | Importar con *deduplicación desactivada*. Si no, las 9 sucursales de Starbucks (`starbuckscr@facturar.cr`) colapsan en un contacto. |
| **Teléfono relleno `88888888`** | 124 registros | Vaciar el campo antes de importar. Con dedupe activo, los 124 se fusionan en uno. |
| **Emails con varias direcciones** | 28 registros (`a@x.com; b@y.com`) | Primera dirección → Email nativo. El resto → `emails_adicionales`. |
| **Emails malformados** | 62 (`ubertini#hotmail.com`, `NT`, una dirección física) | Vaciar y marcar `dato-invalido`. |
| **Teléfonos sin formato E.164** | 3.315 en formato local de 8 dígitos | Prefijar `+506`. Sin esto no hay SMS ni WhatsApp. |
| **Registros contables/test** | 77 (`-PAGOS-`, `CUENTA MAESTRA`, `(TK)`, `CLIENTE CONTADO`, `Test Novazys`) | Tag `no-prospectar`. No son prospectos reales. |
| **Direcciones inservibles** | 87 | Tag `sin-direccion`. |
| **Contactabilidad real** | 2.490 con email+teléfono · 683 solo teléfono · 113 solo email · **54 sin ninguno** | Los 54 no se pueden importar como contactos accionables. |

## 4. Mapeo a campos nativos (NO crear personalizados para esto)

| Origen | Campo nativo GHL |
|---|---|
| Alias (nombre comercial) | **First Name** — es lo que se ve en la lista |
| Nombre (razón social) | **Company Name** |
| E-Mail (primera dirección válida) | **Email** |
| Teléfono → `+506XXXXXXXX` | **Phone** |
| Dirección normalizada | **Address Line 1** |
| Subzona / ruta | **City** |
| — | **Country** = `CR` |
| — | **Source** = `Base ERP 2026` |
| — | **Contact Type** = `Lead` |

## 5. Campos personalizados a crear

Carpeta: **`Luxe · Base Comercial 2026`**

| # | Nombre | Tipo | Key | Opciones |
|---|---|---|---|---|
| 1 | Cédula / Contribuyente | Texto | `cedula_contribuyente` | — |
| 2 | Tipo de contribuyente | Desplegable | `tipo_contribuyente` | Jurídica S.A. · Jurídica S.R.L. · Otra jurídica · Física · Sin dato |
| 3 | Canal comercial | Desplegable | `canal_comercial` | On-Premise (HORECA) · Off-Premise (Retail) |
| 4 | Estado en ERP | Desplegable | `estado_erp` | Activo · Inactivo |
| 5 | ID origen ERP | Numérico | `id_origen_erp` | — |
| 6 | Zona comercial | Desplegable | `zona_comercial` | 13 valores |
| 7 | Subzona / ruta | Desplegable | `subzona_ruta` | 29 valores |
| 8 | Código de ruta | Desplegable | `codigo_ruta` | GO·GC·GE·HN·AO·ZN·GNC·GNI·PN·PC·PS·CA·SIN RUTA |
| 9 | Orden sugerido de visita | Numérico | `orden_visita` | — |
| 10 | Confianza de ubicación | Desplegable | `confianza_ubicacion` | Alta · Media · Baja |
| 11 | Criterio de ubicación | Desplegable | `criterio_ubicacion` | Dirección · Alias y dirección · Sin coincidencia |
| 12 | Observaciones de ubicación | Texto largo | `observaciones_ubicacion` | — |
| 13 | Dirección original ERP | Texto largo | `direccion_original_erp` | — |
| 14 | Emails adicionales | Texto | `emails_adicionales` | — |
| 15 | Teléfono alternativo | Teléfono | `telefono_alterno` | — |
| 16 | Calidad del dato | Desplegable | `calidad_dato` | Completo · Falta email · Falta teléfono · Falta email y teléfono · Dirección insuficiente · Dato placeholder |
| 17 | Segmento de negocio | Desplegable | `segmento_negocio` | Hotel · Resort · Restaurante · Cafetería · Bar · Panadería · Catering · Supermercado · Abastecedor · Tienda de conveniencia · Distribuidor · Spa & Wellness · Oficina & Corporativo · Otro · Por clasificar |
| 18 | Fecha de próxima visita | Fecha | `proxima_visita` | — |
| 19 | Origen del registro | Desplegable | `origen_registro` | Base ERP 2026 · Landing · Referido · Prospección en campo |

**Nota sobre #17:** no viene en los datos. Se crea vacío (`Por clasificar`) y se enriquece después — es la segmentación que más le importa a Luxe, porque define qué línea de textil se ofrece.

## 6. Tags

Los tags son para disparar workflows y segmentar rápido; los desplegables son para filtrar en smart lists. No duplicar todo como tag.

```
origen-erp-2026
canal-on-premise / canal-off-premise
zona-gam-oeste / zona-gam-centro / zona-gam-este-cartago / zona-heredia-norte-gam
zona-alajuela-occidente / zona-zona-norte / zona-guanacaste-costa / zona-guanacaste-interior
zona-peninsula-nicoya / zona-pacifico-central / zona-pacifico-sur / zona-caribe
zona-revision-manual
ubicacion-confirmar        (confianza Media)
ubicacion-sin-datos        (confianza Baja / los 526)
sin-email                  (800 aprox.)
sin-telefono               (167 aprox.)
telefono-placeholder       (124)
email-compartido           (339)
posible-duplicado          (cédula repetida)
sin-direccion              (87)
no-prospectar              (77 registros contables/test)
```

## 7. Orden de trabajo

1. Crear los 19 campos personalizados (prompt de la sección 8).
2. Limpiar el CSV: E.164, vaciar placeholders, separar emails múltiples, calcular `calidad_dato` y `tipo_contribuyente`.
3. Importar **solo** `Base consolidada` (3.340), con dedupe desactivado, en lotes por zona.
4. Los 526 de `Revisión` entran con tag `ubicacion-sin-datos` y sin ruta asignada.
5. Enriquecer `segmento_negocio` en una segunda pasada.

Ya existe acceso API a GHL en este repo (`lib/ghl.ts`, `scripts/ghl-discover.mjs`, credenciales en `.env.local`), así que los campos también se pueden crear vía `POST /locations/{locationId}/customFields` si la IA de GHL se queda corta.

## 8. Importación ejecutada

**3.340 contactos creados** en la subcuenta `NvzW6XEGkUCoKxulcRGG` (Luxe Essentials), sin duplicados: los 3.340 `ID origen ERP` mapean a 3.340 `contactId` únicos.

Se usó `POST /contacts/` y **no** `/contacts/upsert`: en esta base los emails y teléfonos repetidos son sucursales distintas, no duplicados a fusionar. Requiere `allowDuplicateContact: true` en la subcuenta, verificado antes de correr.

| Tag | Contactos |
|---|---|
| `origen-erp-2026` | 3.340 |
| `canal-on-premise` | 2.309 |
| `canal-off-premise` | 1.031 |
| `zona-revision-manual` | 526 |
| `ubicacion-sin-datos` | 526 |
| `sin-email` | 735 |
| `email-compartido` | 339 |
| `telefono-placeholder` | 127 |
| `no-prospectar` | 75 |

### Dos correos que GHL rechazó con 422

- **ERP 1766 · CAFE ROJO** — `facturas:caferojosanjose@gmail.com`. El `facturas:` es una etiqueta de captura del ERP pegada al correo. Se quitó el prefijo.
- **ERP 2771 · No Hay Dos Sin Tres** — `tapisytapascr.@gmail.com`, con punto pegado a la arroba. **Quedó sin email**: la reparación no es única (`tapisytapascr@` o `tapisytapas.cr@`) y adivinar significa escribirle a un desconocido. Lleva tag `email-formato-revisar`.

## 9. Enriquecimiento de `segmento_negocio`

`scripts/clasificar-segmento.mjs` infiere el segmento por patrones sobre el nombre.

**El nombre comercial manda; la razón social es sólo respaldo acotado.** La sociedad dueña describe el vehículo legal, no el local: `MATSURI SABANA` está inscrito como `CO DISTRIBUIDORA ORIENTAL S.A` y no es un distribuidor. El respaldo por razón social se limita a los rubros que sí nombran al establecimiento — quedan fuera Distribuidor y Spa & Wellness, que resultaron ser ruido de sociedad tenedora.

Criterio general: **precisión por encima de cobertura**. Ante duda queda `Por clasificar`, porque un segmento equivocado manda la oferta de textil incorrecta y eso cuesta más que un campo vacío.

Cobertura: **1.785 de 3.340 (53%)**.

| Segmento | Contactos |
|---|---|
| Restaurante | 792 |
| Supermercado | 213 |
| Hotel | 209 |
| Tienda de conveniencia | 199 |
| Cafetería | 163 |
| Bar | 74 |
| Panadería | 44 |
| Resort | 41 |
| Distribuidor | 31 |
| Catering | 15 |
| Abastecedor | 3 |
| Spa & Wellness | 1 |
| *Por clasificar* | *1.555* |

Los 1.555 restantes son marcas sin sustantivo de rubro (`BACCHUS`, `LA ALACENA`, `POMODORO`) o nombres de persona física. No se pueden resolver por patrón; requieren revisión humana o una pasada con LLM.

**Sin marca de procedencia en GHL.** Todos los valores actuales son inferidos, así que la distinción "inferido vs. confirmado" no aporta todavía; agregar un tag habría exigido reenviar el arreglo completo de tags en cada `PUT`, con riesgo de pisar tags puestos a mano. El detalle fila por fila queda en `out/ghl/segmentos.csv`.
