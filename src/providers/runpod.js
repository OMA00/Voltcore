import axios from 'axios'

const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY
const RUNPOD_API_URL = process.env.RUNPOD_API_URL || 'https://rest.runpod.io/v1'

// ============================================================
// AXIOS CLIENT WITH RETRIES + TIMEOUT
// ============================================================
const client = axios.create({
  baseURL: RUNPOD_API_URL,
  timeout: 30000,
  headers: {
    'Authorization': `Bearer ${RUNPOD_API_KEY}`,
    'Content-Type': 'application/json'
  }
})

// Retry on 5xx / network errors (up to 3 attempts)
client.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config = error.config || {}
    config.__retryCount = config.__retryCount || 0

    const shouldRetry =
      config.__retryCount < 3 &&
      (!error.response || error.response.status >= 500 || error.response.status === 429)

    if (shouldRetry) {
      config.__retryCount += 1
      const delay = Math.min(1000 * Math.pow(2, config.__retryCount), 8000)
      console.log(`🔁 RunPod retry ${config.__retryCount}/3 in ${delay}ms (${error.message})`)
      await new Promise((r) => setTimeout(r, delay))
      return client(config)
    }

    return Promise.reject(error)
  }
)

// ============================================================
// ERROR TAXONOMY
// ============================================================
const RUNPOD_ERROR_MAP = {
  400: { type: 'HARD', code: 'INVALID_REQUEST', label: 'Invalid request to RunPod' },
  401: { type: 'HARD', code: 'AUTH_FAILED', label: 'RunPod authentication failed' },
  402: { type: 'HARD', code: 'PAYMENT_REQUIRED', label: 'RunPod account needs payment' },
  403: { type: 'HARD', code: 'FORBIDDEN', label: 'RunPod access forbidden' },
  404: { type: 'HARD', code: 'NOT_FOUND', label: 'Resource not found on RunPod' },
  409: { type: 'SOFT', code: 'CONFLICT', label: 'Resource conflict – retry' },
  422: { type: 'HARD', code: 'VALIDATION_ERROR', label: 'Invalid configuration' },
  429: { type: 'SOFT', code: 'RATE_LIMIT', label: 'RunPod rate limited' },
  500: { type: 'SOFT', code: 'SERVER_ERROR', label: 'RunPod internal error' },
  502: { type: 'SOFT', code: 'BAD_GATEWAY', label: 'RunPod gateway error' },
  503: { type: 'SOFT', code: 'UNAVAILABLE', label: 'RunPod temporarily unavailable' },
  504: { type: 'SOFT', code: 'TIMEOUT', label: 'RunPod gateway timeout' }
}

function classifyRunPodError(error) {
  const status = error.response?.status
  if (status && RUNPOD_ERROR_MAP[status]) {
    const mapped = RUNPOD_ERROR_MAP[status]
    return {
      ...mapped,
      originalError: error.message,
      rawResponse: error.response?.data
    }
  }
  return {
    type: 'SOFT',
    code: 'UNKNOWN',
    label: `RunPod error: ${error.message}`,
    originalError: error.message
  }
}

// ============================================================
// GPU TYPE MAPPING
// ============================================================
const GPU_MAP = {
  '3090': 'NVIDIA GeForce RTX 3090',
  '4090': 'NVIDIA GeForce RTX 4090',
  'a100': 'NVIDIA A100-SXM4-80GB',
  'h100': 'NVIDIA H100 80GB HBM3'
}

// ============================================================
// PROVISION POD
// ============================================================
export async function provisionRunPod(gpuType, hours, options = {}) {
  const {
    gpuCount = 1,
    containerImage = 'runpod/pytorch:2.1.0-py3.10-cuda11.8.0-devel-ubuntu22.04',
    containerDiskGb = 20,
    volumeGb = 0,
    volumeMountPath = '/workspace'
  } = options

  console.log(`🚀 RunPod: provisioning ${gpuCount}× ${gpuType} for ${hours}h`)

  const gpuTypeId = GPU_MAP[gpuType]
  if (!gpuTypeId) {
    throw new Error(`Unknown GPU type: ${gpuType}`)
  }

  try {
    // options.podName is voltcore-<jobId>, so the sweep can find this pod even if the
    // process dies before the pod id is saved.
    const podName = options.podName || `voltcore-${gpuType}-${Date.now()}`
    const password = `vc_${Math.random().toString(36).slice(2, 10)}`

    const response = await client.post('/pods', {
      name: podName,
      imageName: containerImage,
      gpuTypeIds: [gpuTypeId],
      gpuCount,
      containerDiskInGb: containerDiskGb,
      volumeInGb: volumeGb,
      volumeMountPath: volumeGb > 0 ? volumeMountPath : undefined,
      ports: '22/tcp,8888/http',
      env: [
        { key: 'JUPYTER_PASSWORD', value: password },
        { key: 'VOLTCORE_JOB', value: podName }
      ],
      cloudType: 'SECURE'
    })

    const pod = response.data
    console.log(`✅ RunPod pod created: ${pod.id} (${podName})`)

    return {
      id: pod.id,
      providerJobId: pod.id,
      provider: 'runpod',
      sshDetails: null, // Populated after polling
      endpoint: pod.id ? `https://${pod.id}-8888.proxy.runpod.net` : null,
      status: 'provisioning',
      jupyterPassword: password,
      costPerHourUSD: pod.costPerHr || null,
      raw: pod
    }
  } catch (err) {
    const classified = classifyRunPodError(err)
    console.error(`❌ RunPod provision failed: [${classified.code}] ${classified.label}`)
    const enriched = new Error(classified.label)
    enriched.code = classified.code
    enriched.type = classified.type
    enriched.raw = classified
    throw enriched
  }
}

// ============================================================
// GET POD STATUS
// ============================================================
export async function getRunPodStatus(providerJobId) {
  try {
    const response = await client.get(`/pods/${providerJobId}`)
    const pod = response.data

    // Build SSH details when running
    let sshDetails = null
    if (pod.desiredStatus === 'RUNNING' && pod.portMappings) {
      const sshPort = pod.portMappings['22']
      const sshHost = pod.publicIp || pod.id
      if (sshPort && sshHost) {
        sshDetails = `ssh root@${sshHost} -p ${sshPort}\nJupyter: https://${pod.id}-8888.proxy.runpod.net`
      }
    }

    return {
      status: pod.desiredStatus,
      runtimeStatus: pod.runtime?.status || null,
      sshDetails,
      publicIp: pod.publicIp,
      costPerHourUSD: pod.costPerHr,
      raw: pod
    }
  } catch (err) {
    const classified = classifyRunPodError(err)
    if (err.response?.status === 404) {
      return { status: 'EXITED', runtimeStatus: 'NOT_FOUND', sshDetails: null }
    }
    console.error(`❌ RunPod status failed: ${classified.label}`)
    return { status: 'unknown', error: classified.label }
  }
}

// ============================================================
// TERMINATE POD
// ============================================================
export async function terminateRunPod(providerJobId) {
  try {
    await client.delete(`/pods/${providerJobId}`)
    console.log(`🛑 RunPod pod terminated: ${providerJobId}`)
    return { success: true }
  } catch (err) {
    if (err.response?.status === 404) {
      console.log(`⏭️ RunPod pod ${providerJobId} already gone`)
      return { success: true, alreadyGone: true }
    }
    const classified = classifyRunPodError(err)
    console.error(`❌ RunPod terminate failed: ${classified.label}`)
    return { success: false, error: classified.label }
  }
}

// ============================================================
// LIST AVAILABLE GPUs
// ============================================================
export async function listRunPodGpus(gpuType) {
  try {
    const response = await client.get('/gpus')
    const gpus = response.data

    const targetName = GPU_MAP[gpuType]
    return gpus.filter(g => g.displayName === targetName || g.id === targetName)
  } catch (err) {
    console.error('RunPod GPU list failed:', err.message)
    return []
  }
}

/**
 * List this account's pods as { id, name }. Throws on API failure, so callers never
 * mistake a failed listing for "no pods".
 */
export async function listRunPodPods() {
  const response = await client.get('/pods')
  const pods = Array.isArray(response.data) ? response.data : (response.data?.pods || [])
  return pods.map(p => ({ id: p.id, name: p.name }))
}

export { classifyRunPodError, GPU_MAP }