/**
 * Provider interface – all providers must implement these methods
 */
export class GPUProvider {
  async provision(gpuType, hours) {
    throw new Error('Not implemented')
  }

  async getStatus(providerJobId) {
    throw new Error('Not implemented')
  }

  async terminate(providerJobId) {
    throw new Error('Not implemented')
  }

  get name() {
    throw new Error('Not implemented')
  }
}