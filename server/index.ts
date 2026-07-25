import { buildApp } from './app.js'

const port = Number(process.env.PORT ?? 3001)
const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`
const trustProxy = process.env.TRUST_PROXY === 'true'

try {
  const app = await buildApp({ logger: true, publicBaseUrl, trustProxy })
  await app.listen({ host: '127.0.0.1', port })
} catch (error) {
  console.error(error)
  process.exit(1)
}
