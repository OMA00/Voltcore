import client from 'prom-client'

// ============================================================
// REGISTRY
// ============================================================
const register = new client.Registry()

// Default Node.js metrics (CPU, memory, event loop, etc.)
client.collectDefaultMetrics({ register })

// ============================================================
// BUSINESS METRICS
// ============================================================

// Jobs
export const jobsTotal = new client.Counter({
  name: 'voltcore_jobs_total',
  help: 'Total jobs created',
  labelNames: ['gpuType', 'status', 'provider'],
  registers: [register]
})

export const jobDuration = new client.Histogram({
  name: 'voltcore_job_duration_seconds',
  help: 'Job duration in seconds',
  labelNames: ['gpuType', 'status'],
  buckets: [60, 300, 600, 1800, 3600, 7200, 14400],
  registers: [register]
})

export const activeJobs = new client.Gauge({
  name: 'voltcore_active_jobs',
  help: 'Currently active jobs',
  registers: [register]
})

// Inference
export const inferenceRequests = new client.Counter({
  name: 'voltcore_inference_requests_total',
  help: 'Total inference requests',
  labelNames: ['model', 'source', 'status'],
  registers: [register]
})

export const inferenceTokens = new client.Counter({
  name: 'voltcore_inference_tokens_total',
  help: 'Total tokens processed',
  labelNames: ['model', 'source'],
  registers: [register]
})

export const inferenceLatency = new client.Histogram({
  name: 'voltcore_inference_latency_seconds',
  help: 'Inference latency in seconds',
  labelNames: ['model'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register]
})

// Revenue
export const revenueTotal = new client.Counter({
  name: 'voltcore_revenue_ngn_total',
  help: 'Total revenue in Naira',
  labelNames: ['source'],
  registers: [register]
})

// Users
export const usersTotal = new client.Gauge({
  name: 'voltcore_users_total',
  help: 'Total registered users',
  registers: [register]
})

export const walletBalance = new client.Gauge({
  name: 'voltcore_wallet_balance_ngn',
  help: 'Total wallet balance in Naira',
  registers: [register]
})

// Providers
export const providerHealth = new client.Gauge({
  name: 'voltcore_provider_healthy',
  help: 'Provider health (1 = healthy, 0 = down)',
  labelNames: ['provider'],
  registers: [register]
})

export const providerLatency = new client.Gauge({
  name: 'voltcore_provider_latency_ms',
  help: 'Provider API latency in ms',
  labelNames: ['provider'],
  registers: [register]
})

// API
export const apiRequests = new client.Counter({
  name: 'voltcore_api_requests_total',
  help: 'Total API requests',
  labelNames: ['endpoint', 'method', 'status'],
  registers: [register]
})

export const apiLatency = new client.Histogram({
  name: 'voltcore_api_latency_seconds',
  help: 'API latency in seconds',
  labelNames: ['endpoint'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register]
})

// Errors
export const errorsTotal = new client.Counter({
  name: 'voltcore_errors_total',
  help: 'Total errors',
  labelNames: ['type', 'severity'],
  registers: [register]
})

// ============================================================
// EXPORT
// ============================================================
export async function getMetrics() {
  return await register.metrics()
}

export function getMetricsContentType() {
  return register.contentType
}

export { register }