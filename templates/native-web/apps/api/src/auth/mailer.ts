import nodemailer, { type Transporter } from 'nodemailer';

export interface VerificationMailer {
  sendVerification(input: {
    email: string;
    productName: string;
    code: string;
    expiresAt: Date;
  }): Promise<void>;
  close?(): void;
}

export class MailDeliveryError extends Error {
  readonly code = 'MAIL_DELIVERY_FAILED';

  constructor() {
    super('Verification email delivery failed');
    this.name = 'MailDeliveryError';
  }
}

export function createSmtpVerificationMailer(config: {
  host: string;
  port: number;
  secure: boolean;
  from: string;
  auth?: { user: string; pass: string };
}): VerificationMailer {
  const transporter: Transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.auth,
    logger: false,
    debug: false,
  });

  return {
    async sendVerification({ email, productName, code, expiresAt }) {
      try {
        await transporter.sendMail({
          from: config.from,
          to: email,
          subject: productName + ' 邮箱验证码',
          text: '你的验证码是 ' + code + '。验证码将在 ' +
            expiresAt.toISOString() + ' 前失效。',
          html: '<p>你的验证码是 <strong>' + code + '</strong>。</p>' +
            '<p>验证码将在十分钟后失效。</p>',
        });
      } catch {
        throw new MailDeliveryError();
      }
    },
    close() {
      transporter.close();
    },
  };
}
