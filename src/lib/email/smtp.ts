// ============================================================
// Outbound email via Gmail SMTP — server-side only.
//
// Configured by environment:
//   EMAIL_USER — Gmail address the mail is sent from
//   EMAIL_PASS — Google app password for that account
//
// Unconfigured deployments simply don't send: isEmailConfigured()
// lets callers skip quietly instead of erroring.
// ============================================================

import nodemailer, { type Transporter } from 'nodemailer'

let _transporter: Transporter | null = null

export function isEmailConfigured(): boolean {
  return Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASS)
}

function transporter(): Transporter {
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    })
  }
  return _transporter
}

export async function sendEmail(params: {
  to: string[]
  subject: string
  text: string
  html?: string
}): Promise<void> {
  if (params.to.length === 0) return
  await transporter().sendMail({
    from: `FOCAS CRM <${process.env.EMAIL_USER}>`,
    to: params.to,
    subject: params.subject,
    text: params.text,
    html: params.html,
  })
}
