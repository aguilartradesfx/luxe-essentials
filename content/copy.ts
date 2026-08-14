export const copy = {
  marca: 'Luxe Essentials',

  nav: {
    ariaLabel: 'Principal',
    enlaces: [
      { href: '#capacidad', texto: 'Capacidad' },
      { href: '#lineas', texto: 'Líneas' },
      { href: '#proceso', texto: 'Proceso' },
    ],
    cta: 'Cotizar',
  },

  hero: {
    titulo: 'Fabricamos lo que tu operación viste y usa todos los días.',
    subtitulo:
      'Planta propia en Guatemala. Diseño, corte, bordado, auditoría de calidad y empaque bajo un mismo techo, con capacidad para producción industrial.',
    ctaPrimario: 'Solicitar cotización',
    ctaSecundario: 'Conocer nuestras líneas',
    atributos: [
      'Diseño personalizado',
      'Calidad garantizada',
      'Confección industrial',
      'Imagen que representa',
    ],
  },

  capacidad: {
    titulo: 'Una planta completa, no un intermediario',
    parrafos: [
      'Contamos con departamento propio de corte y diseño: podemos imprimir o desarrollar nuestros propios trazos, o trabajar sobre los que tu marca ya tiene.',
      'La operación integra auditoría de calidad, logística, bodega de accesorios, bordado, bodega de telas y de producto terminado, empaque y un área de carga para contenedores.',
    ],
  },

  cifras: [
    { valor: '250', etiqueta: 'operarios en planta' },
    { valor: '4', etiqueta: 'contenedores cargando a la vez' },
    { valor: '8', etiqueta: 'áreas productivas integradas' },
  ],

  lineas: {
    titulo: 'Dos líneas, una misma planta',
    items: [
      {
        id: 'uniformes',
        nombre: 'Uniformes',
        marca: 'The Chef’s Store',
        descripcion:
          'Uniformes industriales y corporativos para cocinas, industria, salud, oficina y equipos de campo.',
        categorias: [
          'Filipinas ejecutiva, clásica y premium',
          'Gorros de chef y gorras',
          'Camisas tipo Columbia',
          'Camisas industriales con reflectivo',
          'Playeras y pantalones industriales',
          'Pantalones de denim',
          'Polos de tejido plano',
          'Prendas deportivas',
          'Chalecos corporativos',
          'Chaquetas ejecutivas',
          'Sets de médicos',
        ],
      },
      {
        id: 'hogar',
        nombre: 'Textiles de hogar',
        marca: 'Bodega del Edredón',
        descripcion:
          'Ropa de cama y textiles para el hogar, para distribución y para proyectos de hotelería.',
        categorias: [
          'Almohadas',
          'Sets de sábanas de 200 a 600 hilos',
          'Fundas e insertos de duvet',
          'Cubrecamas y edredones',
          'Toallas y accesorios de baño',
          'Línea infantil',
          'Maternidad y bebé',
          'Protectores y accesorios',
        ],
      },
    ],
    galeriaTitulo: 'Algunas de nuestras prendas',
  },

  proceso: {
    titulo: 'De la tela al contenedor',
    pasos: [
      { nombre: 'Diseño y patronaje', detalle: 'Trazos propios o los de tu marca.' },
      { nombre: 'Corte', detalle: 'Departamento propio, sin subcontratar.' },
      { nombre: 'Confección', detalle: 'Producción industrial en línea.' },
      { nombre: 'Bordado y personalización', detalle: 'Tu logo aplicado en planta.' },
      { nombre: 'Auditoría de calidad', detalle: 'Revisión antes de empaque.' },
      { nombre: 'Empaque', detalle: 'Listo para distribución.' },
      { nombre: 'Carga y logística', detalle: 'Hasta cuatro contenedores a la vez.' },
    ],
  },

  personalizacion: {
    titulo: 'Tu marca, aplicada en planta',
    descripcion:
      'Bordado, serigrafía, DTF y sublimación, además de colores, tallas y trazos a la medida de tu equipo.',
    tecnicas: ['Bordado', 'Serigrafía', 'DTF', 'Sublimación'],
  },

  formulario: {
    titulo: 'Solicita tu cotización',
    descripcion: 'Cuéntanos qué necesitas y te respondemos con una propuesta.',
    campos: {
      nombre: 'Nombre',
      empresa: 'Empresa',
      email: 'Correo',
      telefono: 'Teléfono o WhatsApp',
      linea: 'Línea de interés',
      cantidad: 'Cantidad aproximada',
      mensaje: 'Cuéntanos más',
    },
    opcionesLinea: [
      { valor: 'uniformes', texto: 'Uniformes' },
      { valor: 'hogar', texto: 'Textiles de hogar' },
      { valor: 'ambas', texto: 'Ambas' },
    ],
    enviar: 'Enviar solicitud',
    enviando: 'Enviando…',
    exitoTitulo: 'Recibimos tu solicitud',
    exitoDetalle: 'Te contactamos para afinar cantidades y tiempos de entrega.',
    errorGeneral: 'No pudimos enviar tu solicitud. Intenta de nuevo en un momento.',
    errorValidacion: 'Revisa los campos marcados.',
  },

  footer: {
    // Datos pendientes de confirmar con el cliente (spec §10).
    contactoTitulo: 'Contacto',
    telefono: 'Pendiente de confirmar',
    email: 'Pendiente de confirmar',
    direccion: 'Guatemala',
    derechos: 'Luxe Essentials. Todos los derechos reservados.',
  },
} as const;
