import nodemailer from 'nodemailer';
import env from '../config/env.js';
import logger from './logger.js';

const transport = env.smtpUrl ? nodemailer.createTransport(env.smtpUrl) : null;

export async function sendMail({ to, subject, text }) {
  if (!transport) {
    // Dev without SMTP: print it so OTPs and invites can still be tested.
    if (!env.isProd && !env.isTest) logger.info({ to, subject, text }, 'mail (SMTP not configured)');
    return;
  }
  await transport.sendMail({ from: env.mailFrom, to, subject, text });
}
