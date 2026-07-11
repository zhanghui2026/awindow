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
  await expect(creator.locator('.connection-pill')).toContainText('两台设备在线')

  await creatorContext.close()
  await joinerContext.close()
})
