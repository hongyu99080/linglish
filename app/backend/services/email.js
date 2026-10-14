function readSmtpConfig() {
  const host = String(process.env.SMTP_HOST || '').trim();
  const from = String(process.env.EMAIL_FROM || process.env.SMTP_FROM || '').trim();
  if (!host || !from) return null;

  const port = Number(process.env.SMTP_PORT || 587);
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || '').trim();
  const secure = process.env.SMTP_SECURE === 'true' || port === 465;

  return {
    from,
    transport: {
      host,
      port: Number.isFinite(port) ? port : 587,
      secure,
      auth: user || pass ? { user, pass } : undefined,
    },
  };
}

function isEmailDeliveryConfigured() {
  return Boolean(readSmtpConfig());
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendPasswordResetEmail({ to, resetUrl, expiresInMinutes }) {
  const config = readSmtpConfig();
  if (!config) {
    throw new Error('EMAIL_DELIVERY_NOT_CONFIGURED');
  }

  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport(config.transport);
  const safeMinutes = Math.max(1, Math.round(Number(expiresInMinutes) || 30));
  const subject = 'Reset your Linglish password';
  const text = [
    'We received a request to reset your Linglish password.',
    '',
    `Open this link within ${safeMinutes} minutes:`,
    resetUrl,
    '',
    'If you did not request this, you can ignore this email.',
  ].join('\n');
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#172033;">
      <h1 style="font-size:22px;margin:0 0 12px;">Reset your Linglish password</h1>
      <p>We received a request to reset your Linglish password.</p>
      <p>
        <a href="${escapeHtml(resetUrl)}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:700;">
          Reset password
        </a>
      </p>
      <p>This link expires in ${safeMinutes} minutes.</p>
      <p style="color:#667085;">If you did not request this, you can ignore this email.</p>
    </div>
  `;

  await transporter.sendMail({
    from: config.from,
    to,
    subject,
    text,
    html,
  });

  return { ok: true };
}

async function sendEmailVerificationEmail({ to, verificationUrl, expiresInHours }) {
  const config = readSmtpConfig();
  if (!config) {
    throw new Error('EMAIL_DELIVERY_NOT_CONFIGURED');
  }

  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport(config.transport);
  const safeHours = Math.max(1, Math.round(Number(expiresInHours) || 48));
  const subject = 'Verify your Linglish email';
  const text = [
    'Welcome to Linglish.',
    '',
    `Verify your email within ${safeHours} hours:`,
    verificationUrl,
    '',
    'If you did not create a Linglish account, you can ignore this email.',
  ].join('\n');
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#172033;">
      <h1 style="font-size:22px;margin:0 0 12px;">Verify your Linglish email</h1>
      <p>Welcome to Linglish. Please confirm this email address so we can secure your account and billing communication.</p>
      <p>
        <a href="${escapeHtml(verificationUrl)}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:700;">
          Verify email
        </a>
      </p>
      <p>This link expires in ${safeHours} hours.</p>
      <p style="color:#667085;">If you did not create a Linglish account, you can ignore this email.</p>
    </div>
  `;

  await transporter.sendMail({
    from: config.from,
    to,
    subject,
    text,
    html,
  });

  return { ok: true };
}

module.exports = {
  isEmailDeliveryConfigured,
  sendPasswordResetEmail,
  sendEmailVerificationEmail,
};
