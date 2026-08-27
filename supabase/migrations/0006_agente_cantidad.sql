-- `datos` es jsonb, así que no hace falta cambiar la columna. Se rellena el
-- campo nuevo en las filas existentes para que el agente no lea `undefined`
-- donde el código espera `null`.
update public.agente_conversaciones
   set datos = datos || '{"cantidad": null}'::jsonb
 where not (datos ? 'cantidad');
