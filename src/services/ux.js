/**
 * Shared UX layer for Telegram and WhatsApp
 * Both platforms call the same functions – different renderers
 */

// ============================================================
// LANGUAGE SUPPORT
// ============================================================
const LANGUAGES = {
  en: 'English',
  pcm: 'Pidgin',
  yo: 'Yorùbá',
  ha: 'Hausa',
  ig: 'Igbo'
}

const STRINGS = {
  en: {
    welcome: 'Welcome to VoltCore',
    gpuMenu: 'Choose your GPU',
    selected: 'Selected',
    hoursPrompt: 'How many hours do you need?',
    insufficient: 'Insufficient balance',
    topup: 'Top up your wallet',
    jobs: 'Your recent jobs',
    balance: 'Your balance',
    refer: 'Refer a friend',
    help: 'Available commands',
    cancelled: 'Cancelled',
    processing: 'Processing...'
  },
  pcm: {
    welcome: 'Welcome to VoltCore',
    gpuMenu: 'Pick your GPU',
    selected: 'You don select',
    hoursPrompt: 'How many hours you wan use?',
    insufficient: 'Your money no reach',
    topup: 'Add money to your wallet',
    jobs: 'Your recent jobs',
    balance: 'Your money',
    refer: 'Tell your friend',
    help: 'Commands wey dey',
    cancelled: 'You cancel am',
    processing: 'We dey work on am...'
  },
  yo: {
    welcome: 'Ẹ káàbọ̀ sí VoltCore',
    gpuMenu: 'Yan GPU rẹ',
    selected: 'Ti yan',
    hoursPrompt: 'Melo ni wákàtí tí o nílò?',
    insufficient: 'Owó rẹ kò tó',
    topup: 'Fi owó kún wálẹ́ẹ̀tì rẹ',
    jobs: 'Àwọn iṣẹ́ rẹ',
    balance: 'Owó rẹ',
    refer: 'Sọ fún ọ̀rẹ́ rẹ',
    help: 'Àwọn àṣẹ tí ó wà',
    cancelled: 'Ti fagilé',
    processing: 'À ń ṣiṣẹ́ lórí rẹ̀...'
  },
  ha: {
    welcome: 'Barka da zuwa VoltCore',
    gpuMenu: 'Zaɓi GPU ɗinka',
    selected: 'An zaɓa',
    hoursPrompt: 'Awa nawa kuke buƙata?',
    insufficient: 'Kuɗin ku bai isa ba',
    topup: 'Ƙara kuɗi a walat ɗinka',
    jobs: 'Ayyukanku na kwanan nan',
    balance: 'Kuɗin ku',
    refer: 'Faɗa wa abokinka',
    help: 'Umarnin da suke akwai',
    cancelled: 'An soke',
    processing: 'Ana aiki akai...'
  },
  ig: {
    welcome: 'Nnọọ na VoltCore',
    gpuMenu: 'Họrọ GPU gị',
    selected: 'Ahọpụtara',
    hoursPrompt: 'Awa ole ka ị chọrọ?',
    insufficient: 'Ego gị ezughị',
    topup: 'Tinye ego na wallet gị',
    jobs: 'Ọrụ gị ndị na-adịbeghị anya',
    balance: 'Ego gị',
    refer: 'Gwa enyi gị',
    help: 'Iwu ndị dị',
    cancelled: 'Akagburu',
    processing: 'Anyị na-arụ ọrụ na ya...'
  }
}

/**
 * Get localized string
 */
export function t(lang, key) {
  const dict = STRINGS[lang] || STRINGS.en
  return dict[key] || STRINGS.en[key] || key
}

/**
 * Detect user language from message
 */
export function detectLanguage(text) {
  const lower = text.toLowerCase()

  // Yoruba patterns
  if (/\b(báwo|ẹ káàbọ̀|jọ̀wọ́|ṣé|kí ni)\b/.test(lower)) return 'yo'
  // Hausa patterns
  if (/\b(yaya|sannu|nawa|ina|barka)\b/.test(lower)) return 'ha'
  // Igbo patterns
  if (/\b(kedu|biko|nnoo|gịnị|ole)\b/.test(lower)) return 'ig'
  // Pidgin patterns
  if (/\b(wetin|abeg|how far|dey|waka|chop)\b/.test(lower)) return 'pcm'

  return 'en'
}

// ============================================================
// MESSAGE BUILDERS
// ============================================================

/**
 * GPU menu with interactive buttons
 * Returns platform-agnostic payload
 */
export function buildGpuMenu(lang = 'en', prices) {
  const title = t(lang, 'gpuMenu')

  return {
    type: 'menu',
    title,
    body: `${title}:`,
    options: [
      { id: '1', label: `RTX 3090 24GB – ₦${prices['3090']}/hr`, gpu: '3090' },
      { id: '2', label: `RTX 4090 24GB – ₦${prices['4090']}/hr`, gpu: '4090' },
      { id: '3', label: `A100 80GB – ₦${prices['a100']}/hr`, gpu: 'a100' }
    ]
  }
}

/**
 * Job card – rich formatting for jobs
 */
export function buildJobCard(job) {
  const emoji = {
    completed: '✅',
    running: '🚀',
    failed: '❌',
    pending: '📋',
    provisioning: '⏳',
    cancelled: '⛔',
    refunded: '💸'
  }[job.status] || '📋'

  return {
    type: 'card',
    title: `${emoji} Job ${job.id.slice(0, 8)}`,
    body: `GPU: ${job.gpuType.toUpperCase()}\n` +
          `Hours: ${job.requestedHours}\n` +
          `Cost: ₦${job.totalCostNGN.toLocaleString()}\n` +
          `Status: ${job.status}`,
    sshDetails: job.sshDetails
  }
}

/**
 * Wallet summary
 */
export function buildWalletCard(user, wallet) {
  return {
    type: 'card',
    title: `💼 ${user.firstName || 'Your'} Wallet`,
    body: `💰 Balance: ₦${(wallet?.balance || 0).toLocaleString()}`,
    actions: [
      { label: '💳 Top Up', action: 'topup' },
      { label: '📊 View Jobs', action: 'jobs' }
    ]
  }
}

/**
 * Referral card
 */
export function buildReferralCard(code, stats, referrerBonus) {
  return {
    type: 'card',
    title: '🎁 Referral Programme',
    body: `Your code: ${code}\n\n` +
          `Share with friends. When they spend ₦1,000, you earn ₦${referrerBonus.toLocaleString()}.\n\n` +
          `👥 Referrals: ${stats.totalReferrals}\n` +
          `✅ Completed: ${stats.completed}\n` +
          `⏳ Pending: ${stats.pending}\n` +
          `💰 Total earned: ₦${stats.totalEarnedNGN.toLocaleString()}`
  }
}

// ============================================================
// PLATFORM ADAPTERS
// ============================================================

/**
 * Telegram renderer – converts UX payload to Telegram reply
 */
export function renderForTelegram(payload) {
  if (payload.type === 'menu') {
    // Telegram inline keyboard
    return {
      text: payload.body,
      reply_markup: {
        inline_keyboard: payload.options.map(opt => [
          { text: opt.label, callback_data: `gpu:${opt.id}` }
        ])
      }
    }
  }

  if (payload.type === 'card') {
    let text = `*${payload.title}*\n\n${payload.body}`
    if (payload.sshDetails) {
      text += `\n\n\`\`\`\n${payload.sshDetails}\n\`\`\``
    }
    return { text, parse_mode: 'Markdown' }
  }

  return { text: payload.body || '' }
}

/**
 * WhatsApp renderer – converts UX payload to WhatsApp message
 */
export function renderForWhatsApp(payload) {
  if (payload.type === 'menu') {
    // WhatsApp list message
    return {
      type: 'list',
      title: payload.title,
      body: payload.body,
      buttonText: 'Select GPU',
      sections: [{
        title: 'Available GPUs',
        rows: payload.options.map(opt => ({
          id: opt.id,
          title: opt.label,
          description: `${opt.gpu.toUpperCase()} GPU`
        }))
      }]
    }
  }

  if (payload.type === 'card') {
    let text = `*${payload.title}*\n\n${payload.body}`
    if (payload.sshDetails) {
      text += `\n\n\`\`\`\n${payload.sshDetails}\n\`\`\``
    }
    return { type: 'text', text }
  }

  return { type: 'text', text: payload.body || '' }
}