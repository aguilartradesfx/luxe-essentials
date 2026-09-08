# Bandeja de campañas — diseño (fase 6)

Fecha: 2026-09-08

## El problema

Luxe tiene 3.340 contactos en su CRM, zonificados en trece zonas comerciales, y cuatro
plantillas de correo escritas y probadas. No hay forma de mandarles nada: la única vía sería
exportar a mano, pegar en otra herramienta, y perder el rastro de a quién se le escribió.

## Lo que se construye

Una pestaña del panel donde ver los contactos por zona, elegir a quién escribirle, elegir una
de las cuatro plantillas, ajustar el texto, revisar cómo queda, y enviar.

## Decisiones

### El envío se hace por tandas y se puede retomar

Mandar 2.700 correos no cabe en una petición: el servidor la corta antes. El envío se parte en
tandas, cada tanda deja constancia de a quién le llegó, y una campaña interrumpida —por un
corte, por cerrar la pestaña, por un fallo de Resend— **se retoma donde quedó** en vez de
volver a empezar.

Eso obliga a llevar registro por destinatario, no sólo por campaña. Es más trabajo y es lo que
hace la diferencia entre una herramienta y un botón que a veces manda dos veces.

### Nadie recibe el mismo correo dos veces

El registro por destinatario es también el candado: antes de mandar, se descarta a quien ya lo
recibió en esa campaña. Sin eso, retomar una campaña interrumpida sería duplicar correos.

### La lista de excluidos no se puede saltar

`filtrarPermitidosParaCampana` devuelve un tipo que ningún otro código puede construir, así que
la función de enviar no compila si se le pasa la lista sin filtrar. La protección es del
compilador, no de la memoria de quien escriba el código el año que viene.

### El saludo es genérico salvo que el nombre sea claramente de una persona

En la base importada, el campo del nombre casi siempre trae el nombre del negocio: «supermercado
poval», «restaurante ardere», «cafe rojo». «Buenos días, supermercado poval» es peor que no
saludar por nombre.

Regla: se personaliza **sólo** cuando el nombre parece de una persona; ante la duda, «Buenos
días:» a secas. Equivocarse hacia lo genérico no cuesta nada; equivocarse hacia lo personal
avisa que el correo salió de una lista.

Es una heurística y no un modelo: preguntarle a un modelo de lenguaje por cada uno de 2.700
nombres costaría más que la campaña entera, y el error tolerable acá es mínimo.

`{{empresa}}` sí usa ese nombre tal cual: ahí el nombre del negocio es exactamente lo que
corresponde.

### Sólo se edita el texto, nunca la plantilla

Las cuatro plantillas están escritas para sobrevivir a Outlook: tablas, estilos en línea,
comentarios condicionales. Un editor libre las rompería en el primer correo. Lo editable son los
párrafos; el armazón es fijo.

### Se ve antes de enviar

Una previsualización con un destinatario real de la selección —su nombre, su empresa, su enlace
de baja— y el conteo exacto de a cuántos va. Enviar es irreversible y masivo: la confirmación
es el último punto donde un error todavía es gratis.

## Riesgos declarados

**El dominio de envío es nuevo.** Mandar miles de correos de golpe desde `send.luxeessentialscr.com`
hunde su reputación y arrastra también a las cotizaciones, que salen del mismo dominio. El ritmo
de envío se decide aparte, con el dueño del proyecto.

**Los rebotes no se están mirando.** Una lista importada de un ERP tiene correos muertos, y los
rebotes pesan tanto como las marcas de spam. Queda fuera de esta fase, anotado.

## Supuestos, para objetar

- El envío se parte en tandas y se retoma donde quedó.
- Se registra a cada destinatario, no sólo la campaña.
- El saludo es genérico salvo que el nombre sea claramente de persona.
- Se edita el texto, no el diseño.
- Hay previsualización y confirmación antes de enviar.
