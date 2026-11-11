import axios from 'axios'

const WHISPER_ENDPOINT = process.env.WHISPER_ENDPOINT || 'http://localhost:8000'

/**
 * Transcribe audio buffer using Whisper
 */
export async function transcribeAudio(buffer, mimetype = 'audio/ogg') {
  try {
    const form = new FormData()
    const blob = new Blob([buffer], { type: mimetype })
    form.append('file', blob, 'audio.ogg')
    form.append('model', 'whisper-1')
    form.append('language', 'en')

    const response = await axios.post(`${WHISPER_ENDPOINT}/v1/audio/transcriptions`, form, {
      headers: { ...form.getHeaders?.() },
      timeout: 60000
    })

    const text = response.data?.text || ''
    console.log(`🎤 Transcribed: "${text.slice(0, 80)}..."`)
    return text
  } catch (err) {
    console.error('Transcription error:', err.response?.data || err.message)
    return null
  }
}

/**
 * Fallback: OpenAI Whisper API (if you have an OpenAI key)
 */
export async function transcribeWithOpenAI(buffer, mimetype = 'audio/ogg') {
  if (!process.env.OPENAI_API_KEY) {
    console.warn('No OPENAI_API_KEY – skipping transcription')
    return null
  }

  try {
    const form = new FormData()
    const blob = new Blob([buffer], { type: mimetype })
    form.append('file', blob, 'audio.ogg')
    form.append('model', 'whisper-1')

    const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      timeout: 60000
    })

    return response.data?.text || null
  } catch (err) {
    console.error('OpenAI Whisper error:', err.response?.data || err.message)
    return null
  }
}