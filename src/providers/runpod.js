import axios from 'axios'

const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY
const RUNPOD_API_URL = 'https://rest.runpod.io/v1'

/**
 * Provision a GPU pod on RunPod
 */
export async function provisionRunPod(gpuType, hours) {
  console.log(`🚀 RunPod: Provisioning ${gpuType} for ${hours} hours`)

  try {
    // Map our GPU types to RunPod GPU IDs
    const gpuMap = {
      '3090': 'NVIDIA GeForce RTX 3090',
      '4090': 'NVIDIA GeForce RTX 4090',
      'a100': 'NVIDIA A100-SXM4-80GB'
    }

    // Create pod
    const response = await axios.post(
      `${RUNPOD_API_URL}/pods`,
      {
        name: `voltcore-${Date.now()}`,
        imageName: 'runpod/pytorch:2.1.0-py3.10-cuda11.8.0-devel-ubuntu22.04',
        gpuTypeIds: [gpuMap[gpuType]],
        gpuCount: 1,
        containerDiskInGb: 50,
        volumeInGb: 0,
        ports: '8888/http,22/tcp',
        env: [
          { key: 'JUPYTER_PASSWORD', value: `voltcore-${Date.now()}` }
        ]
      },
      {
        headers: {
          'Authorization': `Bearer ${RUNPOD_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    )

    const pod = response.data

    return {
      id: pod.id,
      sshDetails: `ssh root@${pod.id}.runpod.io -p 22\nPassword: ${pod.env?.JUPYTER_PASSWORD || 'voltcore-' + Date.now()}`,
      endpoint: `https://${pod.id}-8888.proxy.runpod.net`,
      status: 'provisioning'
    }
  } catch (error) {
    console.error('RunPod API error:', error.response?.data || error.message)
    throw new Error(`RunPod provisioning failed: ${error.message}`)
  }
}

/**
 * Get pod status
 */
export async function getRunPodStatus(providerJobId) {
  try {
    const response = await axios.get(
      `${RUNPOD_API_URL}/pods/${providerJobId}`,
      {
        headers: { 'Authorization': `Bearer ${RUNPOD_API_KEY}` }
      }
    )
    return response.data.desiredStatus
  } catch (error) {
    console.error('RunPod status error:', error.message)
    return 'unknown'
  }
}

/**
 * Terminate a pod
 */
export async function terminateRunPod(providerJobId) {
  try {
    await axios.delete(
      `${RUNPOD_API_URL}/pods/${providerJobId}`,
      {
        headers: { 'Authorization': `Bearer ${RUNPOD_API_KEY}` }
      }
    )
    return true
  } catch (error) {
    console.error('RunPod termination error:', error.message)
    return false
  }
}