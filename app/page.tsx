import { AuroraBackground } from '@/components/background/AuroraBackground';
import { Header } from '@/components/sections/Header';
import { Hero } from '@/components/sections/Hero';
import { Capacidad } from '@/components/sections/Capacidad';
import { Cifras } from '@/components/sections/Cifras';
import { Lineas } from '@/components/sections/Lineas';
import { Proceso } from '@/components/sections/Proceso';
import { Personalizacion } from '@/components/sections/Personalizacion';
import { Cotizacion } from '@/components/sections/Cotizacion';
import { Footer } from '@/components/sections/Footer';

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
        <Proceso />
        <Personalizacion />
        <Cotizacion />
      </main>
      <Footer />
    </>
  );
}
