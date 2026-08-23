import { expect, test } from '@playwright/test'

test('home actions remain visible within the viewport', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByRole('heading', { name: /让文字和图片/ })).toBeVisible()
  await expect(page.getByRole('button', { name: '创建传输房间' })).toBeVisible()
  await expect(page.getByLabel('6 位配对码')).toBeVisible()

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  expect(overflow).toBe(false)
})

test('creates a room and shows pairing controls', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '创建传输房间' }).click()

  await expect(page.getByRole('heading', { name: '用另一台设备加入' })).toBeVisible()
  await expect(page.locator('#qr')).toBeVisible()
  await expect(page.locator('.code-copy strong')).toHaveText(/^[A-Z2-9]{6}$/)
  await expect(page.locator('.countdown')).toHaveText(/0[0-5]:[0-5][0-9]/)
})

test('pairs two browser tabs and opens the transfer workspace', async ({ browser }) => {
  const creatorContext = await browser.newContext()
  const joinerContext = await browser.newContext()
  const creator = await creatorContext.newPage()
  const joiner = await joinerContext.newPage()

  await creator.goto('/')
  await creator.getByRole('button', { name: '创建传输房间' }).click()
  const pairingCode = await creator.locator('.code-copy strong').innerText()

  await joiner.goto('/')
  await joiner.getByLabel('6 位配对码').fill(pairingCode)
  await joiner.getByRole('button', { name: '加入' }).click()

  await expect(creator.getByPlaceholder('输入要传送的文字')).toBeVisible()
  await expect(joiner.getByPlaceholder('输入要传送的文字')).toBeVisible()
  await expect(creator.locator('.connection-pill')).toContainText(/正在建立直连|两台设备在线/)
  const creatorSafety = await creator.locator('.verification-panel strong').innerText()
  await expect(joiner.locator('.verification-panel strong')).toHaveText(creatorSafety)
  await creator.getByRole('button', { name: '验证码一致' }).click()
  await joiner.getByRole('button', { name: '验证码一致' }).click()
  await expect(creator.locator('.verification-panel')).toHaveText('端到端加密已验证')
  await expect(joiner.locator('.verification-panel')).toHaveText('端到端加密已验证')
  await expect(creator.getByPlaceholder('输入要传送的文字')).toBeEnabled()
  await expect(creator.locator('.connection-pill')).toHaveText('设备直连')
  await expect(joiner.locator('.connection-pill')).toHaveText('设备直连')

  await creatorContext.close()
  await joinerContext.close()
})

test('authenticates a QR invitation and removes its fragment', async ({ browser }) => {
  const creatorContext = await browser.newContext()
  const joinerContext = await browser.newContext()
  const creator = await creatorContext.newPage()
  const joiner = await joinerContext.newPage()

  await creator.goto('/')
  await creator.getByRole('button', { name: '创建传输房间' }).click()
  const invitation = await creator.evaluate(() => {
    const stored = JSON.parse(sessionStorage.getItem('temporary-transfer-session') ?? '{}')
    return `${stored.joinUrl}#k=${stored.crypto.invitationSecret}`
  })

  const requestedUrls: string[] = []
  joiner.on('request', request => requestedUrls.push(request.url()))
  await joiner.goto(invitation)
  await expect(joiner).toHaveURL(url => url.hash === '')
  await joiner.getByRole('button', { name: '加入' }).click()

  await expect(creator.locator('.verification-panel')).toHaveText('端到端加密已验证')
  await expect(joiner.locator('.verification-panel')).toHaveText('端到端加密已验证')
  expect(requestedUrls.every(url => !url.includes('#k='))).toBe(true)

  await creatorContext.close()
  await joinerContext.close()
})

test('restores verified encryption state after a page refresh', async ({ browser }) => {
  const creatorContext = await browser.newContext()
  const joinerContext = await browser.newContext()
  const creator = await creatorContext.newPage()
  const joiner = await joinerContext.newPage()

  await creator.goto('/')
  await creator.getByRole('button', { name: '创建传输房间' }).click()
  const pairingCode = await creator.locator('.code-copy strong').innerText()
  await joiner.goto('/')
  await joiner.getByLabel('6 位配对码').fill(pairingCode)
  await joiner.getByRole('button', { name: '加入' }).click()
  const safetyNumber = await creator.locator('.verification-panel strong').innerText()
  await expect(joiner.locator('.verification-panel strong')).toHaveText(safetyNumber)
  await creator.getByRole('button', { name: '验证码一致' }).click()
  await joiner.getByRole('button', { name: '验证码一致' }).click()
  await expect(creator.locator('.verification-panel')).toHaveText('端到端加密已验证')

  await creator.reload()
  await expect(creator.locator('.verification-panel')).toHaveText('端到端加密已验证')
  await expect(creator.getByPlaceholder('输入要传送的文字')).toBeEnabled()
  await expect(creator.locator('.connection-pill')).toHaveText('设备直连')
  await expect(joiner.locator('.connection-pill')).toHaveText('设备直连')

  await creatorContext.close()
  await joinerContext.close()
})

test('transfers encrypted text over the direct DataChannel', async ({ browser }) => {
  const creatorContext = await browser.newContext()
  const joinerContext = await browser.newContext()
  const creator = await creatorContext.newPage()
  const joiner = await joinerContext.newPage()

  await creator.goto('/')
  await creator.getByRole('button', { name: '创建传输房间' }).click()
  const pairingCode = await creator.locator('.code-copy strong').innerText()
  await joiner.goto('/')
  await joiner.getByLabel('6 位配对码').fill(pairingCode)
  await joiner.getByRole('button', { name: '加入' }).click()
  const safetyNumber = await creator.locator('.verification-panel strong').innerText()
  await expect(joiner.locator('.verification-panel strong')).toHaveText(safetyNumber)
  await creator.getByRole('button', { name: '验证码一致' }).click()
  await joiner.getByRole('button', { name: '验证码一致' }).click()
  await expect(creator.locator('.connection-pill')).toHaveText('设备直连')

  await creator.getByPlaceholder('输入要传送的文字').fill('来自设备 A 的加密文字')
  await creator.getByTitle('发送').click()
  await expect(joiner.locator('.message-item pre')).toHaveText('来自设备 A 的加密文字')
  await expect(creator.locator('.message-item pre')).toHaveText('来自设备 A 的加密文字')

  await creatorContext.close()
  await joinerContext.close()
})

test('transfers an encrypted image over the direct DataChannel', async ({ browser }) => {
  const creatorContext = await browser.newContext()
  const joinerContext = await browser.newContext()
  const creator = await creatorContext.newPage()
  const joiner = await joinerContext.newPage()

  await creator.goto('/')
  await creator.getByRole('button', { name: '创建传输房间' }).click()
  const pairingCode = await creator.locator('.code-copy strong').innerText()
  await joiner.goto('/')
  await joiner.getByLabel('6 位配对码').fill(pairingCode)
  await joiner.getByRole('button', { name: '加入' }).click()
  const safetyNumber = await creator.locator('.verification-panel strong').innerText()
  await expect(joiner.locator('.verification-panel strong')).toHaveText(safetyNumber)
  await creator.getByRole('button', { name: '验证码一致' }).click()
  await joiner.getByRole('button', { name: '验证码一致' }).click()
  await expect(joiner.locator('.connection-pill')).toHaveText('设备直连')

  await joiner.locator('input[type=file]').setInputFiles({
    name: 'transfer.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  })
  await expect(joiner.locator('.image-preview strong')).toHaveText('transfer.png')
  await joiner.getByTitle('发送').click()
  await expect(creator.locator('.image-message strong')).toHaveText('transfer.png')
  await expect(joiner.locator('.image-message strong')).toHaveText('transfer.png')
  await expect(creator.locator('.image-message img')).toBeVisible()
  await expect.poll(() => creator.locator('.image-message img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1)

  await creatorContext.close()
  await joinerContext.close()
})

test('falls back to encrypted WebSocket text and restores it after refresh', async ({ browser }) => {
  const creatorContext = await browser.newContext()
  const joinerContext = await browser.newContext()
  await creatorContext.addInitScript(() => { Object.defineProperty(globalThis, 'RTCPeerConnection', { value: undefined }) })
  await joinerContext.addInitScript(() => { Object.defineProperty(globalThis, 'RTCPeerConnection', { value: undefined }) })
  const creator = await creatorContext.newPage()
  const joiner = await joinerContext.newPage()

  await creator.goto('/')
  await creator.getByRole('button', { name: '创建传输房间' }).click()
  const pairingCode = await creator.locator('.code-copy strong').innerText()
  await joiner.goto('/')
  await joiner.getByLabel('6 位配对码').fill(pairingCode)
  await joiner.getByRole('button', { name: '加入' }).click()
  const safetyNumber = await creator.locator('.verification-panel strong').innerText()
  await expect(joiner.locator('.verification-panel strong')).toHaveText(safetyNumber)
  await creator.getByRole('button', { name: '验证码一致' }).click()
  await joiner.getByRole('button', { name: '验证码一致' }).click()
  await expect(creator.locator('.connection-pill')).toHaveText('加密中转')

  await creator.getByPlaceholder('输入要传送的文字').fill('回退通道密文')
  await creator.getByTitle('发送').click()
  await expect(joiner.locator('.message-item pre')).toHaveText('回退通道密文')
  await joiner.reload()
  await expect(joiner.locator('.message-item pre')).toHaveText('回退通道密文')
  await expect(joiner.locator('.message-item pre')).toHaveCount(1)

  await creatorContext.close()
  await joinerContext.close()
})

test('transfers encrypted text and an image between two devices after task 6', async ({ browser }) => {
  const creatorContext = await browser.newContext()
  const joinerContext = await browser.newContext()
  const creator = await creatorContext.newPage()
  const joiner = await joinerContext.newPage()

  await creator.goto('/')
  await creator.getByRole('button', { name: '创建传输房间' }).click()
  const pairingCode = await creator.locator('.code-copy strong').innerText()

  await joiner.goto('/')
  await joiner.getByLabel('6 位配对码').fill(pairingCode)
  await joiner.getByRole('button', { name: '加入' }).click()
  const safetyNumber = await creator.locator('.verification-panel strong').innerText()
  await expect(joiner.locator('.verification-panel strong')).toHaveText(safetyNumber)
  await creator.getByRole('button', { name: '验证码一致' }).click()
  await joiner.getByRole('button', { name: '验证码一致' }).click()
  await expect(creator.locator('.verification-panel')).toHaveText('端到端加密已验证')
  await expect(creator.getByPlaceholder('输入要传送的文字')).toBeEnabled()
  await expect(joiner.locator('.connection-pill')).toHaveText('设备直连')

  await creator.getByPlaceholder('输入要传送的文字').fill('来自设备 A 的文字')
  await creator.getByTitle('发送').click()
  await expect(joiner.locator('.message-item pre')).toHaveText('来自设备 A 的文字')

  await joiner.locator('input[type=file]').setInputFiles({
    name: 'transfer.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  })
  await expect(joiner.locator('.image-preview strong')).toHaveText('transfer.png')
  await joiner.getByTitle('发送').click()
  await expect(creator.locator('.image-message strong')).toHaveText('transfer.png')
  await expect(creator.locator('.image-message img')).toBeVisible()

  await creatorContext.close()
  await joinerContext.close()
})

