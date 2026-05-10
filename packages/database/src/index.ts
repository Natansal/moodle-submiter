import prismaPkg from '../generated/prisma/index.js';
import { PrismaPg } from '@prisma/adapter-pg';

export type { Prisma } from '../generated/prisma/index.js';

export const PrismaClient = prismaPkg.PrismaClient;
export type PrismaClient = InstanceType<typeof prismaPkg.PrismaClient>;

export { usePrismaAuthState } from './use-prisma-auth-state.js';

let prismaInstance: PrismaClient | undefined;

export function getPrismaClient(): PrismaClient {
  if (!prismaInstance) {
    const datasourceUrl = process.env.DATABASE_URL;
    if (!datasourceUrl) {
      throw new Error('DATABASE_URL is required for PrismaClient initialization');
    }

    const adapter = new PrismaPg({ connectionString: datasourceUrl });
    prismaInstance = new PrismaClient({ adapter });
  }

  return prismaInstance;
}
