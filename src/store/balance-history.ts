import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import type { BalanceOperation } from '@/src/types/admin';

const HISTORY_PREFIX = 'sub2api_balance_history';
const MAX_RECORDS_PER_USER = 20;

export type BalanceHistoryScope = {
  accountId?: string;
  baseUrl: string;
  userId: number;
};

export type BalanceHistoryRecord = BalanceHistoryScope & {
  id: string;
  userEmail?: string;
  operation: BalanceOperation;
  amount: number;
  previousBalance?: number | null;
  nextBalance?: number | null;
  notes?: string;
  createdAt: string;
};

function hashScope(value: string) {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash.toString(36);
}

function getStorageKey(scope: BalanceHistoryScope) {
  return `${HISTORY_PREFIX}_${hashScope(`${scope.accountId || 'default'}|${scope.baseUrl}|${scope.userId}`)}`;
}

async function getItem(key: string) {
  try {
    if (Platform.OS === 'web') {
      return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
    }

    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

async function setItem(key: string, value: string) {
  try {
    if (Platform.OS === 'web') {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(key, value);
      }

      return;
    }

    await SecureStore.setItemAsync(key, value);
  } catch {
    return;
  }
}

export async function listBalanceHistory(scope: BalanceHistoryScope) {
  const raw = await getItem(getStorageKey(scope));

  if (!raw) {
    return [] as BalanceHistoryRecord[];
  }

  try {
    const parsed = JSON.parse(raw) as BalanceHistoryRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [] as BalanceHistoryRecord[];
  }
}

export async function recordBalanceOperation(record: Omit<BalanceHistoryRecord, 'id' | 'createdAt'>) {
  const scope = {
    accountId: record.accountId,
    baseUrl: record.baseUrl,
    userId: record.userId,
  };
  const records = await listBalanceHistory(scope);
  const nextRecord: BalanceHistoryRecord = {
    ...record,
    id: `balance_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
  };
  const nextRecords = [nextRecord, ...records].slice(0, MAX_RECORDS_PER_USER);

  await setItem(getStorageKey(scope), JSON.stringify(nextRecords));

  return nextRecord;
}
