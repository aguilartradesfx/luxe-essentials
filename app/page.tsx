import { AuroraBackground } from '@/components/background/AuroraBackground';
import { Header } from '@/components/sections/Header';
import { Hero } from '@/components/sections/Hero';

export default function Home() {
  return (
    <>
      <AuroraBackground />
      <Header />
      <main>
        <Hero />
      </main>
    </>
  );
}
