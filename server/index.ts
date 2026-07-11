import { buildApp } from './app.js'

const port = Number(process.env.PORT ?? 3001)
const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`

try {
  const app = await buildApp({ logger: true, publicBaseUrl })
  await app.listen({ host: '127.0.0.1', port })
} catch (error) {
  console.error(error)
  process.exit(1)
}
