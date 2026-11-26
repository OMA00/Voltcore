import axios from 'axios'

const VAST_API_KEY = process.env.VAST_API_KEY
// Overridable so tests can point at a local fake; production uses the default.
const VAST_API_URL = process.env.VAST_API_URL || 'https://console.vast.ai/api/v0'
const auth = () => ({ 'Authorization': `Bearer ${VAST_API_KEY}` })
// Calls used to have no timeout, so a stuck request could hang the worker forever.
const TIMEOUT_MS = Number(process.env.VAST_TIMEOUT_MS) || 30000
// No request in this file is ever retried automatically. Keep it that way for the create
// call (PUT /asks): a retry after a slow reply could rent a second instance.

const GPU_NAMES = { '3090': 'RTX 3090', '4090': 'RTX 4090', 'a100': 'A100 SXM4' }

/**
 * Provision an instance on Vast.ai
 *
 * Vast.ai's create call (PUT /asks/<offer>/) returns only { success, new_contract }:
 * no IP, port or password yet. Those appear on the instance once it starts, so
 * sshDetails is null here (it used to print "ssh root@undefined -p undefined" and a
 * made-up password to the user).
 */
export async function provisionVastai(gpuType, hours, options = {}) {
  console.log(`🚀 Vast.ai: Provisioning ${gpuType} for ${hours} hours`)

  const gpuName = GPU_NAMES[gpuType]
  if (!gpuName) throw new Error(`Unknown GPU type: ${gpuType}`)

  let createSent = false
  try {
    // Search filters go in the `q` JSON parameter. Plain query params like gpu_name=
    // are ignored by the API, so any GPU could have been rented.
    const searchResponse = await axios.get(`${VAST_API_URL}/bundles/`, {
      params: {
        q: JSON.stringify({
          gpu_name: { eq: gpuName },
          rentable: { eq: true },
          type: 'on-demand',
          order: [['dph_total', 'asc']],
          limit: 1
        })
      },
      headers: auth(),
      timeout: TIMEOUT_MS
    })

    const offer = searchResponse.data?.offers?.[0]
    if (!offer) throw new Error('No available GPUs found on Vast.ai')

    createSent = true
    const createResponse = await axios.put(
      `${VAST_API_URL}/asks/${offer.id}/`,
      {
        client_id: 'me',
        image: 'pytorch/pytorch:2.1.0-cuda11.8-cudnn8-devel',
        disk: 50,
        // options.label is voltcore-<jobId>, so the sweep can find this instance by name.
        label: options.label || `voltcore-${Date.now()}`,
        runtype: 'ssh'
      },
      { headers: { ...auth(), 'Content-Type': 'application/json' }, timeout: TIMEOUT_MS }
    )

    const contractId = createResponse.data?.new_contract
    if (!createResponse.data?.success) {
      throw new Error('Vast.ai did not confirm the rental') // a clear "no": nothing was rented
    }
    if (!contractId) {
      // Said success but gave no id: an instance may exist that we cannot address.
      const err = new Error('Vast.ai confirmed the rental but returned no contract id')
      err.ambiguous = true
      throw err
    }

    return {
      id: String(contractId),
      sshDetails: null, // available once the instance is running
      endpoint: null,
      status: 'provisioning',
      costPerHourUSD: offer.dph_total ?? null
    }
  } catch (error) {
    // Outcome unknown when the create request was sent and got no reply (timeout, dropped
    // connection) or a 5xx: an instance may exist. The caller must look it up by label.
    // Only HTTP errors from axios can be ambiguous; our own errors (e.g. a clear
    // success:false) carry no response and must not be mistaken for "no reply".
    const ambiguous = Boolean(error.ambiguous) ||
      (createSent && Boolean(error.isAxiosError) && (!error.response || error.response.status >= 500))
    console.error(`Vast.ai provisioning failed: ${error.message}${ambiguous ? ' (outcome unknown: instance may exist)' : ''}`)
    const wrapped = new Error(`Vast.ai provisioning failed: ${error.message}`)
    wrapped.ambiguous = ambiguous
    if (error.response?.status) wrapped.response = { status: error.response.status }
    throw wrapped
  }
}

/**
 * Get instance status (actual_status: 'running', 'loading', 'exited', ...).
 * GET /instances/<id>/ wraps the instance: { instances: { actual_status, ... } }.
 * This used to read response.data.actual_status, which is always undefined, so a
 * Vast.ai instance was never seen as running and was never stopped at the end of a job.
 */
export async function getVastaiStatus(providerJobId) {
  try {
    const response = await axios.get(`${VAST_API_URL}/instances/${providerJobId}/`, { headers: auth(), timeout: TIMEOUT_MS })
    const wrapped = response.data?.instances ?? response.data
    const instance = Array.isArray(wrapped) ? wrapped[0] : wrapped
    if (!instance) return 'exited' // the instance no longer exists
    return instance.actual_status || 'unknown'
  } catch (error) {
    if (error.response?.status === 404) return 'exited'
    console.error('Vast.ai status error:', error.message)
    return 'unknown'
  }
}

/**
 * List this account's instances as { id, name } (name = label). Throws on API failure.
 */
export async function listVastaiInstances() {
  const response = await axios.get(`${VAST_API_URL}/instances/`, { headers: auth(), timeout: TIMEOUT_MS })
  return (response.data?.instances || []).map(i => ({ id: i.id, name: i.label }))
}

/**
 * Terminate an instance. True when it is gone (deleted now, or already absent).
 */
export async function terminateVastai(providerJobId) {
  try {
    await axios.delete(`${VAST_API_URL}/instances/${providerJobId}/`, { headers: auth(), timeout: TIMEOUT_MS })
    return true
  } catch (error) {
    if (error.response?.status === 404) return true
    console.error('Vast.ai termination error:', error.message)
    return false
  }
}
