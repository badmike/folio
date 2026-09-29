import { chromium } from '@playwright/test'
for (const args of [[], ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'], ['--enable-unsafe-swiftshader']]) {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args })
  const page = await browser.newPage({ viewport: { width: 300, height: 200 } })
  await page.setContent('<body style="margin:0"><canvas id=c width=300 height=200></canvas><script>const gl=document.getElementById("c").getContext("webgl2");gl.clearColor(1,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT)</script>')
  await page.waitForTimeout(300)
  const buf = await page.screenshot()
  // check center pixel via canvas decode
  const px = await page.evaluate(async (b64) => { const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode(); const c = document.createElement('canvas'); c.width = 300; c.height = 200; const x = c.getContext('2d'); x.drawImage(img, 0, 0); return Array.from(x.getImageData(150, 100, 1, 1).data) }, buf.toString('base64'))
  console.log(JSON.stringify(args), px, await page.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl2'); const d = gl.getExtension('WEBGL_debug_renderer_info'); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'n/a' }))
  await browser.close()
}
