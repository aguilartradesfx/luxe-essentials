import { AuroraBackground } from '@/components/background/AuroraBackground';
import { Header } from '@/components/sections/Header';
import { Hero } from '@/components/sections/Hero';
import { Capacidad } from '@/components/sections/Capacidad';
import { Cifras } from '@/components/sections/Cifras';
import { Lineas } from '@/components/sections/Lineas';

export default function Home() {
  return (
    <>
      <AuroraBackground />
      <Header />
      <main>
        <Hero />
        <Capacidad />
        <Cifras />
        <Lineas />
      </main>
    </>
  );
}
