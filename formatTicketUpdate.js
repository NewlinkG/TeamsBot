function formatTicketUpdate({ ticket, article, updated_by }) {
  const actor = `${updated_by.firstname} ${updated_by.lastname}`;
  const subject = article.subject || '(sin asunto)';
  const body = article.body || '(sin contenido)';
  const attachments = (article.attachments || [])
    .map(att => `- [${att.filename}](${att.content_url})`)
    .join('\n') || 'Ninguno';

  return (
    `📬 El ticket *#${ticket.number} - ${ticket.title}* fue actualizado por *${actor}*\n\n` +
    `📝 **${subject}**\n\n${body}\n\n` +
    `📎 **Adjuntos:**\n${attachments}`
  );
}

module.exports = { formatTicketUpdate };