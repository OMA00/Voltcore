import axios from 'axios'

const VAST_API_KEY = process.env.VAST_API_KEY
const VAST_API_URL = 'https://console.vast.ai/api/v0'

/**
 * Provision an instance on Vast.ai
 */
export async function provisionVastai(gpuType, hours) {
  console.log(`🚀 Vast.ai: Provisioning ${gpuType} for ${hours} hours`)

  try {
    const searchResponse = await axios.get(
      `${VAST_API_URL}/bundles/`,
      {
        params: {
          gpu_name: gpuType === '3090' ? 'RTX 3090' :
                    gpuType === '4090' ? 'RTX 4090' : 'A100',
          type: 'on-demand',
          order: 'dph_total',
          limit: 1
        },
        headers: { 'Authorization': `Bearer ${VAST_API_KEY}` }
      }
    )

    if (!searchResponse.data.offers || searchResponse.data.offers.length === 0) {
      throw new Error('No available GPUs found on Vast.ai')
    }

    const offer = searchResponse.data.offers[0]

    const createResponse = await axios.put(
      `${VAST_API_URL}/asks/${offer.id}/`,
      {
        client_id: 'me',
        image: 'pytorch/pytorch:2.1.0-cuda11.8-cudnn8-devel',
        disk: 50,
        label: `voltcore-${Date.now()}`,
        runtype: 'ssh'
      },
      {
        headers: {
          'Authorization': `Bearer ${VAST_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    )

    const instance = createResponse.data

    return {
      id: String(instance.new_contract),
      sshDetails: `ssh root@${instance.public_ipaddr} -p ${instance.ssh_port}\nPassword: ${instance.root_password || 'vast-' + Date.now()}`,
      endpoint: `http://${instance.public_ipaddr}:${instance.ssh_port}`,
      status: 'provisioning'
    }
  } catch (error) {
    console.error('Vast.ai API error:', error.response?.data || error.message)
    throw new Error(`Vast.ai provisioning failed: ${error.message}`)
  }
}

/**
 * Get instance status
 */
export async function getVastaiStatus(providerJobId) {
  try {
    const response = await axios.get(
      `${VAST_API_URL}/instances/${providerJobId}`,
      {
        headers: { 'Authorization': `Bearer ${VAST_API_KEY}` }
      }
    )
    return response.data.actual_status
  } catch (error) {
    console.error('Vast.ai status error:', error.message)
    return 'unknown'
  }
}

/**
 * Terminate an instance
 */
export async function terminateVastai(providerJobId) {  // <-- ADDED 'export'
  try {
    await axios.delete(
      `${VAST_API_URL}/instances/${providerJobId}/`,
      {
        headers: { 'Authorization': `Bearer ${VAST_API_KEY}` }
      }
    )
    return true
  } catch (error) {
    console.error('Vast.ai termination error:', error.message)
    return false
  }
}