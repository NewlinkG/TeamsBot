// Localized strings
const i18n = {
  en: {
    greeting:      'Hi!',
    confirmPrompt: 'Please confirm the ticket details:',
    confirm:       'Confirm',
    cancel:        'Cancel',
    ticketLabel:   'Ticket',
    statusLabel:   'Status',
    createdLabel:  '🕓 Created',
    updatedLabel:  '🕑 Last Update',
    createdSuffix: 'created successfully.',
    cancelled:     '👍 Ticket creation cancelled',
    parseError:    'Sorry, I couldn’t parse that. Can you rephrase?',
    ticketClosed:  '✅ Ticket #{number} has been closed.',
    commentAdded:  '✅ Your comment has been added to ticket',
    noAttachments: '⚠️ No attachments found in your message.',
    writeComment:  '✏️ Write a comment.',
    noTickets:     '🔍 You have no tickets.',
    viewInBrowser: '🔗 View in browser',
    edit:          '✏️ Edit',
    close:         '✅ Close',
    prev:          '⬅️ Previous',
    next:          'Next ➡️',
    hideClosed:    '🙈 Hide Closed',
    showClosed:    '👁 Show Closed',
    editPrompt:    '✏️ What would you like to add to ticket #{number}?',
    commentFinal:  '📝 Comment added to ticket #{number}{files}.',
    filesClause:   ' with file(s)',
    assignedTo:    '🧑 Assigned to: {owner}',
    notAssigned:   '—',
    listTitle:     '📋 My Tickets',
    unassigned:    'Unassigned',
    attachedFile:  '🔗 Attached file'
  },
  pt: {
    greeting:      'Olá!',
    confirmPrompt: 'Por favor confirme os detalhes do chamado:',
    confirm:       'Confirmar',
    cancel:        'Cancelar',
    ticketLabel:   'Chamado',
    statusLabel:   'Estado',
    createdLabel:  '🕓 Creado',
    updatedLabel:  '🕑 Última atualização',
    createdSuffix: 'criado com sucesso.',
    cancelled:     '👍 Criação de chamado cancelada',
    parseError:    'Desculpe, não consegui entender. Pode reformular?',
    ticketClosed:  '✅ Chamado #{number} foi encerrado.',
    commentAdded:  '✅ Seu comentário foi adicionado ao chamado',
    noAttachments: '⚠️ Nenhum anexo encontrado na sua mensagem.',
    writeComment:  '✏️ Escreva um comentário.',
    noTickets:     '🔍 Você não tem chamados.',
    viewInBrowser: '🔗 Ver no navegador',
    edit:          '✏️ Editar',
    close:         '✅ Fechar',
    prev:          '⬅️ Anterior',
    next:          'Próxima ➡️',
    hideClosed:    '🙈 Ocultar Fechados',
    showClosed:    '👁 Mostrar Fechados',
    editPrompt:    '✏️ O que você gostaria de adicionar ao chamado #{number}?',
    commentFinal:  '📝 Comentário adicionado ao chamado #{number}{files}.',
    filesClause:   ' com arquivo(s)',
    assignedTo:    '🧑 Atribuído a: {owner}',
    notAssigned:   '—',
    listTitle:     '📋 Meus chamados',
    unassigned:    'Não atribuído',
    attachedFile:  '🔗 Arquivo compartilhado'
  },
  es: {
    greeting:      'Hola!',
    confirmPrompt: 'Confirma los detalles del ticket:',
    confirm:       'Confirmar',
    cancel:        'Cancelar',
    ticketLabel:   'Ticket',
    statusLabel:   'Estado',
    createdLabel:  '🕓 Creado',
    updatedLabel:  '🕑 Ultima atualización',
    createdSuffix: 'creado correctamente.',
    cancelled:     '👍 Creación de ticket cancelada',
    parseError:    'Lo siento, no entendí. ¿Puedes aclarar?',
    ticketClosed:  '✅ Ticket #{number} ha sido cerrado.',
    commentAdded:  '✅ Tu comentario fue agregado al ticket',
    noAttachments: '⚠️ No se encontraron archivos adjuntos en tu mensaje.',
    writeComment:  '✏️ Escribe un comentario.',
    noTickets:     '🔍 No tienes tickets.',
    viewInBrowser: '🔗 Ver en navegador',
    edit:          '✏️ Editar',
    close:         '✅ Cerrar',
    prev:          '⬅️ Anterior',
    next:          'Siguiente ➡️',
    hideClosed:    '🙈 Ocultar cerrados',
    showClosed:    '👁 Mostrar cerrados',
    editPrompt:    '✏️ ¿Qué te gustaría agregar al ticket #{number}?',
    commentFinal:  '📝 Comentario agregado al ticket #{number}{files}.',
    filesClause:   ' con archivo(s)',
    assignedTo:    '🧑 Asignado a: {owner}',
    notAssigned:   '—',
    listTitle:     '📋 Mis Tickets',
    unassigned:    'No asignado',
    attachedFile:  '🔗 Archivo compartido'
  }
};


const firstPromptTemplates = {
  en: `You are OrbIT, gathering info for a support ticket: "{summary}". 
You always respond in the same language the user uses.
Suggest self-help if possible but proceed to create the ticket when asked.
Speak in first person in the summary.
Only ask about the issue (no name/email prompts).`,
  es: `Eres OrbIT, recopila info para un ticket de soporte: "{summary}". 
Respondes siempre en el mismo idioma en que te habla el usuario.
Ofreces sugerencias de autoayuda pero generas el ticket si te lo piden.
Generas el resumen hablando en primera persona.
Pregunta solo detalles del problema (no pidas nombre/correo).`,
  pt: `Você é o OrbIT, reunindo informações para um chamado de suporte: "{summary}".
Sempre responda no mesmo idioma usado pelo usuário.
Sugira soluções se possível, mas crie o chamado se solicitado.
Fale na primeira pessoa no resumo.
Pergunte apenas sobre o problema (sem nome/email).`
};


const newChatGreetings = {
  en:   `👋 Hi there! I’m **OrbIT**, your helpdesk assistant.\n\n

🔔 I’ll keep you updated on:\n\n

• Ticket assignments  
• Status changes  
• Internal notes\n\n

No need to check email — I’ve got you covered here in Teams.`,

  pt:   `👋 Olá! Sou o **OrbIT**, seu assistente de helpdesk.\n\n

🔔 Vou te manter informado sobre:\n\n

• Atribuições de chamados  
• Mudanças de status  
• Notas internas\n\n

Não precisa checar o e-mail — aqui no Teams eu cuido disso para você.`,
  
  es:   `👋 ¡Hola! Soy **OrbIT**, tu asistente de mesa de ayuda.\n\n

🔔 Te mantendré al tanto de:\n\n

• Asignaciones de tickets  
• Cambios de estado  
• Notas internas\n\n

No necesitas revisar el correo — aquí en Teams te tengo cubierto.`
}

function getSystemPrompt(userName, userEmail) {
  return {
    role: 'system',
    content:
      `Eres OrbIT, asistente de IA que recopila información para un ticket de soporte. ` +
      `Respondes siempre en el mismo idioma en el que habla el usuario en cada mensaje. ` +
      `Ofreces sugerencias de autoayuda pero generas el ticket de forma directa si lo pide el usuario.` +
      `Generas el summary hablando en primera persona.` +
      `Usuario: ${userName}, correo: ${userEmail}. ` +
      `Solo recopila detalles del problema y equipo. ` +
      `Responde en JSON e incluye el código ISO de tu idioma actual en un campo "lang": ` +
      `{"done":false,"question":"…","lang":"<iso>"} ` +
      `o {"done":true,"title":"…","summary":"…","lang":"<iso>"}.`
  };
}

module.exports = {
  i18n,
  firstPromptTemplates,
  newChatGreetings,
  getSystemPrompt
};