function formatTicketUpdate({ ticket, article, updated_by, lang = 'es' }) {
  const actor = `${updated_by.firstname} ${updated_by.lastname}`;
  const subject = article.subject || '(no subject)';
  const body = article.body || '(no content)';
  const attachments = (article.attachments || [])
    .map(att => `- [${att.filename}](${att.content_url})`)
    .join('\n') || 'None';

  const templates = {
    es: {
      updated: `📬 El ticket *#${ticket.number} - ${ticket.title}* fue actualizado por *${actor}*`,
      attachments: `📎 **Adjuntos:**`
    },
    en: {
      updated: `📬 Ticket *#${ticket.number} - ${ticket.title}* was updated by *${actor}*`,
      attachments: `📎 **Attachments:**`
    },
    pt: {
      updated: `📬 O chamado *#${ticket.number} - ${ticket.title}* foi atualizado por *${actor}*`,
      attachments: `📎 **Anexos:**`
    }
  };

  const t = templates[lang] || templates.es;

  return (
    `${t.updated}\n\n` +
    `📝 **${subject}**\n\n${body}\n\n` +
    `${t.attachments}\n${attachments}`
  );
}

module.exports = { formatTicketUpdate };
