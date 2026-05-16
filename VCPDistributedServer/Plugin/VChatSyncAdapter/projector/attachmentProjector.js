async function applyAttachmentEvents(events, context) {
  const logger = context.logger;
  for (const event of events) {
    const payload = event.payload || {};
    if (payload.hash && context.localIndex) {
      await context.localIndex.setFile(`remote_attachment:${payload.hash}`, {
        kind: "attachment_remote",
        hash: payload.hash,
        ext: payload.ext || "",
        size: payload.size_bytes || 0,
        mime_type: payload.mime_type || null,
        last_applied_seq: event.seq,
        updated_at: new Date().toISOString(),
      });
    }
  }
  if (events.length > 0 && logger && logger.debug) {
    logger.debug("attachment projector recorded attachment metadata events", { count: events.length });
  }
  return { applied: events.length };
}

module.exports = { applyAttachmentEvents };
