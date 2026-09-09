// tests/campanas-progreso.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { progresoCampana, listarCampanas, type Db } from '@/lib/campanas/progreso';

type FilaEnvio = { id: string; campana_id: string; estado: 'pendiente' | 'enviado' | 'error' };
type FilaCampana = {
  id: string;
  zona?: string | null;
  plantilla: string;
  asunto: string;
  creado_por: string;
  creado_at: string;
  cancelada_at?: string | null;
  cancelada_por?: string | null;
};

let envios: FilaEnvio[];
let campanas: FilaCampana[];
let errorConteo: { message: string } | null;
let errorListado: { message: string } | null;
let llamadasConteo: { campana_id: string; estado?: string }[];

// Doble mínimo de Supabase: sólo cubre lo que progreso.ts de verdad usa --
// `.select(col, {count,head}).eq(...).eq(...)?` como thenable de conteo, y
// `.select(cols).order(...)` como thenable de listado.
function construirDb(): Db {
  return {
    from(tabla: string) {
      if (tabla === 'campanas_envios') {
        const filtros: [string, unknown][] = [];
        let esConteo = false;
        const nodo: any = {
          select(_cols: string, opciones?: { count?: string; head?: boolean }) {
            esConteo = Boolean(opciones?.head);
            return nodo;
          },
          eq(columna: string, valor: unknown) {
            filtros.push([columna, valor]);
            return nodo;
          },
          then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
            const promesa = (async () => {
              if (!esConteo) throw new Error('El doble sólo soporta conteos (select con head:true).');
              const campanaId = filtros.find(([c]) => c === 'campana_id')?.[1] as string | undefined;
              const estado = filtros.find(([c]) => c === 'estado')?.[1] as string | undefined;
              llamadasConteo.push({ campana_id: campanaId ?? '', estado });
              if (errorConteo) return { count: null, error: errorConteo };
              const count = envios.filter(
                (e) => e.campana_id === campanaId && (estado === undefined || e.estado === estado),
              ).length;
              return { count, error: null };
            })();
            return promesa.then(resolve, reject);
          },
        };
        return nodo;
      }
      if (tabla === 'campanas') {
        const nodo: any = {
          select() {
            return nodo;
          },
          order() {
            return (async () => {
              if (errorListado) return { data: null, error: errorListado };
              return {
                data: [...campanas].sort((a, b) => (a.creado_at < b.creado_at ? 1 : -1)),
                error: null,
              };
            })();
          },
        };
        return nodo;
      }
      throw new Error(`Tabla no soportada en el doble: ${tabla}`);
    },
  };
}

beforeEach(() => {
  envios = [];
  campanas = [];
  errorConteo = null;
  errorListado = null;
  llamadasConteo = [];
});

describe('progresoCampana', () => {
  it('cuenta enviados, fallidos, pendientes y el total, cada uno por separado', async () => {
    envios = [
      { id: '1', campana_id: 'c1', estado: 'enviado' },
      { id: '2', campana_id: 'c1', estado: 'enviado' },
      { id: '3', campana_id: 'c1', estado: 'error' },
      { id: '4', campana_id: 'c1', estado: 'pendiente' },
      { id: '5', campana_id: 'c1', estado: 'pendiente' },
      { id: '6', campana_id: 'c1', estado: 'pendiente' },
      // De otra campaña -- no debe contarse.
      { id: '7', campana_id: 'c2', estado: 'pendiente' },
    ];
    const resultado = await progresoCampana(construirDb(), 'c1');
    expect(resultado).toEqual({ total: 6, enviados: 2, fallidos: 1, pendientes: 3 });
  });

  it('una campaña sin filas da todo en cero, no un error', async () => {
    const resultado = await progresoCampana(construirDb(), 'vacia');
    expect(resultado).toEqual({ total: 0, enviados: 0, fallidos: 0, pendientes: 0 });
  });

  it('hace las cuatro consultas correctas (total + los tres estados) y ninguna de más', async () => {
    envios = [{ id: '1', campana_id: 'c1', estado: 'pendiente' }];
    await progresoCampana(construirDb(), 'c1');
    expect(llamadasConteo).toHaveLength(4);
    const estados = llamadasConteo.map((l) => l.estado).sort();
    expect(estados).toEqual([undefined, 'enviado', 'error', 'pendiente'].sort());
    expect(llamadasConteo.every((l) => l.campana_id === 'c1')).toBe(true);
  });

  it('un error de la base se propaga (lanza), nunca vuelve como un conteo en cero silencioso', async () => {
    errorConteo = { message: 'fallo simulado' };
    await expect(progresoCampana(construirDb(), 'c1')).rejects.toThrow(/fallo simulado/);
  });
});

describe('listarCampanas', () => {
  it('devuelve las campañas más recientes primero, cada una con su progreso', async () => {
    campanas = [
      { id: 'c1', plantilla: 'inicial', asunto: 'Asunto 1', creado_por: 'Ana', creado_at: '2026-01-01T00:00:00Z' },
      {
        id: 'c2',
        plantilla: 'seguimiento_1',
        asunto: 'Asunto 2',
        creado_por: 'Beto',
        creado_at: '2026-02-01T00:00:00Z',
      },
    ];
    envios = [
      { id: '1', campana_id: 'c1', estado: 'enviado' },
      { id: '2', campana_id: 'c2', estado: 'pendiente' },
    ];
    const resultado = await listarCampanas(construirDb());
    expect(resultado.map((f) => f.id)).toEqual(['c2', 'c1']);
    expect(resultado[0].progreso).toEqual({ total: 1, enviados: 0, fallidos: 0, pendientes: 1 });
    expect(resultado[1].progreso).toEqual({ total: 1, enviados: 1, fallidos: 0, pendientes: 0 });
  });

  it('sin campañas, devuelve un arreglo vacío', async () => {
    const resultado = await listarCampanas(construirDb());
    expect(resultado).toEqual([]);
  });

  // Punto 2 del encargo (hallazgo importante, revisión final): sin esto no
  // había forma de saber, mirando el historial, a qué zona se le escribió.
  // `null` para una campaña vieja (creada antes de la migración 0022, que
  // no tiene el dato) -- nunca una cadena vacía ni un valor inventado.
  it('trae la zona de cada campaña -- null para una campaña vieja sin ese dato', async () => {
    campanas = [
      { id: 'c1', zona: 'GAM Oeste', plantilla: 'inicial', asunto: 'A', creado_por: 'Ana', creado_at: '2026-01-01T00:00:00Z' },
      { id: 'c2', plantilla: 'inicial', asunto: 'B', creado_por: 'Beto', creado_at: '2026-02-01T00:00:00Z' },
    ];
    const resultado = await listarCampanas(construirDb());
    expect(resultado.find((f) => f.id === 'c1')!.zona).toBe('GAM Oeste');
    expect(resultado.find((f) => f.id === 'c2')!.zona).toBeNull();
  });

  // Punto 1 del encargo ("cancelar"): el historial tiene que decir cuándo y
  // quién canceló una campaña -- `null` en las dos para la que sigue
  // activa, y los valores reales para la cancelada.
  it('trae canceladaAt/canceladaPor -- null para una campaña activa, con valor para una cancelada', async () => {
    campanas = [
      { id: 'c1', plantilla: 'inicial', asunto: 'Activa', creado_por: 'Ana', creado_at: '2026-01-01T00:00:00Z', cancelada_at: null, cancelada_por: null },
      {
        id: 'c2',
        plantilla: 'inicial',
        asunto: 'Cancelada',
        creado_por: 'Beto',
        creado_at: '2026-02-01T00:00:00Z',
        cancelada_at: '2026-02-02T00:00:00Z',
        cancelada_por: 'Ana Solano',
      },
    ];
    const resultado = await listarCampanas(construirDb());
    const activa = resultado.find((f) => f.id === 'c1')!;
    const cancelada = resultado.find((f) => f.id === 'c2')!;
    expect(activa.canceladaAt).toBeNull();
    expect(activa.canceladaPor).toBeNull();
    expect(cancelada.canceladaAt).toBe('2026-02-02T00:00:00Z');
    expect(cancelada.canceladaPor).toBe('Ana Solano');
  });

  it('un error al listar se propaga', async () => {
    errorListado = { message: 'no se pudo leer campanas' };
    await expect(listarCampanas(construirDb())).rejects.toThrow(/no se pudo leer campanas/);
  });
});
