const UPLOAD_ALLOWED_MODES = new Set(['active']);

function normalizeMode(mode) {
  return String(mode || 'uninitialized').trim().toLowerCase();
}

function canUploadInMode(mode) {
  return UPLOAD_ALLOWED_MODES.has(normalizeMode(mode));
}

function shouldAdvanceIndexForLocalObservation(mode) {
  return canUploadInMode(mode);
}

module.exports = {
  canUploadInMode,
  normalizeMode,
  shouldAdvanceIndexForLocalObservation,
  UPLOAD_ALLOWED_MODES,
};
