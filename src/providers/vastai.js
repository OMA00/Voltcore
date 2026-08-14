import axios from 'axios'

const VAST_API_KEY = process.env.VAST_API_KEY
const VAST_API_URL = 'https://vast.ai/api/v0'

/**
 * Provision an instance on Vast.ai
 */
export async function provisionVastai(gpuType, hours) {
  console.log(`🚀 Vast.ai: Provisioning ${gpuType} for ${hours} hours`)

  try {
    // Search for offers
    const searchResponse = await axios.get(
      `${VAST_API_URL}/bundles/`,
      {
        params: {
          gpu_type: gpuType,
          type: 'on-demand',
          order: 'price_asc',
          limit: 1
        },
        headers: {
          'Authorization': `Bearer ${VAST_API_KEY}`
        }
      }
    )

    if (!searchResponse.data.bundles || searchResponse.data.bundles.length === 0) {
      throw new Error('No available GPUs found on Vast.ai')
    }

    const offer = searchResponse.data.bundles[0]

    // Create instance
    const createResponse = await axios.put(
      `${VAST_API_URL}/asks/${offer.ask_id}/`,
      {
        client_id: offer.client_id,
        image: 'pytorch/pytorch:2.0.0-cuda11.7-cudnn8-runtime',
        disk: 50,
        label: `voltcore-${Date.now()}`
      },
      {
        headers: {
          'Authorization': `Bearer ${VAST_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    )

    return {
      id: createResponse.data.instance_id,
      sshDetails: `ssh user@${createResponse.data.ip} -p ${createResponse.data.port}\nPassword: ${createResponse.data.password || 'vast-' + Date.now()}`
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
    return response.data.status
  } catch (error) {
    console.error('Vast.ai status error:', error.message)
    return 'unknown'
  }
}

/**
 * Terminate an instance
 */
export async function terminateVastai(providerJobId) {
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