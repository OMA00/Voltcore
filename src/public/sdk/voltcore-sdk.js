/**
 * VoltCore JavaScript SDK (beta)
 * Usage:
 *   import VoltCore from '@voltcore/sdk'
 *   const client = new VoltCore({ apiKey: 'vck_...' })
 */
class VoltCore {
  constructor({ apiKey, baseUrl = 'https://voltcore.africa' }) {
    if (!apiKey) throw new Error('Missing API key')
    this.apiKey = apiKey
    this.baseUrl = baseUrl
  }

  async _request(path, options = {}) {
    const res = await fetch(`${this.baseUrl}/api/v1${path}`, {
      ...options,
      headers: {
        'x-api-key': this.apiKey,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    })

    const data = await res.json()

    if (!res.ok) {
      const err = new Error(data.error || 'Request failed')
      err.status = res.status
      err.data = data
      throw err
    }

    return data
  }

  async health() {
    return await this._request('/health')
  }

  async models() {
    return await this._request('/models')
  }

  async chat({ model = 'micro-gpt', prompt, messages, maxTokens = 500, temperature = 0.7 }) {
    return await this._request('/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model,
        prompt,
        messages,
        max_tokens: maxTokens,
        temperature
      })
    })
  }

  async usage(days = 30) {
    return await this._request(`/usage?days=${days}`)
  }
}

export default VoltCore