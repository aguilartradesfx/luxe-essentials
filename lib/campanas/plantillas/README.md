# Plantillas de campaña — los originales, tal cual los escribió Luxe

Estos cuatro archivos son la fuente de verdad del diseño de los correos de campaña. **No los
edites para "mejorarlos"**: están escritos para sobrevivir a Outlook —tablas anidadas, estilos
en línea, comentarios condicionales `<!--[if mso]>`— y cualquier limpieza que parezca inocente
rompe el correo en la mitad de los clientes.

Lo único que varía entre una campaña y otra son los párrafos del cuerpo. El armazón es fijo.

Marcadores que usan los cuatro:
- `{{nombre}}`   — el saludo. Se personaliza sólo si el nombre parece de una persona.
- `{{empresa}}`  — el nombre del contacto tal cual viene del CRM (casi siempre el negocio).
- `{{unsubscribe_url}}` — el enlace de baja, firmado, que produce `lib/campanas/`.
