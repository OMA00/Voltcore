import { apiRequests, apiLatency } from '../services/metrics.js'

/**
 * Track API request metrics
 */
export function metricsMiddleware(req, res, next) {
  const start = Date.now()

  // Skip metrics endpoint itself
  if (req.path === '/metrics') return next()

  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000
    const endpoint = req.route?.path || req.path
    const status = res.statusCode

    apiRequests.inc({ endpoint, method: req.method, status })
    apiLatency.observe({ endpoint }, duration)
  })

  next()
}