import { prisma } from '../db/prisma.js'

let invoiceCounter = 0

/**
 * Generate a unique invoice number
 */
function generateInvoiceNumber() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  invoiceCounter++
  return `VC-${date}-${String(invoiceCounter).padStart(4, '0')}`
}

/**
 * Create an invoice for a job
 */
export async function createInvoice(userId, jobId, amountNGN, description) {
  const invoiceNumber = generateInvoiceNumber()

  const invoice = await prisma.invoice.create({
    data: {
      number: invoiceNumber,
      userId,
      jobId,
      amountNGN,
      description,
      status: 'issued'
    }
  })

  console.log(`📄 Invoice created: ${invoiceNumber} for ₦${amountNGN}`)

  return invoice
}

/**
 * Generate invoice HTML (for email / download)
 */
export async function generateInvoiceHTML(invoiceId) {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { user: true }
  })

  if (!invoice) throw new Error('Invoice not found')

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; padding: 40px; color: #333; }
        .header { border-bottom: 2px solid #00FF87; padding-bottom: 20px; margin-bottom: 30px; }
        .logo { font-size: 28px; font-weight: bold; }
        .logo span { color: #00FF87; }
        .invoice-number { color: #888; font-size: 14px; }
        .amount { font-size: 36px; font-weight: bold; margin: 20px 0; }
        .details { margin: 30px 0; }
        .details-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #eee; }
        .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #eee; color: #888; font-size: 12px; }
      </style>
    </head>
    <body>
      <div class="header">
        <div class="logo">Volt<span>Core</span></div>
        <div class="invoice-number">Invoice ${invoice.number}</div>
      </div>

      <div class="amount">₦${invoice.amountNGN.toLocaleString()}</div>

      <div class="details">
        <div class="details-row">
          <span>Customer:</span>
          <span>${invoice.user.firstName || 'Customer'}</span>
        </div>
        <div class="details-row">
          <span>Description:</span>
          <span>${invoice.description}</span>
        </div>
        <div class="details-row">
          <span>Status:</span>
          <span>${invoice.status.toUpperCase()}</span>
        </div>
        <div class="details-row">
          <span>Issued:</span>
          <span>${invoice.issuedAt.toISOString().slice(0, 10)}</span>
        </div>
      </div>

      <div class="footer">
        VoltCore – GPU Compute for Africa<br>
        Lagos, Nigeria
      </div>
    </body>
    </html>
  `

  return html
}

/**
 * Mark invoice as paid
 */
export async function markInvoicePaid(invoiceId) {
  await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      status: 'paid',
      paidAt: new Date()
    }
  })
}