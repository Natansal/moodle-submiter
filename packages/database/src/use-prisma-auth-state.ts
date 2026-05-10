import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
  type SignalDataSet,
} from '@whiskeysockets/baileys';
import prismaPkg from '../generated/prisma/index.js';
import type { Prisma } from '../generated/prisma/index.js';

type PrismaClient = InstanceType<typeof prismaPkg.PrismaClient>;

type JsonRecord = Record<string, unknown>;
type SessionKeys = Record<string, Record<string, unknown>>;

const locks = new Map<string, Promise<void>>();

async function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(userId) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(userId, previous.then(() => current));
  await previous;

  try {
    return await fn();
  } finally {
    release();
    if (locks.get(userId) === current) {
      locks.delete(userId);
    }
  }
}

function serialize(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value, BufferJSON.replacer)) as Prisma.InputJsonValue;
}

function deserialize<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value), BufferJSON.reviver) as T;
}

function ensureObject(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as JsonRecord;
}

async function ensureSession(prisma: PrismaClient, userId: string) {
  return prisma.whatsAppSession.upsert({
    where: { userId },
    update: {},
    create: {
      userId,
      creds: serialize(initAuthCreds()),
      keys: {} as Prisma.InputJsonObject,
    },
  });
}

export async function usePrismaAuthState(
  prisma: PrismaClient,
  userId: string,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const session = await ensureSession(prisma, userId);

  let creds = deserialize<AuthenticationCreds>(
    session.creds && Object.keys(ensureObject(session.creds)).length > 0
      ? session.creds
      : serialize(initAuthCreds()),
  );

  const keys = ensureObject(session.keys) as SessionKeys;

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const data = {} as { [id: string]: SignalDataTypeMap[T] };
        const bucket = ensureObject(keys[String(type)]);

        for (const id of ids) {
          const value = bucket[id];
          if (!value) continue;
          if (String(type) === 'app-state-sync-key') {
            data[id] = proto.Message.AppStateSyncKeyData.fromObject(
              deserialize<Record<string, unknown>>(value),
            ) as unknown as SignalDataTypeMap[T];
            continue;
          }

          data[id] = deserialize<SignalDataTypeMap[T]>(value);
        }

        return data;
      },
      set: async (data: SignalDataSet) => {
        await withUserLock(userId, async () => {
          const latest = await prisma.whatsAppSession.findUnique({
            where: { userId },
            select: { keys: true },
          });
          const latestKeys = ensureObject(latest?.keys) as SessionKeys;

          for (const [category, categoryData] of Object.entries(data) as [
            keyof SignalDataSet,
            SignalDataSet[keyof SignalDataSet],
          ][]) {
            const categoryKey = String(category);
            latestKeys[categoryKey] = latestKeys[categoryKey] || {};
            if (!categoryData) continue;

            for (const id of Object.keys(categoryData)) {
              const value = categoryData[id];
              if (value) {
                latestKeys[categoryKey]![id] = serialize(value);
              } else {
                delete latestKeys[categoryKey]![id];
              }
            }
          }

          await prisma.whatsAppSession.update({
            where: { userId },
            data: { keys: latestKeys as unknown as Prisma.InputJsonObject },
          });
          Object.assign(keys, latestKeys);
        });
      },
    },
  };

  const saveCreds = async () => {
    await withUserLock(userId, async () => {
      await prisma.whatsAppSession.update({
        where: { userId },
        data: { creds: serialize(creds) as Prisma.InputJsonValue },
      });
    });
  };

  Object.defineProperty(state, 'creds', {
    get: () => creds,
    set: (value: AuthenticationCreds) => {
      creds = value;
    },
    enumerable: true,
    configurable: true,
  });

  return { state, saveCreds };
}
