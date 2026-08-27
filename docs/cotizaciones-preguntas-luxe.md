# Cotizador — preguntas pendientes para Luxe

Siete definiciones comerciales que faltan para terminar el motor de precios.
Todas salen de revisar `uniformes precios 2026 .xlsx` y `precios ropa de cama 2026 .xlsx`.

Mientras no lleguen las respuestas, el código corre con los supuestos de la última
columna. Cada supuesto está en `lib/cotizador/catalogo.ts` y se cambia sin tocar lógica.

## Bloqueantes del cálculo

**1. ¿La escala mira cada producto o la cotización completa?**
Ejemplo real: un hotel pide 20 filipinas y 20 pantalones. ¿Cada renglón se queda sin
descuento por no llegar a 24, o son 40 piezas y todo lleva 5%?
→ *Supuesto: uniformes por producto* (el mínimo de 24 parece un lote de producción por
estilo), *ropa de cama por total de sets de la cotización* (el archivo dice "en la
compra de 10 sets", que se lee como pedido completo).

**2. ¿Qué cuenta como "set" para el umbral de ropa de cama?**
El catálogo tiene toallas, almohadas y una bata, que no son sets.
→ *Supuesto:* solo los juegos de cama cuentan para llegar al umbral. Los accesorios sí
reciben el descuento una vez alcanzado (el archivo les pone columna de descuento), pero
no ayudan a alcanzarlo.

## Presentación al cliente

**3. Los renglones "sábana de X hilos" son sets completos, no sábanas.**
El encabezado dice que el set trae cubrecama, sábana y 2 sobrefundas (1 para individual).
Cotizar "sábana de 600 hilos king — ₡90.000" hace ver que se cobran ₡90.000 por una
sábana.
→ *Se necesita el nombre comercial correcto y el contenido exacto de cada set,* para
desglosarlo en la cotización. ¿"Juego de cama 600 hilos king"?

**4. ¿El IVA se muestra?**
Ambos archivos dicen que los precios no lo incluyen.
→ *Supuesto:* la cotización muestra subtotal, IVA 13% y total, con casilla para marcar
cliente exento. Confirmar si hay exentos y con qué respaldo.

## Limpieza del catálogo

**5. Tallas inconsistentes.**
Siete familias usan `doble`; pillow top usa `matrimonial`. El encabezado menciona
`individual`, que no existe como fila (las tallas son king/queen/doble/imperial).
→ *Supuesto:* `matrimonial` y `doble` son la misma talla, se normaliza a `doble`.
`imperial` se deja como está. ¿`imperial` es lo que llaman `individual`?

**6. Dos precios de toalla que no cuadran.**
- `toalla de pie` cuesta ₡5.000 en 680gm y ₡5.000 en 460gm. En todos los demás tipos la
  de 680gm es más cara que la de 460gm.
- `toalla facial` vs `toalla de mano`: en 680gm la facial cuesta más (₡3.500 vs ₡3.000);
  en 460gm y 360gm cuesta menos. El orden se invierte.
→ *Supuesto: se cargan tal como vienen.* Corregir un precio sin autorización no
corresponde. Si son errores, mandar la corrección.

**7. Almohadas con unidad mezclada.**
"king 2 pack" ₡25.000 y "queen 4 pack" ₡36.000.
→ ¿El precio es por pack o por almohada? ¿Un pack cuenta como 1 pieza o como 2/4 para
el descuento? *Supuesto:* precio por pack, un pack cuenta como 1.

Además, `bata blanca talla única` está suelta sin familia. ¿A qué categoría pertenece?

## Ronda 2 — pendientes tras la respuesta de Guillermo (2026-08-26)

**a. El cambio de "sábana" a "set" no quedó guardado.**
> Revisá el archivo otra vez, porque los renglones siguen diciendo "sábana de 600 hilos",
> "sábana de 400 hilos", etc. Creo que se te guardó una copia distinta. ¿Me lo reenviás
> con el cambio? Y de paso: ¿cómo se llama cada juego en la cotización y qué trae
> exactamente?

**b. Cuatro familias quedaron sin cantidad para el descuento.**
> Quedaron sin cantidad: inserto de duvet, pillow top, funda de duvet rayada 200 hilos, y
> las toallas de 460gm y 360gm. ¿Las toallas de 460 y 360 usan el mismo 24/48 que las de
> 680? ¿Y la funda rayada el mismo 12/24 que la funda normal? Para inserto de duvet y
> pillow top no tengo de dónde deducirlo — ahí necesito los números.

**c. ¿La bata suma con las toallas?**
> Si un cliente compra 15 toallas y una bata, ¿la bata suma a las toallas para llegar a
> las 24, o cada una cuenta por su lado?

**d. Tallas (sin responder en la ronda 1).**
> En pillow top la talla se llama "matrimonial" y en todo lo demás "doble". ¿Es la misma?
> Y el encabezado menciona un set "para individual" que no existe como fila — ¿"imperial"
> es lo que llaman individual?

**e. Precios de toallas (sin responder en la ronda 1).**
> La toalla de pie cuesta ₡5.000 en 680gm y también ₡5.000 en 460gm. Y en 680gm la facial
> cuesta más que la de mano, pero en 460gm y 360gm es al revés. ¿Están bien así?

## Ya resueltas

- **Umbral del 10% en ropa de cama:** 16 sets en adelante (confirmado por Luxe el
  2026-08-26). La escala queda 1–9 lista, 10–15 al 5%, 16+ al 10%. Conviene llenar la
  celda `D3` del archivo para que quede documentado en la fuente.
- **Escala de uniformes:** por cotización completa, no por producto. Las unidades se suman
  entre modelos y tallas. Ejemplo textual de Luxe: 10 pantalones baggy + 30 filipinas + 8
  mandiles = 48 prendas → 10%.
- **Tallas de uniformes:** todas al mismo precio. XXL y similares se consultan aparte.
- **Bordado:** incluido hasta 10×10 cm a un color. Más grande o a varios colores, varía
  según muestra y se cotiza aparte.
- **IVA:** el total va primero y el IVA se suma abajo. Falta confirmar si hay exentos.
- **Bata blanca:** se muestra dentro de la categoría de toallas.
- **Descuentos de ropa de cama:** un umbral por familia, no uno solo para toda la línea.
- **Moneda:** colones (CRC).
- **Método de pago:** la cotización no lo menciona. El vendedor coordina el cobro aparte.
- **Redondeo:** al colón entero, medio hacia arriba. Hoy todos los precios dan exacto,
  pero la regla queda fijada antes de que aparezca un precio que no sea redondo.

---

## Para copiar y pegar

Redactadas para mandarlas tal cual a Luxe, sin jerga técnica.

**1. Escala de uniformes: ¿por producto o por cotización?**
> El descuento de uniformes arranca en 24 unidades. Si un hotel pide 20 filipinas y 20
> pantalones, ¿cada renglón se queda sin descuento por no llegar a 24, o son 40 piezas en
> total y todo lleva el 5%?

**2. Qué cuenta como "set" para el descuento de ropa de cama**
> El descuento de ropa de cama arranca en 10 sets. Pero en la lista también hay toallas,
> almohadas y batas, que no son sets. Dos dudas: si un cliente compra solo 10 toallas y
> nada más, ¿lleva descuento? Y si compra 12 sets de cama y además 20 toallas, ¿las
> toallas también llevan el 5%, o el descuento aplica solo a los sets?

**3. Los renglones que dicen "sábana" en realidad son juegos completos**
> En la lista de ropa de cama los renglones dicen "sábana de 600 hilos king — ₡90.000",
> pero arriba dice que el set incluye cubrecama, sábana y 2 sobrefundas. ¿Ese precio es
> por el juego completo o por la sábana sola? Si es el juego completo, necesito dos cosas:
> cómo quieren que se llame en la cotización que ve el cliente, y qué trae exactamente
> cada juego. Lo pregunto porque mandarle a un hotel una cotización que diga "sábana —
> ₡90.000" se lee como que le estamos cobrando noventa mil colones por una sábana.

**4. IVA**
> Los precios de las dos listas no incluyen IVA. En la cotización que recibe el cliente,
> ¿quieren que aparezca el subtotal, el IVA del 13% y el total por separado, o solo el
> monto sin IVA? ¿Y hay clientes exentos a los que haya que cotizar sin IVA?

**5. Tallas de ropa de cama**
> Casi todas las líneas de ropa de cama usan king, queen, doble e imperial. Pero "pillow
> top" usa "matrimonial" en vez de "doble". ¿Son la misma talla con dos nombres distintos,
> o son dos tallas diferentes? Y el encabezado menciona un set "para individual" con 1
> sobrefunda, pero no hay ninguna fila con esa talla en la lista. ¿"Imperial" es lo que
> ustedes llaman individual, o falta agregar la talla individual?

**6. Dos precios de toallas que parecen erratas**
> Antes de cargarlos quiero confirmar dos precios de la lista de toallas:
> La "toalla de pie" cuesta ₡5.000 tanto en 680gm como en 460gm, el mismo precio en las
> dos. En todos los demás tipos de toalla, la de 680gm es más cara que la de 460gm. ¿Es
> correcto que valgan igual?
> En 680gm, la toalla facial (₡3.500) cuesta más que la toalla de mano (₡3.000). Pero en
> 460gm y en 360gm es al revés: la facial cuesta menos que la de mano. ¿Cuál de los dos
> órdenes es el correcto?

**7. Almohadas**
> En almohadas la lista dice "king 2 pack — ₡25.000" y "queen 4 pack — ₡36.000". ¿El
> precio es por el paquete completo o por almohada? Y para el descuento, ¿un paquete de 2
> cuenta como una unidad o como dos?

**8. Bata blanca**
> La "bata blanca talla única" de ₡25.000 está suelta en la lista, sin categoría. ¿En qué
> grupo va dentro de la cotización: con ropa de cama, con toallas, o como categoría propia?

**9. Bordado del logo**
> En la lista de uniformes hay 22 prendas, pero ningún renglón de bordado ni de aplicación
> de logo. Prácticamente todo hotel o restaurante que pide uniformes los quiere con su
> logo. ¿El bordado va incluido en el precio de la prenda, o se cobra aparte? Si se cobra
> aparte, ¿cuánto y cómo se calcula: por prenda, por cantidad de puntadas, o un cargo
> único por preparar el diseño?

**10. Tallas de uniformes**
> La lista de uniformes tiene un solo precio por prenda, sin distinguir talla. ¿El precio
> es igual para todas las tallas, o las tallas grandes (XL, XXL) tienen un recargo? Y
> cuando un cliente pide 48 filipinas repartidas en varias tallas, ¿las 48 cuentan juntas
> para el descuento aunque sean tallas distintas?

La 9 es la de mayor riesgo: si el bordado se cobra aparte y no está en el sistema, toda
cotización de uniformes sale por debajo del precio real y el vendedor la corrige a mano
cada vez. Es la única que puede obligar a agregar una pieza nueva al motor de precios.
