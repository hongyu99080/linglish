function getPublicSiteUrl() {
  const value = String(process.env.SITE_URL || 'http://localhost:4000').trim();
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    throw new Error('SITE_URL must be an absolute HTTP or HTTPS URL.');
  }
  if (!/^(?:[a-z0-9._-]+|\[[0-9a-f:.]+\])$/i.test(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('SITE_URL must use HTTP or HTTPS with an origin only: no credentials, path prefix, query, or fragment.');
  }
  return url.href.replace(/\/+$/, '');
}

module.exports = { getPublicSiteUrl };
