// Minimal fake Telegram Bot API for tests: records sendMessage calls.
import http from 'node:http'

export async function startFakeTelegram() {
  const sent = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      const method = req.url.split('/').pop()
      let body = {}
      try { body = JSON.parse(raw || '{}') } catch {}
      if (method === 'sendMessage') sent.push({ chatId: String(body.chat_id), text: String(body.text) })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, result: method === 'sendMessage'
        ? { message_id: sent.length, date: 0, chat: { id: body.chat_id, type: 'private' }, text: body.text }
        : true }))
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return { sent, apiRoot: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }
}
