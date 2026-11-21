import fs from 'node:fs/promises';
import path from 'node:path';
import nodemailer from 'nodemailer';

/**
 * SMTP_HOST doluysa gerçek SMTP ile gönderir.
 * Boşsa e-postayı var/outbox/ klasörüne .eml dosyası olarak yazar (lokal test).
 */
export function createMailer(cfg, log) {
  const e = cfg.email;
  const useSmtp = Boolean(e.smtpHost);
  const transport = useSmtp
    ? nodemailer.createTransport({
        host: e.smtpHost,
        port: e.smtpPort,
        secure: e.smtpSecure,
        auth: e.smtpUser ? { user: e.smtpUser, pass: e.smtpPassword } : undefined,
      })
    : nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });

  return {
    mode: useSmtp ? 'smtp' : 'outbox',
    async send({ to, subject, text, html }) {
      const info = await transport.sendMail({
        from: e.from,
        replyTo: e.replyTo || undefined,
        to,
        subject,
        text,
        html,
      });
      if (useSmtp) {
        log.info(`E-posta gönderildi → ${to} (${info.messageId})`);
        return { id: info.messageId };
      }
      await fs.mkdir(e.outboxDir, { recursive: true });
      const file = path.join(e.outboxDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${to.replace(/[^a-z0-9@.]/gi, '_')}.eml`);
      await fs.writeFile(file, info.message);
      log.info(`E-posta (SMTP kapalı) dosyaya yazıldı: ${file}`);
      return { id: file, file };
    },
    async verify() {
      if (useSmtp) await transport.verify();
      return true;
    },
  };
}
