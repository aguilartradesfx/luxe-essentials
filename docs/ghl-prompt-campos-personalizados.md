# Prompt para la IA de GoHighLevel

Copiar y pegar tal cual.

---

Necesito que crees los campos personalizados de contacto para esta subcuenta. Voy a importar 3.340 clientes potenciales de Costa Rica (hoteles, restaurantes, cafeterías, supermercados y comercios) provenientes de nuestro ERP, y necesito que la estructura esté lista antes de la importación.

Crea una carpeta de campos personalizados llamada **Luxe · Base Comercial 2026** y dentro de ella crea exactamente estos 19 campos, respetando el nombre, el tipo y las opciones que indico. No agregues campos adicionales y no crees campos personalizados para nombre, email, teléfono, dirección, ciudad ni empresa, porque esos ya existen como campos nativos y los voy a usar tal cual.

**1. Cédula / Contribuyente**
Tipo: Texto (una línea). Clave: `cedula_contribuyente`
Cédula jurídica o física del cliente en Costa Rica. Es el identificador único del negocio.

**2. Tipo de contribuyente**
Tipo: Desplegable (selección única). Clave: `tipo_contribuyente`
Opciones: Jurídica S.A. | Jurídica S.R.L. | Otra jurídica | Física | Sin dato

**3. Canal comercial**
Tipo: Desplegable (selección única). Clave: `canal_comercial`
Opciones: On-Premise (HORECA) | Off-Premise (Retail)

**4. Estado en ERP**
Tipo: Desplegable (selección única). Clave: `estado_erp`
Opciones: Activo | Inactivo

**5. ID origen ERP**
Tipo: Numérico. Clave: `id_origen_erp`
Número de fila del registro en la base original, para trazabilidad.

**6. Zona comercial**
Tipo: Desplegable (selección única). Clave: `zona_comercial`
Opciones: GAM Oeste | GAM Centro | GAM Este / Cartago | Heredia / Norte GAM | Alajuela / Occidente | Zona Norte | Guanacaste Costa | Guanacaste Interior | Península Nicoya | Pacífico Central | Pacífico Sur | Caribe | Revisión manual

**7. Subzona / ruta**
Tipo: Desplegable (selección única). Clave: `subzona_ruta`
Opciones: Escazú / Santa Ana / Oeste | San José centro y sur | San José — subzona por confirmar | Este GAM | Cartago | Heredia | Alajuela / Aeropuerto | Alajuela — subzona por confirmar | Occidente | San Carlos / La Fortuna | Liberia / Papagayo | Tamarindo / Flamingo | Guanacaste — subzona por confirmar | Guanacaste interior | Nicoya / Nosara / Sámara | Cóbano / Santa Teresa | Jacó / Herradura | Monteverde | Puntarenas / Esparza | Puntarenas — subzona por confirmar | Quepos / Manuel Antonio | Costa Ballena | Zona Sur / Osa | Pérez Zeledón | Caribe norte | Limón centro | Limón — subzona por confirmar | Talamanca / Puerto Viejo | Sin ubicación confiable

**8. Código de ruta**
Tipo: Desplegable (selección única). Clave: `codigo_ruta`
Opciones: GO | GC | GE | HN | AO | ZN | GNC | GNI | PN | PC | PS | CA | SIN RUTA

**9. Orden sugerido de visita**
Tipo: Numérico. Clave: `orden_visita`
Posición del cliente dentro de la secuencia de visita de su ruta.

**10. Confianza de ubicación**
Tipo: Desplegable (selección única). Clave: `confianza_ubicacion`
Opciones: Alta | Media | Baja

**11. Criterio de ubicación**
Tipo: Desplegable (selección única). Clave: `criterio_ubicacion`
Opciones: Dirección | Alias y dirección | Sin coincidencia

**12. Observaciones de ubicación**
Tipo: Texto largo / área de texto. Clave: `observaciones_ubicacion`
Nota que explica por qué la ubicación tiene ese nivel de confianza.

**13. Dirección original ERP**
Tipo: Texto largo / área de texto. Clave: `direccion_original_erp`
Dirección cruda tal como viene del ERP, sin limpiar. Se conserva como respaldo.

**14. Emails adicionales**
Tipo: Texto (una línea). Clave: `emails_adicionales`
Correos secundarios separados por punto y coma, cuando el cliente tiene más de uno.

**15. Teléfono alternativo**
Tipo: Teléfono. Clave: `telefono_alterno`

**16. Calidad del dato**
Tipo: Desplegable (selección única). Clave: `calidad_dato`
Opciones: Completo | Falta email | Falta teléfono | Falta email y teléfono | Dirección insuficiente | Dato placeholder

**17. Segmento de negocio**
Tipo: Desplegable (selección única). Clave: `segmento_negocio`
Opciones: Hotel | Resort | Restaurante | Cafetería | Bar | Panadería | Catering | Supermercado | Abastecedor | Tienda de conveniencia | Distribuidor | Spa & Wellness | Oficina & Corporativo | Otro | Por clasificar

**18. Fecha de próxima visita**
Tipo: Fecha. Clave: `proxima_visita`

**19. Origen del registro**
Tipo: Desplegable (selección única). Clave: `origen_registro`
Opciones: Base ERP 2026 | Landing | Referido | Prospección en campo

Cuando termines, devuélveme la lista de los 19 campos creados con su clave interna exacta (`custom_field` key) para poder mapear el CSV en la importación. Si algún tipo de campo no existe con ese nombre en la plataforma, usa el equivalente más cercano y avísame cuál elegiste.
