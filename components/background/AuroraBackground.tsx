// Alfas de las manchas: bajados de teal/40 y sky/25 (valores originales de
// §8.1) tras medir que erosionaban el contraste AA del texto sky que se
// dibuja directamente sobre el aurora (p.ej. el subtítulo del hero y los
// párrafos de Capacidad, que no viven dentro de una GlassCard). Ver el
// reporte de esta tarea para las cifras de contraste antes/después.
export function AuroraBackground() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div className="absolute -left-40 -top-40 h-[38rem] w-[38rem] rounded-full bg-teal/25 blur-[120px] motion-safe:animate-[aurora-a_28s_ease-in-out_infinite]" />
      <div className="absolute -right-40 top-1/3 h-[34rem] w-[34rem] rounded-full bg-sky/12 blur-[130px] motion-safe:animate-[aurora-b_34s_ease-in-out_infinite]" />
      <div className="absolute bottom-[-12rem] left-1/3 h-[30rem] w-[30rem] rounded-full bg-navy/70 blur-[110px] motion-safe:animate-[aurora-c_40s_ease-in-out_infinite]" />
    </div>
  );
}
