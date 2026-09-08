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

## Botón a cotización y botón a WhatsApp

`inicial.html`, `seguimiento_1.html` y `seguimiento_2.html` llevan, justo antes de la firma, DOS
botones lado a lado (`class="stack"` para que se apilen en móvil, no se aprieten): el botón
lleno a `#cotizacion` (acción principal, el que ya existía) y uno con borde a
`wa.me/50661402511` con un mensaje ya escrito por `?text=` (acción directa, nueva). Los dos son
parte del armazón fijo de cada plantilla, igual que el resto de esta carpeta: no se editan por
campaña.

`seguimiento_3.html` (la de cierre) **no lleva ninguno de los dos a propósito** — el texto de
esa plantilla dice explícitamente que no se quiere insistir, y un botón justo después
contradiría ese mensaje. Ver el comentario en el propio archivo.

Si agregás o cambiás algo en este bloque: la firma de estilo que usa `lib/campanas/edicion.ts`
para reconocer un párrafo editable es `<p style="margin:0 0 Npx 0;font-family:Arial,Helvetica,
sans-serif;font-size:16px;line-height:1.65;color:#26292E;">` — no la reutilices en un `<td>` ni
en ningún elemento de este bloque, o `edicion.ts` lo va a contar (mal) como texto editable de la
campaña.
