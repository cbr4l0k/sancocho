import type { MessageSchema } from './schema';

const esCO = {
  auth: {
    connecting: 'Conectando con Sancocho…',
    signedOut: 'No has iniciado sesión. La conexión con Sancocho estará lista cuando tú lo estés.',
    profilePending: 'La conexión con Convex está lista. Tu perfil de usuario de Sancocho todavía no está configurado.',
    connected: 'Conexión con Convex establecida.',
  },
  organizations: { title: 'Organizaciones', members: '{count, plural, =0 {Sin miembros} one {# miembro} other {# miembros}}' },
  projects: { title: 'Proyectos', statuses: { draft: 'Borrador', active: 'Activo', completed: 'Completado', archived: 'Archivado' } },
  fields: {
    title: 'Campos',
    dataTypes: { text: 'Texto', longText: 'Texto largo', number: 'Número', boolean: 'Sí/no', date: 'Fecha', datetime: 'Fecha y hora', time: 'Hora', select: 'Selección', multiSelect: 'Selección múltiple', location: 'Ubicación' },
    statuses: { active: 'Activo', archived: 'Archivado' },
    semanticTypes: {
      eventName: { label: 'Nombre del servicio', description: 'Identifica el servicio operativo.' },
      eventDescription: { label: 'Descripción del servicio', description: 'Aporta detalles operativos del servicio.' },
      eventDate: { label: 'Fecha del servicio', description: 'Registra la fecha calendario del servicio.' },
      eventTime: { label: 'Hora del servicio', description: 'Registra la hora local programada.' },
      eventLocation: { label: 'Ubicación del servicio', description: 'Vincula el servicio con una ubicación.' },
      'passenger.count': { label: 'Cantidad de pasajeros', description: 'Permite calcular totales y ocupación.' },
      'transport.origin': { label: 'Origen', description: 'Indica el punto de partida del traslado.' },
      'transport.destination': { label: 'Destino', description: 'Indica el punto de llegada del traslado.' },
      'aviation.flightNumber': { label: 'Número de vuelo', description: 'Permite dar seguimiento a un vuelo.' },
      'luggage.count': { label: 'Cantidad de equipaje', description: 'Registra el total de equipaje.' },
      'accessibility.wheelchairCount': { label: 'Cantidad de sillas de ruedas', description: 'Identifica necesidades de accesibilidad.' },
      'contact.primary': { label: 'Contacto principal', description: 'Registra el contacto operativo principal.' },
      'aviation.terminal': { label: 'Terminal', description: 'Registra la terminal aeroportuaria.' },
      'general.notes': { label: 'Notas', description: 'Registra observaciones operativas.' },
    },
  },
  recipes: { title: 'Recetas', statuses: { draft: 'Borrador', active: 'Activa', archived: 'Archivada' }, versionStatuses: { draft: 'Borrador', published: 'Publicada', retired: 'Retirada' } },
  services: { title: 'Servicios', statuses: { draft: 'Borrador', planned: 'Planeado', confirmed: 'Confirmado', active: 'En curso', completed: 'Completado', cancelled: 'Cancelado' } },
  locations: { title: 'Ubicaciones', types: { airport: 'Aeropuerto', hotel: 'Hotel', venue: 'Sede', office: 'Oficina', station: 'Estación', depot: 'Patio operativo', custom: 'Personalizada' } },
  relationships: { title: 'Relaciones', types: { dependsOn: 'Depende de', follows: 'Sigue a', parentOf: 'Es principal de', relatedTo: 'Está relacionado con' } },
  stats: { itemsSelected: '{count, plural, =0 {No hay elementos seleccionados} one {# elemento seleccionado} other {# elementos seleccionados}}', welcome: 'Hola, {name}. Todo está listo para empezar.' },
  chat: { title: 'Chat operativo' },
  common: { language: 'Idioma', spanish: 'Español', english: 'Inglés', save: 'Guardar', cancel: 'Cancelar' },
  errors: { generic: 'Ocurrió un error. Inténtalo de nuevo.', notFound: 'No se encontró el recurso o no tienes acceso.' },
  nav: { home: 'Inicio', projects: 'Proyectos', services: 'Servicios', recipes: 'Recetas', locations: 'Ubicaciones' },
  vocab: {
    roles: { owner: 'Propietario', admin: 'Administrador', planner: 'Planificador', operator: 'Operador', viewer: 'Consulta' },
    auditActions: {
      'organization.created': 'Organización creada', 'organization.updated': 'Organización actualizada', 'membership.created': 'Membresía creada', 'membership.updated': 'Membresía actualizada', 'membership.removed': 'Membresía eliminada',
      'project.created': 'Proyecto creado', 'project.updated': 'Proyecto actualizado', 'project.archived': 'Proyecto archivado', 'fieldDefinition.created': 'Definición de campo creada', 'fieldDefinition.updated': 'Definición de campo actualizada', 'fieldDefinition.archived': 'Definición de campo archivada', 'fieldDefinition.deleted': 'Definición de campo eliminada',
      'recipe.created': 'Receta creada', 'recipe.updated': 'Receta actualizada', 'recipe.archived': 'Receta archivada', 'recipeVersion.created': 'Versión de receta creada', 'recipeVersion.published': 'Versión de receta publicada', 'recipeVersion.retired': 'Versión de receta retirada', 'recipeField.added': 'Campo agregado a la receta', 'recipeField.updated': 'Campo de receta actualizado', 'recipeField.removed': 'Campo eliminado de la receta', 'recipeVersion.fieldsReordered': 'Campos de receta reordenados',
      'event.created': 'Servicio creado', 'event.updated': 'Servicio actualizado', 'event.fieldsUpdated': 'Campos del servicio actualizados', 'event.statusChanged': 'Estado del servicio actualizado', 'event.cancelled': 'Servicio cancelado',
      'location.created': 'Ubicación creada', 'location.updated': 'Ubicación actualizada', 'location.archived': 'Ubicación archivada', 'location.deleted': 'Ubicación eliminada', 'relationship.created': 'Relación creada', 'relationship.removed': 'Relación eliminada',
    },
  },
} as const satisfies MessageSchema;

export default esCO;
