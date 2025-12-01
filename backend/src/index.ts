import cors from 'cors';
import crypto from 'crypto';
import dotenv from 'dotenv';
import express, { NextFunction, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import {
  EmailStatus as PrismaEmailStatus,
  PrismaClient
} from '@prisma/client';
import { isEmailSendingEnabled, precheckRateLimit, sendInvitationEmail } from './email.js';

dotenv.config();

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 4000;

const projectVersion = (() => {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')
    );
    return pkg.version as string;
  } catch (err) {
    console.warn('Version konnte nicht gelesen werden', err);
    return 'unknown';
  }
})();

app.use(cors());
app.use(express.json());

const adminTokens = new Map<string, string>();

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

const pbkdf2Hash = (password: string, salt?: string) => {
  const saltToUse = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, saltToUse, 310000, 64, 'sha512').toString('hex');
  return { salt: saltToUse, hash };
};

const verifyPassword = (password: string, stored: string) => {
  const [salt, hash] = stored.split(':');
  const { hash: attempt } = pbkdf2Hash(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(attempt, 'hex'));
};

const asyncHandler = (
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) =>
  (req: Request, res: Response, next: NextFunction) => {
    void fn(req, res, next).catch(next);
  };

const authMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  const token = authHeader.replace('Bearer ', '');
  const adminId = adminTokens.get(token);
  if (!adminId) {
    return res.status(401).json({ message: 'Invalid token' });
  }
  (req as any).adminId = adminId;
  return next();
};

type SystemSettingsInput = {
  impressumUrl?: string;
  privacyUrl?: string;
  supportEmail?: string;
  cacheVisibilityRadiusDefault?: number;
  cacheFoundRadiusDefault?: number;
  dataRetentionDays?: number;
  maxEmailsPerHourPerAdmin?: number;
  maxEmailsPerDayPerAdmin?: number;
  smtpHost?: string | null;
  smtpPort?: number | null;
  smtpUser?: string | null;
  smtpPassword?: string | null;
  smtpUseTls?: boolean;
  smtpFromAddress?: string | null;
  smtpFromName?: string | null;
};

type CachePayload = {
  id?: string;
  latitude?: number;
  longitude?: number;
  clue?: string;
  solution?: string;
};

type EventPayload = {
  name?: string;
  description?: string;
  startsAt?: string;
  endsAt?: string;
  visibleRadiusMeters?: number;
  foundRadiusMeters?: number;
  startPoint?: string;
  endPoint?: string;
  archived?: boolean;
  invitationEmailSubject?: string;
  invitationEmailBody?: string;
  senderEmail?: string;
  senderName?: string;
  caches?: CachePayload[];
};

type InvitationPayload = {
  deliveryMethod: 'LINK' | 'EMAIL';
  email?: string;
};

const getDefaultSystemSettings = () => ({
  impressumUrl: process.env.IMPRESSUM_URL || '',
  privacyUrl: process.env.PRIVACY_URL || '',
  supportEmail: process.env.SUPPORT_EMAIL || 'support@example.com',
  cacheVisibilityRadiusDefault: Number(process.env.CACHE_VISIBILITY_RADIUS || 1000),
  cacheFoundRadiusDefault: Number(process.env.CACHE_FOUND_RADIUS || 50),
  dataRetentionDays: Number(process.env.DATA_RETENTION_DAYS || 30),
  maxEmailsPerHourPerAdmin: Number(process.env.MAX_EMAILS_PER_HOUR_PER_ADMIN || 50),
  maxEmailsPerDayPerAdmin: Number(process.env.MAX_EMAILS_PER_DAY_PER_ADMIN || 200),
  smtpHost: process.env.SMTP_HOST || null,
  smtpPort: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : null,
  smtpUser: process.env.SMTP_USER || null,
  smtpPassword: process.env.SMTP_PASSWORD || null,
  smtpUseTls: process.env.SMTP_USE_TLS === 'true',
  smtpFromAddress: process.env.SMTP_FROM_ADDRESS || null,
  smtpFromName: process.env.SMTP_FROM_NAME || null
});

const ensureSystemSettings = async () => {
  const defaults = getDefaultSystemSettings();
  const existing = await prisma.systemSetting.findUnique({ where: { id: 1 } });
  if (!existing) {
    await prisma.systemSetting.create({ data: { id: 1, ...defaults } });
  }
};

const ensureDefaultAdmin = async () => {
  const email = process.env.ADMIN_EMAIL || 'admin@example.com';
  const password = process.env.ADMIN_PASSWORD || 'change-me-now';
  const minLengthOk = password.length >= 12;
  if (!minLengthOk) {
    console.warn('ADMIN_PASSWORD should be at least 12 characters');
  }
  const existing = await prisma.adminUser.findUnique({ where: { email } });
  if (!existing) {
    const { salt, hash } = pbkdf2Hash(password);
    await prisma.adminUser.create({ data: { email, passwordHash: `${salt}:${hash}` } });
  }
};

const migrationsUpToDate = async () => {
  try {
    const migrationsDir = path.resolve(process.cwd(), 'prisma', 'migrations');
    const diskMigrations = fs.existsSync(migrationsDir)
      ? fs
          .readdirSync(migrationsDir)
          .filter((entry) => fs.statSync(path.join(migrationsDir, entry)).isDirectory())
      : [];
    const result = (await prisma.$queryRaw`SELECT COUNT(*)::int AS count FROM "_prisma_migrations"`) as Array<{
      count: number;
    }>;
    const applied = result?.[0]?.count ?? 0;
    return diskMigrations.length <= applied;
  } catch (error) {
    console.warn('Migrationsstatus konnte nicht geprüft werden', error);
    return false;
  }
};

const checkDatabase = async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    console.error('DB-Probe fehlgeschlagen', error);
    return false;
  }
};

const validateEventPayload = async (payload: EventPayload) => {
  if (!payload.name || payload.name.trim().length < 3) {
    throw new Error('Event name must be at least 3 characters');
  }
  if (!payload.startsAt || !payload.endsAt) {
    throw new Error('Start and end times are required');
  }
  const startsAt = new Date(payload.startsAt);
  const endsAt = new Date(payload.endsAt);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
    throw new Error('Invalid date format');
  }
  if (startsAt >= endsAt) {
    throw new Error('Start time must be before end time');
  }
  if (!payload.visibleRadiusMeters || payload.visibleRadiusMeters <= 0) {
    throw new Error('Visible radius must be greater than 0');
  }
  if (!payload.foundRadiusMeters || payload.foundRadiusMeters <= 0) {
    throw new Error('Found radius must be greater than 0');
  }
};

const mapEventResponse = (event: any) => ({
  ...event,
  startsAt: event.startsAt?.toISOString?.() ?? event.startsAt,
  endsAt: event.endsAt?.toISOString?.() ?? event.endsAt,
  createdAt: event.createdAt?.toISOString?.() ?? event.createdAt,
  updatedAt: event.updatedAt?.toISOString?.() ?? event.updatedAt,
  archivedAt: event.archivedAt?.toISOString?.() ?? event.archivedAt,
  caches: (event.caches || []).map((cache: any) => ({
    ...cache,
    createdAt: cache.createdAt?.toISOString?.() ?? cache.createdAt,
    foundAt: cache.foundAt?.toISOString?.() ?? cache.foundAt,
    finds: (cache.finds || []).map((find: any) => ({
      ...find,
      foundAt: find.foundAt?.toISOString?.() ?? find.foundAt
    }))
  })),
  invitations: (event.invitations || []).map((invitation: any) => ({
    ...invitation,
    createdAt: invitation.createdAt?.toISOString?.() ?? invitation.createdAt,
    usedAt: invitation.usedAt?.toISOString?.() ?? invitation.usedAt,
    deactivatedAt: invitation.deactivatedAt?.toISOString?.() ?? invitation.deactivatedAt
  }))
});

app.post(
  '/api/admin/login',
  asyncHandler(async (req, res) => {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) {
      return res.status(400).json({ message: 'Missing credentials' });
    }
    const user = await prisma.adminUser.findUnique({ where: { email } });
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    const token = crypto.randomUUID();
    adminTokens.set(token, user.id);
    return res.json({ token });
  })
);

app.get(
  '/api/admin/settings',
  authMiddleware,
  asyncHandler(async (_req, res) => {
    await ensureSystemSettings();
    const settings = await prisma.systemSetting.findUnique({ where: { id: 1 } });
    return res.json({ settings, emailSendingEnabled: isEmailSendingEnabled(settings) });
  })
);

app.get(
  '/api/admin/system-status',
  authMiddleware,
  asyncHandler(async (_req, res) => {
    const [dbHealthy, migrationsOk, settings] = await Promise.all([
      checkDatabase(),
      migrationsUpToDate(),
      prisma.systemSetting.findUnique({ where: { id: 1 } })
    ]);

    return res.json({
      database: dbHealthy ? 'ok' : 'error',
      migrationsUpToDate: migrationsOk,
      emailSendingEnabled: isEmailSendingEnabled(settings),
      version: projectVersion
    });
  })
);

app.put(
  '/api/admin/settings',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const payload = req.body as { settings?: SystemSettingsInput };
    if (!payload.settings) {
      return res.status(400).json({ message: 'Missing settings payload' });
    }
    await ensureSystemSettings();
    const {
      impressumUrl,
      privacyUrl,
      supportEmail,
      cacheVisibilityRadiusDefault,
      cacheFoundRadiusDefault,
      dataRetentionDays,
      maxEmailsPerHourPerAdmin,
      maxEmailsPerDayPerAdmin,
      smtpHost,
      smtpPort,
      smtpUser,
      smtpPassword,
      smtpUseTls,
      smtpFromAddress,
      smtpFromName
    } = payload.settings;

    const data: SystemSettingsInput = {};
    if (typeof impressumUrl === 'string') data.impressumUrl = impressumUrl;
    if (typeof privacyUrl === 'string') data.privacyUrl = privacyUrl;
    if (typeof supportEmail === 'string') data.supportEmail = supportEmail;
    if (typeof cacheVisibilityRadiusDefault === 'number' && cacheVisibilityRadiusDefault > 0) {
      data.cacheVisibilityRadiusDefault = cacheVisibilityRadiusDefault;
    }
    if (typeof cacheFoundRadiusDefault === 'number' && cacheFoundRadiusDefault > 0) {
      data.cacheFoundRadiusDefault = cacheFoundRadiusDefault;
    }
    if (typeof dataRetentionDays === 'number' && dataRetentionDays > 0) {
      data.dataRetentionDays = dataRetentionDays;
    }
    if (typeof maxEmailsPerHourPerAdmin === 'number' && maxEmailsPerHourPerAdmin > 0) {
      data.maxEmailsPerHourPerAdmin = maxEmailsPerHourPerAdmin;
    }
    if (typeof maxEmailsPerDayPerAdmin === 'number' && maxEmailsPerDayPerAdmin > 0) {
      data.maxEmailsPerDayPerAdmin = maxEmailsPerDayPerAdmin;
    }
    if (smtpHost !== undefined) data.smtpHost = smtpHost || null;
    if (smtpPort !== undefined) data.smtpPort = typeof smtpPort === 'number' ? smtpPort : null;
    if (smtpUser !== undefined) data.smtpUser = smtpUser || null;
    if (smtpPassword !== undefined) data.smtpPassword = smtpPassword || null;
    if (smtpUseTls !== undefined) data.smtpUseTls = Boolean(smtpUseTls);
    if (smtpFromAddress !== undefined) data.smtpFromAddress = smtpFromAddress || null;
    if (smtpFromName !== undefined) data.smtpFromName = smtpFromName || null;

    const smtpProvided =
      data.smtpHost || data.smtpPort || data.smtpUser || data.smtpPassword || data.smtpFromAddress;
    if (smtpProvided) {
      if (!data.smtpHost) return res.status(400).json({ message: 'SMTP-Host erforderlich' });
      if (!data.smtpPort) return res.status(400).json({ message: 'SMTP-Port erforderlich' });
      if (!data.smtpFromAddress)
        return res.status(400).json({ message: 'SMTP Absenderadresse erforderlich' });
      if (!data.smtpUser) return res.status(400).json({ message: 'SMTP-Benutzer erforderlich' });
      if (!data.smtpPassword)
        return res.status(400).json({ message: 'SMTP-Passwort erforderlich' });
    }

    const updated = await prisma.systemSetting.update({
      where: { id: 1 },
      data
    });

    return res.json({ settings: updated, emailSendingEnabled: isEmailSendingEnabled(updated) });
  })
);

app.get(
  '/api/admin/events',
  authMiddleware,
  asyncHandler(async (_req, res) => {
    const events = await prisma.event.findMany({
      include: { caches: { include: { finds: true } }, invitations: true },
      orderBy: { startsAt: 'asc' }
    });
    return res.json({ events: events.map(mapEventResponse) });
  })
);

app.get(
  '/api/admin/events/:id/dashboard',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const event = await prisma.event.findUnique({
      where: { id },
      include: { caches: { include: { finds: true } }, players: true }
    });
    if (!event) {
      return res.status(404).json({ message: 'Event not found' });
    }
    const totalCaches = event.caches.length;
    const foundCount = event.caches.filter((cache) => cache.foundByAny).length;
    const completionPercent = totalCaches === 0 ? 0 : Math.round((foundCount / totalCaches) * 10000) / 100;
    const activeWindow = new Date(Date.now() - 30 * 60 * 1000);
    const activePlayerCount = event.players.filter((player) => player.lastActiveAt >= activeWindow).length;

    return res.json({
      dashboard: {
        event: {
          id: event.id,
          name: event.name,
          startsAt: event.startsAt.toISOString(),
          endsAt: event.endsAt.toISOString(),
          archived: event.archived,
          archivedAt: event.archivedAt?.toISOString() ?? null
        },
        caches: event.caches.map((cache) => ({
          id: cache.id,
          clue: cache.clue,
          latitude: cache.latitude,
          longitude: cache.longitude,
          found: cache.foundByAny,
          foundAt: cache.foundAt?.toISOString() ?? null
        })),
        playerCount: event.players.length,
        activePlayerCount,
        foundCount,
        completionPercent
      }
    });
  })
);

app.post(
  '/api/admin/events',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const body = req.body as EventPayload;
    try {
      await validateEventPayload(body);
    } catch (err) {
      return res.status(400).json({ message: (err as Error).message });
    }

    await ensureSystemSettings();
    const defaults = await prisma.systemSetting.findUnique({ where: { id: 1 } });

    const event = await prisma.event.create({
      data: {
        name: body.name!,
        description: body.description ?? null,
        startsAt: new Date(body.startsAt!),
        endsAt: new Date(body.endsAt!),
        visibleRadiusMeters: body.visibleRadiusMeters ?? defaults?.cacheVisibilityRadiusDefault ?? 1000,
        foundRadiusMeters: body.foundRadiusMeters ?? defaults?.cacheFoundRadiusDefault ?? 50,
        startPoint: body.startPoint ?? null,
        endPoint: body.endPoint ?? null,
        invitationEmailSubject: body.invitationEmailSubject ?? null,
        invitationEmailBody: body.invitationEmailBody ?? null,
        senderEmail: body.senderEmail ?? null,
        senderName: body.senderName ?? null,
        archived: body.archived ?? false,
        archivedAt: body.archived ? new Date() : null,
        createdByAdminId: (req as any).adminId,
        caches: {
          create: (body.caches || []).map((cache) => ({
            latitude: cache.latitude ?? 0,
            longitude: cache.longitude ?? 0,
            clue: cache.clue ?? '',
            solution: cache.solution ?? ''
          }))
        }
      },
      include: { caches: true }
    });

    return res.status(201).json({ event: mapEventResponse(event) });
  })
);

app.put(
  '/api/admin/events/:id',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const body = req.body as EventPayload;
    const existing = await prisma.event.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ message: 'Event not found' });
    }
    try {
      await validateEventPayload(body);
    } catch (err) {
      return res.status(400).json({ message: (err as Error).message });
    }

    const archivedAt = body.archived
      ? existing.archivedAt ?? new Date()
      : null;

    const event = await prisma.event.update({
      where: { id },
      data: {
        name: body.name!,
        description: body.description ?? null,
        startsAt: new Date(body.startsAt!),
        endsAt: new Date(body.endsAt!),
        visibleRadiusMeters: body.visibleRadiusMeters!,
        foundRadiusMeters: body.foundRadiusMeters!,
        startPoint: body.startPoint ?? null,
        endPoint: body.endPoint ?? null,
        invitationEmailSubject: body.invitationEmailSubject ?? null,
        invitationEmailBody: body.invitationEmailBody ?? null,
        senderEmail: body.senderEmail ?? null,
        senderName: body.senderName ?? null,
        archived: body.archived ?? false,
        archivedAt
      },
      include: { caches: { include: { finds: true } } }
    });

    return res.json({ event: mapEventResponse(event) });
  })
);

app.delete(
  '/api/admin/events/:id',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    await prisma.$transaction([
      prisma.emailLog.deleteMany({ where: { eventId: id } }),
      prisma.cacheFind.deleteMany({ where: { cache: { eventId: id } } }),
      prisma.invitation.deleteMany({ where: { eventId: id } }),
      prisma.cache.deleteMany({ where: { eventId: id } }),
      prisma.player.deleteMany({ where: { eventId: id } }),
      prisma.event.delete({ where: { id } })
    ]);
    return res.status(204).send();
  })
);

app.post(
  '/api/admin/events/:id/archive',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const event = await prisma.event.update({
      where: { id },
      data: { archived: true, archivedAt: new Date() }
    });
    return res.json({ event: mapEventResponse(event) });
  })
);

app.get(
  '/api/admin/events/:id/export',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const event = await prisma.event.findUnique({
      where: { id },
      include: {
        caches: { include: { finds: true } },
        invitations: true,
        players: true
      }
    });
    if (!event) {
      return res.status(404).json({ message: 'Event not found' });
    }
    const exportPayload = {
      event: {
        id: event.id,
        name: event.name,
        description: event.description,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        visibleRadiusMeters: event.visibleRadiusMeters,
        foundRadiusMeters: event.foundRadiusMeters,
        archived: event.archived,
        archivedAt: event.archivedAt,
        startPoint: event.startPoint,
        endPoint: event.endPoint
      },
      caches: event.caches.map((cache) => ({
        id: cache.id,
        latitude: cache.latitude,
        longitude: cache.longitude,
        clue: cache.clue,
        solution: cache.solution,
        foundByAny: cache.foundByAny,
        foundAt: cache.foundAt,
        finds: cache.finds.map((find) => ({
          playerId: find.playerId,
          nickname: find.nickname,
          foundAt: find.foundAt
        }))
      })),
      invitations: event.invitations.map((invitation) => ({
        id: invitation.id,
        deliveryMethod: invitation.deliveryMethod,
        email: invitation.email,
        createdAt: invitation.createdAt,
        isActive: invitation.isActive,
        deactivatedAt: invitation.deactivatedAt,
        usedAt: invitation.usedAt
      })),
      players: event.players.map((player) => ({
        id: player.id,
        nickname: player.nickname,
        createdAt: player.createdAt,
        lastActiveAt: player.lastActiveAt
      }))
    };
    return res.json({ export: exportPayload });
  })
);

app.post(
  '/api/admin/events/:id/caches',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const body = req.body as CachePayload;
    if (typeof body.latitude !== 'number' || typeof body.longitude !== 'number') {
      return res.status(400).json({ message: 'Latitude and longitude are required' });
    }

    const cache = await prisma.cache.create({
      data: {
        eventId: id,
        latitude: body.latitude,
        longitude: body.longitude,
        clue: body.clue ?? '',
        solution: body.solution ?? ''
      }
    });

    return res.status(201).json({ cache });
  })
);

app.put(
  '/api/admin/events/:eventId/caches/:cacheId',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { cacheId } = req.params;
    const body = req.body as CachePayload;
    const cache = await prisma.cache.update({
      where: { id: cacheId },
      data: {
        latitude: body.latitude ?? undefined,
        longitude: body.longitude ?? undefined,
        clue: body.clue ?? undefined,
        solution: body.solution ?? undefined
      }
    });
    return res.json({ cache });
  })
);

app.post(
  '/api/admin/events/:eventId/caches/:cacheId/reset',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { cacheId } = req.params;
    await prisma.cacheFind.deleteMany({ where: { cacheId } });
    const cache = await prisma.cache.update({
      where: { id: cacheId },
      data: { foundByAny: false, foundAt: null }
    });
    return res.json({ cache });
  })
);

app.delete(
  '/api/admin/events/:eventId/caches/:cacheId',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { cacheId } = req.params;
    await prisma.cacheFind.deleteMany({ where: { cacheId } });
    await prisma.cache.delete({ where: { id: cacheId } });
    return res.status(204).send();
  })
);

app.post(
  '/api/admin/events/:id/invitations',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const body = req.body as InvitationPayload;
    const adminId = (req as any).adminId as string | undefined;
    const event = await prisma.event.findUnique({ where: { id } });
    if (!event) {
      return res.status(404).json({ message: 'Event not found' });
    }
    if (body.deliveryMethod === 'EMAIL' && !body.email) {
      return res.status(400).json({ message: 'Email is required for email invitations' });
    }
    const settings = await prisma.systemSetting.findUnique({ where: { id: 1 } });
    const emailEnabled = isEmailSendingEnabled(settings);
    if (body.deliveryMethod === 'EMAIL' && !emailEnabled) {
      return res
        .status(400)
        .json({ message: 'E-Mail-Versand ist nicht konfiguriert. Bitte SMTP einrichten.' });
    }
    if (body.deliveryMethod === 'EMAIL' && adminId) {
      const rate = await precheckRateLimit(adminId);
      if (!rate.allowed) {
        await prisma.emailLog.create({
          data: {
            recipient: body.email!,
            subject: event.invitationEmailSubject || `Einladung: ${event.name}`,
            status: PrismaEmailStatus.RATE_LIMITED,
            errorMessage: rate.message ?? 'Rate-Limit erreicht',
            eventId: event.id,
            adminId
          }
        });
        return res.status(429).json({ message: rate.message ?? 'Rate-Limit erreicht' });
      }
    }
    const token = crypto.randomBytes(24).toString('hex');
    const invitation = await prisma.invitation.create({
      data: {
        eventId: id,
        token,
        deliveryMethod: body.deliveryMethod,
        email: body.email ?? null
      }
    });

    const baseUrl = process.env.BASE_URL || 'http://localhost:5173';
    const link = `${baseUrl}/join/${token}`;
    if (body.deliveryMethod === 'EMAIL' && body.email) {
      const result = await sendInvitationEmail({
        to: body.email,
        link,
        event,
        invitationId: invitation.id,
        adminId,
        skipRateCheck: true
      });
      if (result.status === 'rate_limited') {
        await prisma.invitation.delete({ where: { id: invitation.id } });
        return res.status(429).json({ message: result.message });
      }
      if (result.status === 'error') {
        return res.status(500).json({ message: result.message });
      }
    }
    return res.status(201).json({ invitation, link });
  })
);

app.put(
  '/api/admin/events/:eventId/invitations/:invitationId',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { eventId, invitationId } = req.params;
    const { isActive } = req.body as { isActive?: boolean };
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ message: 'isActive muss gesetzt werden' });
    }
    const invitation = await prisma.invitation.findFirst({ where: { id: invitationId, eventId } });
    if (!invitation) {
      return res.status(404).json({ message: 'Invitation not found' });
    }
    const updated = await prisma.invitation.update({
      where: { id: invitationId },
      data: {
        isActive: Boolean(isActive),
        deactivatedAt: isActive ? null : new Date()
      }
    });
    return res.json({
      invitation: {
        ...updated,
        createdAt: updated.createdAt.toISOString(),
        usedAt: updated.usedAt?.toISOString() ?? null,
        deactivatedAt: updated.deactivatedAt?.toISOString() ?? null
      }
    });
  })
);

app.get(
  '/api/admin/events/:id/email-logs',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const status = req.query.status as string | undefined;
    const where: any = { eventId: id };
    if (status && Object.values(PrismaEmailStatus).includes(status as PrismaEmailStatus)) {
      where.status = status as PrismaEmailStatus;
    }
    const logs = await prisma.emailLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100
    });
    return res.json({
      logs: logs.map((log) => ({
        ...log,
        createdAt: log.createdAt.toISOString()
      }))
    });
  })
);

app.get(
  '/join/:token',
  asyncHandler(async (req, res) => {
    const { token } = req.params;
    const invitation = await prisma.invitation.findUnique({
      where: { token },
      include: { event: true }
    });
    if (!invitation) {
      return res.status(404).json({ message: 'Invitation not found' });
    }
    if (!invitation.isActive) {
      return res.status(400).json({ message: 'Diese Einladung ist nicht mehr gültig.' });
    }
    const now = new Date();
    if (invitation.event.endsAt < now) {
      return res.status(400).json({ message: 'Event expired' });
    }
    return res.json({
      event: mapEventResponse(invitation.event),
      invitation: { token: invitation.token, deliveryMethod: invitation.deliveryMethod }
    });
  })
);

app.post(
  '/api/public/events/:id/players',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { nickname, playerId } = req.body as { nickname?: string; playerId?: string };
    const event = await prisma.event.findUnique({ where: { id } });
    const now = new Date();
    if (!event || event.archived || event.startsAt > now || event.endsAt < now) {
      return res.status(400).json({ message: 'Event nicht aktiv' });
    }

    const identifier = playerId || `player-${crypto.randomBytes(6).toString('hex')}`;
    const existing = await prisma.player.findUnique({ where: { id: identifier } });
    if (existing && existing.eventId !== id) {
      return res.status(400).json({ message: 'Spielerkennung ungültig' });
    }

    const player = await prisma.player.upsert({
      where: { id: identifier },
      update: { lastActiveAt: new Date(), nickname: nickname ?? undefined },
      create: { id: identifier, eventId: id, nickname: nickname ?? null }
    });

    return res.json({ playerId: player.id });
  })
);

app.post(
  '/api/events/:eventId/caches/:cacheId/found',
  asyncHandler(async (req, res) => {
    const { eventId, cacheId } = req.params;
    const { playerId, nickname } = req.body as { playerId?: string; nickname?: string };
    const cache = await prisma.cache.findFirst({ where: { id: cacheId, eventId } });
    if (!cache) {
      return res.status(404).json({ message: 'Cache not found' });
    }
    const playerIdentifier = playerId || `player-${crypto.randomBytes(5).toString('hex')}`;
    const existingPlayer = await prisma.player.findUnique({ where: { id: playerIdentifier } });
    if (existingPlayer && existingPlayer.eventId !== eventId) {
      return res.status(400).json({ message: 'Spieler gehört nicht zu diesem Event' });
    }

    await prisma.player.upsert({
      where: { id: playerIdentifier },
      update: { lastActiveAt: new Date(), nickname: nickname ?? undefined },
      create: { id: playerIdentifier, eventId, nickname: nickname ?? null }
    });

    await prisma.cacheFind.create({ data: { cacheId, playerId: playerIdentifier, nickname: nickname ?? null } });
    const updated = await prisma.cache.update({
      where: { id: cacheId },
      data: { foundByAny: true, foundAt: new Date() }
    });
    return res.json({ cache: updated, playerId: playerIdentifier });
  })
);

app.get(
  '/api/public/events',
  asyncHandler(async (_req, res) => {
    const now = new Date();
    const events = await prisma.event.findMany({
      where: { archived: false, startsAt: { lte: now }, endsAt: { gte: now } },
      orderBy: { startsAt: 'asc' }
    });
    return res.json({ events: events.map(mapEventResponse) });
  })
);

app.get(
  '/api/public/events/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const event = await prisma.event.findUnique({ where: { id }, include: { caches: { include: { finds: true } } } });
    if (!event) {
      return res.status(404).json({ message: 'Event not found' });
    }
    const now = new Date();
    if (event.archived || event.endsAt < now) {
      return res.status(400).json({ message: 'Event not active' });
    }
    return res.json({ event: mapEventResponse(event) });
  })
);

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ message: 'Internal server error' });
});

const start = async () => {
  await ensureSystemSettings();
  await ensureDefaultAdmin();
  app.listen(PORT, () => {
    console.log(`Backend listening on http://localhost:${PORT}`);
  });
};

void start();
