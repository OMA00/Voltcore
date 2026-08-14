import axios from 'axios'

const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY
const RUNPOD_API_URL = 'https://api.runpod.io/v2'

/**
 * Provision a pod on RunPod
 */
export async function provisionRunPod(gpuType, hours) {
  console.log(`🚀 RunPod: Provisioning ${gpuType} for ${hours} hours`)

  try {
    // Map GPU type to RunPod's GPU ID
    const gpuMap = {
      '3090': 'NVIDIA GeForce RTX 3090',
      '4090': 'NVIDIA GeForce RTX 4090',
      'a100': 'NVIDIA A100-SXM4-80GB'
    }

    const response = await axios.post(
      `${RUNPOD_API_URL}/pods`,
      {
        name: `voltcore-${Date.now()}`,
        gpuTypeId: gpuMap[gpuType],
        containerDiskSize: 50,
        minVcpu: 4,
        minMemory: 16,
        dockerImage: 'pytorch/pytorch:2.0.0-cuda11.7-cudnn8-runtime',
        env: [
          { key: 'JUPYTER_TOKEN', value: `voltcore-${Date.now()}` }
        ]
      },
      {
        headers: {
          'Authorization': `Bearer ${RUNPOD_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    )

    return {
      id: response.data.id,
      sshDetails: `ssh user@${response.data.id}.runpod.io -p 22000\nPassword: ${response.data.env?.JUPYTER_TOKEN || 'runpod-' + Date.now()}`
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
    return response.data.status
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