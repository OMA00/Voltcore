import express from 'express'

const router = express.Router()

// ============================================================
// OpenAPI spec
// ============================================================
const openApiSpec = {
  openapi: '3.0.0',
  info: {
    title: 'VoltCore API',
    version: 'v1',
    description: 'GPU compute, custom models, and Micro-GPT inference for African developers.',
    contact: { name: 'VoltCore', url: 'https://voltcore.africa' }
  },
  servers: [
    { url: '/api/v1', description: 'Production' }
  ],
  security: [{ ApiKeyAuth: [] }],
  components: {
    securitySchemes: {
      ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'x-api-key' }
    }
  },
  paths: {
    '/health': {
      get: {
        summary: 'API health check',
        security: [],
        responses: { '200': { description: 'OK' } }
      }
    },
    '/models': {
      get: {
        summary: 'List available models',
        responses: {
          '200': {
            description: 'Model list',
            content: {
              'application/json': {
                example: {
                  models: [
                    { id: 'micro-gpt', name: 'Micro-GPT (SME)', context: 4096, pricePer1kTokens: 2 }
                  ]
                }
              }
            }
          }
        }
      }
    },
    '/chat/completions': {
      post: {
        summary: 'Run inference',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              example: {
                model: 'micro-gpt',
                prompt: 'Write a product description for a Lagos restaurant.',
                max_tokens: 500
              }
            }
          }
        },
        responses: {
          '200': { description: 'Inference result' },
          '401': { description: 'Missing/invalid API key' },
          '402': { description: 'Insufficient balance' }
        }
      }
    },
    '/usage': {
      get: {
        summary: 'Get API usage stats',
        parameters: [{ name: 'days', in: 'query', schema: { type: 'integer', default: 30 } }],
        responses: { '200': { description: 'Usage stats' } }
      }
    }
  }
}

// ============================================================
// GET /api/docs – Swagger UI
// ============================================================
router.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>VoltCore API Docs</title>
      <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
    </head>
    <body>
      <div id="swagger-ui"></div>
      <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
      <script>
        SwaggerUIBundle({
          spec: ${JSON.stringify(openApiSpec)},
          dom_id: '#swagger-ui',
          presets: [SwaggerUIBundle.presets.apis],
          layout: 'BaseLayout'
        })
      </script>
    </body>
    </html>
  `)
})

// ============================================================
// GET /api/docs/openapi.json – Raw spec
// ============================================================
router.get('/openapi.json', (req, res) => {
  res.json(openApiSpec)
})

export default router