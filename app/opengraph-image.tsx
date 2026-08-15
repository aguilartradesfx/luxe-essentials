import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Luxe Essentials';

// El logotipo es el mismo SVG de la marca, embebido como data URI: el
// renderizador de la imagen social no puede resolver rutas del sitio.
const logo = readFileSync(join(process.cwd(), 'public/brand/logo-dark.svg')).toString('base64');

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#FFFFFF',
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`data:image/svg+xml;base64,${logo}`}
          alt=""
          width={300}
          height={280}
        />
      </div>
    ),
    size,
  );
}
