const { randomUUID } = require("crypto");

function messageKey(identity) {
  return `${identity.item_type}:${identity.item_id}:${identity.topic_id}:${identity.id}`;
}

function operationId(deviceId, action, identity, checksum) {
  const safe = [deviceId, action, identity.item_type, identity.item_id, identity.topic_id, identity.id, checksum]
    .map((part) => String(part || '').replace(/[^a-zA-Z0-9_.-]/g, '_'));
  // An edit returning to an earlier value is a new operation. Retries must use
  // the ID already stored with the operation, never construct it again here.
  return [...safe, randomUUID()].join(':');
}

module.exports = { messageKey, operationId };
