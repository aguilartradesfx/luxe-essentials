# Listas de precios — fuente

Los archivos originales que manda Luxe. **No son la fuente de verdad del sistema**: el
catálogo vive en `lib/cotizador/catalogo.ts`, y estos quedan versionados para poder
rastrear qué cambió entre rondas.

| Archivo | Última versión |
|---|---|
| `ropa-de-cama-2026.xlsx` | 2026-08-26 20:42 |
| `uniformes-2026.xlsx` | 2026-08-26 17:34 |

## El Excel de ropa de cama está desactualizado en cuatro puntos

Luxe corrigió estas cosas **por escrito** después de mandar el archivo, y nunca las guardó
en él. El catálogo del repositorio lleva la versión correcta.

| Punto | Dice el archivo | Correcto |
|---|---|---|
| Umbral del 10% en sets (`D3`) | `en la compra de 20 sets` | **16 sets** |
| Toalla facial 680gm (fila 53) | ₡3.500 | **₡3.000** |
| Toalla de mano 680gm (fila 54) | ₡3.000 | **₡3.500** |
| Toalla de pie (filas 55, 62, 69) | tres filas, una por gramaje | **una sola, ₡5.000, sin gramaje** |

La corrección de la facial y la de mano no es cosmética: con ella la facial pasa a ser más
barata que la de mano en los tres gramajes, que era la incoherencia detectada al comparar
el catálogo contra sí mismo.

## Antes de cargar una lista nueva

La próxima actualización de precios va a llegar como un Excel nuevo. **Si sale de la copia
que tiene Luxe hoy, reintroduce las cuatro correcciones de arriba de un solo golpe**, y
nadie lo va a notar porque los totales se ven razonables.

Conviene pedirle a Luxe que corrija su copia antes de la siguiente ronda. Mientras eso no
pase, cualquier carga nueva se compara contra esta tabla primero.

## Cómo leerlos

No hay dependencia de Excel en el proyecto. Para inspeccionarlos:

```bash
python3 -c "
import openpyxl, sys
ws = openpyxl.load_workbook(sys.argv[1], data_only=True).worksheets[0]
for r in range(1, ws.max_row+1):
    v = [str(ws.cell(r,c).value or '') for c in range(1, ws.max_column+1)]
    if any(x.strip() for x in v): print(r, ' | '.join(v))
" precios/ropa-de-cama-2026.xlsx
```
