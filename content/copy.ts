export const copy = {
  marca: 'Luxe Essentials',

  nav: {
    ariaLabel: 'Principal',
    enlaces: [
      { href: '#capacidad', texto: 'Cómo trabajamos' },
      { href: '#lineas', texto: 'Productos' },
      { href: '#textiles', texto: 'Textiles' },
      { href: '#planta', texto: 'La planta' },
      { href: '#proceso', texto: 'Proceso' },
    ],
    cta: 'Cotizar',
  },

  hero: {
    titulo: 'Uniformes y textiles para tu operación, fabricados a pedido.',
    subtitulo:
      'Representamos a un fabricante con más de 30 años exportando a Centroamérica, México y Estados Unidos. Producimos contra tu orden y entregamos en unos 30 días, cuando importar por cuenta propia toma entre 60 y 90.',
    ctaPrimario: 'Solicitar cotización',
    ctaSecundario: 'Ver qué fabricamos',
    atributos: [
      'Entrega en unos 30 días',
      'Desde 24 piezas',
      'Tu logo en cada prenda',
      'Un solo interlocutor',
    ],
  },

  capacidad: {
    titulo: 'Sin la complejidad de importar por tu cuenta',
    parrafos: [
      'Los fabricantes locales rara vez tienen la capacidad para atender el volumen de una operación con decenas o cientos de personas uniformadas. Y quien importa por su cuenta se enfrenta a ciclos de 60 a 90 días entre producción, consolidación y embarque.',
      'La fábrica que representamos produce buena parte de sus propias telas. Eso importa más de lo que parece: cuando dentro de un año necesites reponer veinte prendas, la tela seguirá existiendo y tu equipo seguirá viéndose igual.',
      'Tú no gestionas fabricantes, producción, personalización, importación ni logística. Nosotros coordinamos todo el proceso y tratas con una sola empresa, aquí, en tu horario.',
    ],
  },

  cifras: [
    { valor: '30 años', etiqueta: 'de experiencia del fabricante que representamos' },
    { valor: '30 días', etiqueta: 'de entrega, frente a 60–90 importando directo' },
    { valor: '70 %', etiqueta: 'de la tela se produce en la propia fábrica' },
  ],

  lineas: {
    titulo: 'Qué fabricamos',
    items: [
      {
        id: 'uniformes',
        nombre: 'Uniformes',
        marca: 'Hotelería · Salud · Industria · Educación · Retail',
        descripcion:
          'Uniformes profesionales para cocina, sala, operación y oficina, en las telas y los cortes que cada puesto exige.',
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
        nombre: 'Textiles institucionales',
        marca: 'Ropa de cama · Baño',
        descripcion:
          'Ropa de cama y textiles para habitación y baño, pensados para la reposición continua que exige una operación de hospedaje, salud o cuidado.',
        categorias: [
          'Sábanas y fundas',
          'Duvets y cubrecamas',
          'Almohadas y protectores',
          'Toallas y textiles de baño',
          'Manteles y textiles de restaurante',
        ],
      },
    ],
    sectores:
      'Hoteles, restaurantes, bares y clubes, hospitales y clínicas, industria, empresas de servicios, retail, instituciones educativas, catering y eventos.',
    galeriaTitulo: 'Algunas de nuestras prendas',
  },

  planta: {
    titulo: 'La planta detrás de cada pedido',
    // Atribución deliberada: la capacidad descrita aquí es del fabricante al
    // que Luxe representa, no de Luxe. El sitio ya arrastró una vez el error
    // contrario y no vuelve a cometerlo.
    intro:
      'Nosotros no fabricamos: representamos a un fabricante con más de 30 años exportando a Centroamérica, México y Estados Unidos. Esto es lo que hay detrás de tu orden de compra.',
    areas: [
      {
        nombre: 'Diseño y patronaje',
        detalle:
          'Departamento propio de trazo. Pueden desarrollar el patrón desde cero o trabajar sobre el que tu marca ya tiene.',
      },
      {
        nombre: 'Corte',
        detalle:
          'Mesas de corte industriales donde la tela se tiende en capas y se corta por trazo, no pieza a pieza.',
      },
      {
        nombre: 'Confección',
        detalle:
          'Doscientos cincuenta operarios en línea, con capacidad instalada para ocho contenedores de prenda.',
      },
      {
        nombre: 'Auditoría, empaque y carga',
        detalle:
          'Revisión antes de empacar, y área de carga propia para consolidar el embarque hacia Costa Rica.',
      },
    ],
    materialesTitulo: 'Las telas con las que se trabaja',
    materialesDetalle:
      'Cerca del setenta por ciento de la tela se produce en la propia planta. Por eso una reposición dentro de un año encuentra la misma tela, y no una parecida.',
    materiales: [
      'Algodón',
      'Poliéster',
      'Gabardina',
      'Popelina',
      'Sarga',
      'Microfibra',
      'Oxford',
      'Denim',
    ],
  },

  textiles: {
    titulo: 'Textiles para habitación y baño',
    // Especificaciones tomadas del catálogo del proveedor. Se conservan
    // conteos de hilo, composiciones y medidas, que es lo que un comprador
    // institucional compara. Se dejan fuera precios, códigos de producto y
    // la marca del proveedor: son de su lista de distribuidor, en otra
    // moneda y otro mercado.
    intro:
      'La ropa de cama de una operación se mide en reposiciones, no en compras. Por eso importan el conteo de hilos, la composición y que la misma referencia siga existiendo el año que viene.',
    familias: [
      {
        nombre: 'Sábanas',
        detalle:
          'Juegos de 200, 300, 400 y 600 hilos en 100 % algodón. Cada juego incluye cobertor, sábana lisa y sobrefundas. También en mezcla 50/50 y microfibra para alta rotación.',
      },
      {
        nombre: 'Almohadas',
        detalle:
          'Funda de algodón de 200 hilos con relleno de fibra Down Alternative, alternativa a la pluma de ganso. Línea hipoalergénica en microfibra para operaciones con huéspedes sensibles.',
      },
      {
        nombre: 'Duvets y cubrecamas',
        detalle:
          'Fundas de duvet de 200 y 300 hilos, insertos ligeros de fibra Down Alternative, y cubrecamas con tecnología Quilting o Pinsonic reversible.',
      },
      {
        nombre: 'Pillow top',
        detalle:
          'Acolchado de 2.5 pulgadas de algodón con relleno hipoalergénico. Recupera el confort de un colchón sin reemplazarlo.',
      },
      {
        nombre: 'Protectores',
        detalle:
          'De almohada y de colchón, en versión permeable e impermeable con cierre. Es lo que alarga la vida de todo lo demás.',
      },
      {
        nombre: 'Toallas y baño',
        detalle:
          'Toalla de baño, de manos y facial en 100 % algodón, batas y alfombras de baño.',
      },
    ],
    medidasTitulo: 'Medidas disponibles',
    medidasDetalle:
      'Todas las líneas de cama se fabrican en las cinco medidas, así que una misma referencia cubre habitaciones distintas sin cambiar de proveedor.',
    medidas: ['King', 'Queen', 'Matrimonial', 'Semi matrimonial', 'Imperial'],
  },

  proceso: {
    titulo: 'De tu necesidad a la entrega',
    pasos: [
      { nombre: 'Entendemos la necesidad', detalle: 'Qué prenda, para qué puesto y en qué volumen.' },
      { nombre: 'Recomendamos y cotizamos', detalle: 'Tela, corte y acabados según el uso real.' },
      { nombre: 'Muestra', detalle: 'Mandas tu arte o lo preparamos: foto de la muestra en 24 horas.' },
      { nombre: 'Orden de producción', detalle: 'Arranca con el 50 % de la orden de compra.' },
      { nombre: 'Fabricación', detalle: 'Producción a pedido en la planta que representamos.' },
      { nombre: 'Importación y logística', detalle: 'Coordinamos el embarque; tú no gestionas nada.' },
      { nombre: 'Entrega', detalle: 'En Costa Rica, en unos 30 días.' },
    ],
  },

  personalizacion: {
    titulo: 'Tu logo en cada prenda',
    descripcion:
      'Bordado, serigrafía, DTF y sublimación, aplicados en planta sobre la misma tela con la que se confecciona la prenda: el acabado no se despega ni destiñe a la tercera lavada industrial. Desde 24 unidades con un costo adicional, y sin costo a partir de 48 cuando ya tienes el arte digital. Te enviamos foto de la muestra 24 horas después de aprobarlo.',
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
    lineaPlaceholder: 'Selecciona una línea',
    opcionesLinea: [
      { valor: 'uniformes', texto: 'Uniformes' },
      { valor: 'hogar', texto: 'Textiles institucionales' },
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
    // La dirección no es una omisión: no tienen bodega porque no manejan
    // inventario, así que sólo se indica el país. `redes` va como texto
    // plano y no como enlace porque los perfiles aún no existen — el día que
    // existan, esto pasa a ser una lista de <a>, no un cambio de copy.
    contactoTitulo: 'Contacto',
    telefono: '+506 6140 2511',
    telefonoHref: 'tel:+50661402511',
    email: 'info@luxeessentialscr.com',
    emailHref: 'mailto:info@luxeessentialscr.com',
    direccion: 'Costa Rica',
    horario: 'Lunes a viernes, 8:00 a 17:00',
    redes: 'Luxe Essentials',
    derechos: 'Luxe Essentials. Todos los derechos reservados.',
  },

  medios: {
    // Único texto visible en la página que antes vivía fuera de este
    // archivo (estaba escrito directamente en components/ui/Figure.tsx).
    pendiente: 'Pendiente de fotografía',
  },
} as const;
