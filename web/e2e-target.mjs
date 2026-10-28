export function resolveE2ETarget(env) {
  if (env.BASE_URL === undefined) {
    return { baseURL: 'http://localhost:4173', startServer: true }
  }

  const target = new URL(env.BASE_URL)
  if (!['http:', 'https:'].includes(target.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
    || target.username || target.password || target.pathname !== '/'
    || target.search || target.hash) {
    throw new Error('CRUD E2E tests require a loopback origin; production and remote targets are forbidden.')
  }
  if (env.E2E_ALLOW_SYNTHETIC_DATA !== '1') {
    throw new Error('An external BASE_URL requires E2E_ALLOW_SYNTHETIC_DATA=1 and a disposable local dataset.')
  }

  return { baseURL: target.origin, startServer: false }
}
