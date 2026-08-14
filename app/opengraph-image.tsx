import { ImageResponse } from 'next/og';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Luxe Essentials — Manufactura textil en Guatemala';

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: 80,
          background: 'linear-gradient(135deg, #1A2634 0%, #2F4156 55%, #567C8D 100%)',
        }}
      >
        <div style={{ fontSize: 30, letterSpacing: 12, color: '#C8D9E6' }}>LUXE ESSENTIALS</div>
        <div style={{ fontSize: 62, color: '#F5EFEB', marginTop: 28, lineHeight: 1.15 }}>
          Manufactura textil con planta propia en Guatemala
        </div>
      </div>
    ),
    size,
  );
}
