import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenv.config();

const prisma = new PrismaClient();

const run = async () => {
  const retention = Number(process.env.DATA_RETENTION_DAYS || 30);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retention);

  const expiredEvents = await prisma.event.findMany({ where: { endsAt: { lt: cutoff } }, select: { id: true } });
  for (const evt of expiredEvents) {
    await prisma.cacheFind.deleteMany({ where: { cache: { eventId: evt.id } } });
    await prisma.invitation.deleteMany({ where: { eventId: evt.id } });
    await prisma.cache.deleteMany({ where: { eventId: evt.id } });
    await prisma.event.delete({ where: { id: evt.id } });
  }
  console.log(`Cleaned ${expiredEvents.length} expired events`);
};

void run().finally(async () => prisma.$disconnect());
