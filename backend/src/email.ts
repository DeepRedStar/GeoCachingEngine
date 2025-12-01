import nodemailer from 'nodemailer';

import {
  EmailStatus as PrismaEmailStatus,
  Event,
  PrismaClient,
  SystemSetting
} from '@prisma/client';

const prisma = new PrismaClient();

export type EmailStatus =
  | { status: 'disabled' }
  | { status: 'sent' }
  | { status: 'error'; message: string }
  | { status: 'rate_limited'; message: string };

export const isEmailSendingEnabled = (settings: SystemSetting | null) => {
  if (!settings) return false;
  return Boolean(
    settings.smtpHost &&
      settings.smtpPort &&
      settings.smtpFromAddress &&
      settings.smtpUser &&
      settings.smtpPassword
  );
};

const DEFAULT_SUBJECT = 'Einladung: {{eventName}}';
const DEFAULT_BODY =
  'Du wurdest zu {{eventName}} eingeladen.\n\nEventstart: {{eventStart}}\nEventende: {{eventEnd}}\n\nEinladungslink: {{inviteLink}}';

type TemplateContext = {
  eventName?: string;
  eventDescription?: string | null;
  eventStart?: string;
  eventEnd?: string;
  inviteLink?: string;
};

const renderTemplate = (template: string, context: TemplateContext) => {
  return template.replace(/{{(.*?)}}/g, (_match, key) => {
    const trimmed = String(key).trim();
    const value = (context as Record<string, string | null | undefined>)[trimmed];
    return value ?? '';
  });
};

const ensureInviteLinkPlaceholder = (body: string) => {
  if (body.includes('{{inviteLink}}')) return body;
  return `${body}\n\nEinladungslink: {{inviteLink}}`;
};

const getEmailConfig = async () => {
  const settings = await prisma.systemSetting.findUnique({ where: { id: 1 } });
  return settings;
};

type RateLimitConfig = {
  perHour: number;
  perDay: number;
};

const getRateLimitConfig = (settings: SystemSetting | null): RateLimitConfig => ({
  perHour:
    settings?.maxEmailsPerHourPerAdmin ??
    Number(process.env.MAX_EMAILS_PER_HOUR_PER_ADMIN || 50),
  perDay:
    settings?.maxEmailsPerDayPerAdmin ??
    Number(process.env.MAX_EMAILS_PER_DAY_PER_ADMIN || 200)
});

const countEmails = async (adminId: string, since: Date) =>
  prisma.emailLog.count({
    where: {
      adminId,
      createdAt: { gte: since },
      NOT: { status: PrismaEmailStatus.RATE_LIMITED }
    }
  });

const checkRateLimit = async (
  adminId: string | undefined,
  settings: SystemSetting | null
): Promise<{ allowed: boolean; message?: string }> => {
  if (!adminId) return { allowed: true };
  const limits = getRateLimitConfig(settings);
  const now = Date.now();
  const perHour = await countEmails(adminId, new Date(now - 60 * 60 * 1000));
  if (limits.perHour > 0 && perHour >= limits.perHour) {
    return {
      allowed: false,
      message: `Limit erreicht (${limits.perHour} pro Stunde).`
    };
  }
  const perDay = await countEmails(adminId, new Date(now - 24 * 60 * 60 * 1000));
  if (limits.perDay > 0 && perDay >= limits.perDay) {
    return {
      allowed: false,
      message: `Limit erreicht (${limits.perDay} pro Tag).`
    };
  }
  return { allowed: true };
};

type LogParams = {
  recipient: string;
  subject: string;
  status: PrismaEmailStatus;
  errorMessage?: string | null;
  eventId?: string;
  invitationId?: string;
  adminId?: string;
};

const logEmail = async (params: LogParams) => {
  try {
    await prisma.emailLog.create({
      data: {
        recipient: params.recipient,
        subject: params.subject,
        status: params.status,
        errorMessage: params.errorMessage ?? null,
        eventId: params.eventId ?? null,
        invitationId: params.invitationId ?? null,
        adminId: params.adminId ?? null
      }
    });
  } catch (error) {
    console.error('E-Mail-Log konnte nicht geschrieben werden', error);
  }
};

type InvitationEmailOptions = {
  to: string;
  link: string;
  event: Event;
  invitationId?: string;
  adminId?: string;
  skipRateCheck?: boolean;
};

export const sendInvitationEmail = async (
  options: InvitationEmailOptions
): Promise<EmailStatus> => {
  const settings = await getEmailConfig();
  const fromAddress = options.event.senderEmail || settings?.smtpFromAddress;
  const fromName = options.event.senderName || settings?.smtpFromName || undefined;

  const subjectTemplate = options.event.invitationEmailSubject || DEFAULT_SUBJECT;
  const bodyTemplate = ensureInviteLinkPlaceholder(
    options.event.invitationEmailBody || DEFAULT_BODY
  );

  const context: TemplateContext = {
    eventName: options.event.name,
    eventDescription: options.event.description,
    eventStart: options.event.startsAt?.toISOString?.() ?? String(options.event.startsAt),
    eventEnd: options.event.endsAt?.toISOString?.() ?? String(options.event.endsAt),
    inviteLink: options.link
  };

  const subject = renderTemplate(subjectTemplate, context);
  const body = renderTemplate(bodyTemplate, context);

  if (!isEmailSendingEnabled(settings) || !fromAddress) {
    await logEmail({
      recipient: options.to,
      subject,
      status: PrismaEmailStatus.DISABLED,
      eventId: options.event.id,
      invitationId: options.invitationId,
      adminId: options.adminId,
      errorMessage: 'SMTP nicht konfiguriert'
    });
    return { status: 'disabled' };
  }

  if (!options.skipRateCheck) {
    const rate = await checkRateLimit(options.adminId, settings);
    if (!rate.allowed) {
      await logEmail({
        recipient: options.to,
        subject,
        status: PrismaEmailStatus.RATE_LIMITED,
        errorMessage: rate.message,
        eventId: options.event.id,
        invitationId: options.invitationId,
        adminId: options.adminId
      });
      return { status: 'rate_limited', message: rate.message ?? 'Rate-Limit erreicht' };
    }
  }

  try {
    const transporter = nodemailer.createTransport({
      host: settings!.smtpHost!,
      port: settings!.smtpPort!,
      secure: settings!.smtpUseTls ?? false,
      auth: {
        user: settings!.smtpUser!,
        pass: settings!.smtpPassword!
      }
    });

    await transporter.sendMail({
      from: fromName ? `${fromName} <${fromAddress}>` : fromAddress,
      to: options.to,
      subject,
      text: body
    });

    await logEmail({
      recipient: options.to,
      subject,
      status: PrismaEmailStatus.SENT,
      eventId: options.event.id,
      invitationId: options.invitationId,
      adminId: options.adminId
    });
    return { status: 'sent' };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'E-Mail-Versand nicht möglich';
    await logEmail({
      recipient: options.to,
      subject,
      status: PrismaEmailStatus.FAILED,
      errorMessage: message,
      eventId: options.event.id,
      invitationId: options.invitationId,
      adminId: options.adminId
    });
    console.error('E-Mail-Versand fehlgeschlagen', error);
    return { status: 'error', message };
  }
};

export const ensureInviteLink = (body: string, link: string) => {
  if (body.includes(link)) return body;
  if (body.includes('{{inviteLink}}')) return body.replace('{{inviteLink}}', link);
  return `${body}\n\n${link}`;
};

export const precheckRateLimit = async (
  adminId: string | undefined
): Promise<{ allowed: boolean; message?: string }> => {
  const settings = await getEmailConfig();
  return checkRateLimit(adminId, settings);
};
