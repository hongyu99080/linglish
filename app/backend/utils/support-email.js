function getSupportEmail() {
  const value = String(process.env.SUPPORT_EMAIL || 'hello@example.com').trim();
  const valid = /^[A-Za-z0-9][A-Za-z0-9._+-]*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(value);
  const local = value.split('@')[0];
  if (!valid || value.length > 254 || local.length > 64 || local.endsWith('.') || local.includes('..')) {
    throw new Error('SUPPORT_EMAIL must be a plain email address without markup or extra headers.');
  }
  return value;
}

module.exports = { getSupportEmail };
