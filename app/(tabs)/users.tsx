import { useQueries, useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useDebouncedValue } from '@/src/hooks/use-debounced-value';
import { formatCompactNumber, formatTokenValue } from '@/src/lib/formatters';
import { queryClient } from '@/src/lib/query-client';
import { getUser, getUsageStats, listUserApiKeys, listUsers } from '@/src/services/admin';
import { adminConfigState, hasAuthenticatedAdminSession } from '@/src/store/admin-config';
import type { AdminUser, UsageStats } from '@/src/types/admin';

const { useSnapshot } = require('valtio/react');

const colors = {
  page: '#f4efe4',
  card: '#fbf8f2',
  mutedCard: '#f1ece2',
  primary: '#1d5f55',
  text: '#16181a',
  subtext: '#6f665c',
  dangerBg: '#fbf1eb',
  danger: '#c25d35',
  accentBg: '#efe4cf',
  accentText: '#8c5a22',
};

type SortOrder = 'desc' | 'asc';
type RangeKey = '24h' | '7d' | '30d';
type TileTone = 'default' | 'accent' | 'danger';
type SortKey = 'activity' | 'balance' | 'cost' | 'tokens' | 'requests';
type FilterKey = 'all' | 'low-balance' | 'debt' | 'high-cost' | 'disabled' | 'admin';

const LOW_BALANCE_THRESHOLD = 1;
const HIGH_COST_THRESHOLD = 5;

const SORT_OPTIONS: Array<{ key: SortKey; label: string }> = [
  { key: 'activity', label: '最近使用' },
  { key: 'balance', label: '余额' },
  { key: 'cost', label: '7天消费' },
  { key: 'tokens', label: '7天Token' },
  { key: 'requests', label: '7天请求' },
];

const FILTER_OPTIONS: Array<{ key: FilterKey; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'low-balance', label: '低余额' },
  { key: 'debt', label: '欠费' },
  { key: 'high-cost', label: '高消费' },
  { key: 'disabled', label: '已停用' },
  { key: 'admin', label: '管理员' },
];

function getDateRange(rangeKey: RangeKey) {
  const end = new Date();
  const start = new Date();

  if (rangeKey === '24h') {
    start.setHours(end.getHours() - 23, 0, 0, 0);
  } else if (rangeKey === '30d') {
    start.setDate(end.getDate() - 29);
  } else {
    start.setDate(end.getDate() - 6);
  }

  const toDate = (value: Date) => value.toISOString().slice(0, 10);

  return {
    start_date: toDate(start),
    end_date: toDate(end),
    granularity: rangeKey === '24h' ? ('hour' ) : ('day' ),
  };
}

function toOptionalNumber(value?: number | string | null) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function toSafeNumber(value?: number | string | null) {
  return toOptionalNumber(value) ?? 0;
}

function formatMoney(value?: number | null, digits = 2) {
  const number = toOptionalNumber(value);
  return number === undefined ? '--' : `$${number.toFixed(digits)}`;
}

function formatCost(value?: number | null) {
  return `$${toSafeNumber(value).toFixed(4)}`;
}

function getUsageCost(usage?: UsageStats) {
  return toSafeNumber(usage?.total_account_cost ?? usage?.total_actual_cost ?? usage?.total_cost);
}

function getUsageTokens(usage?: UsageStats) {
  return toSafeNumber(usage?.total_tokens);
}

function getUsageRequests(usage?: UsageStats) {
  return toSafeNumber(usage?.total_requests);
}

function formatActivityTime(value?: string) {
  if (!value) return '时间未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');

  return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`;
}

function toTimeValue(value?: string | null) {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function getTimeValue(user: AdminUser) {
  return toTimeValue(user.last_used_at) || toTimeValue(user.updated_at) || toTimeValue(user.created_at) || user.id || 0;
}

function getUserNameLabel(user: AdminUser) {
  if (user.username?.trim()) return user.username.trim();
  if (user.notes?.trim()) return user.notes.trim();
  return user.email.split('@')[0] || '未命名';
}

function getRoleLabel(role?: string) {
  const normalized = role?.trim().toLowerCase();
  if (normalized === 'admin') return '管理员';
  if (normalized === 'user') return '普通用户';
  return role?.trim() || '普通用户';
}

function isInactiveStatus(status?: string) {
  const normalized = status?.trim().toLowerCase();
  return normalized === 'inactive' || normalized === 'disabled';
}

function formatConcurrency(user: AdminUser) {
  const current = Math.max(0, Math.round(toSafeNumber(user.current_concurrency)));
  const limit = toOptionalNumber(user.concurrency);

  if (!limit || limit <= 0) {
    return `${current}/∞`;
  }

  return `${current}/${Math.round(limit)}`;
}

function hasLowBalance(user: AdminUser) {
  const balance = toOptionalNumber(user.balance);
  return balance !== undefined && balance >= 0 && balance < LOW_BALANCE_THRESHOLD;
}

function hasDebtBalance(user: AdminUser) {
  const balance = toOptionalNumber(user.balance);
  return balance !== undefined && balance < 0;
}

function isHighCostUser(user: AdminUser, usage?: UsageStats) {
  const cost = getUsageCost(usage);
  const balance = toOptionalNumber(user.balance);

  if (cost >= HIGH_COST_THRESHOLD) return true;
  return balance !== undefined && balance > 0 && cost >= balance * 0.5;
}

function getUserAlerts(user: AdminUser, usage?: UsageStats) {
  const alerts: Array<{ text: string; tone: TileTone }> = [];

  if (hasDebtBalance(user)) {
    alerts.push({ text: '余额为负', tone: 'danger' });
  } else if (hasLowBalance(user)) {
    alerts.push({ text: `余额低于 $${LOW_BALANCE_THRESHOLD}`, tone: 'danger' });
  }

  if (isHighCostUser(user, usage)) {
    alerts.push({ text: '7天消费异常', tone: 'accent' });
  }

  if (isInactiveStatus(user.status)) {
    alerts.push({ text: '用户已停用', tone: 'default' });
  }

  return alerts;
}

function matchesFilter(user: AdminUser, usage: UsageStats | undefined, filterKey: FilterKey) {
  switch (filterKey) {
    case 'low-balance':
      return hasLowBalance(user);
    case 'debt':
      return hasDebtBalance(user);
    case 'high-cost':
      return isHighCostUser(user, usage);
    case 'disabled':
      return isInactiveStatus(user.status);
    case 'admin':
      return user.role?.trim().toLowerCase() === 'admin';
    default:
      return true;
  }
}

function getSortValue(user: AdminUser, usage: UsageStats | undefined, sortKey: SortKey) {
  switch (sortKey) {
    case 'balance':
      return toOptionalNumber(user.balance);
    case 'cost':
      return getUsageCost(usage);
    case 'tokens':
      return getUsageTokens(usage);
    case 'requests':
      return getUsageRequests(usage);
    default:
      return getTimeValue(user);
  }
}

function sortUsers(left: AdminUser, right: AdminUser, usageByUserId: Map<number, UsageStats | undefined>, sortKey: SortKey, sortOrder: SortOrder) {
  const leftValue = getSortValue(left, usageByUserId.get(left.id), sortKey);
  const rightValue = getSortValue(right, usageByUserId.get(right.id), sortKey);
  const leftMissing = leftValue === undefined;
  const rightMissing = rightValue === undefined;

  if (leftMissing && !rightMissing) return 1;
  if (!leftMissing && rightMissing) return -1;

  const delta = toSafeNumber(leftValue) - toSafeNumber(rightValue);
  if (delta !== 0) {
    return sortOrder === 'desc' ? -delta : delta;
  }

  return getTimeValue(right) - getTimeValue(left);
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    switch (error.message) {
      case 'BASE_URL_REQUIRED':
        return '请先到服务器页填写服务地址。';
      case 'ADMIN_API_KEY_REQUIRED':
        return '请先到服务器页填写 Admin Token。';
      default:
        return error.message;
    }
  }

  return '当前无法加载页面数据，请检查服务地址、Token 和网络。';
}

function getTileColors(tone: TileTone) {
  if (tone === 'accent') {
    return { backgroundColor: colors.accentBg, valueColor: colors.accentText };
  }

  if (tone === 'danger') {
    return { backgroundColor: colors.dangerBg, valueColor: colors.danger };
  }

  return { backgroundColor: colors.mutedCard, valueColor: colors.text };
}

function MetricTile({ title, value, detail, tone = 'default' }: { title: string; value: string; detail?: string; tone?: TileTone }) {
  const { backgroundColor, valueColor } = getTileColors(tone);

  return (
    <View style={{ flex: 1, minWidth: 0, backgroundColor, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 12 }}>
      <Text style={{ fontSize: 11, color: colors.subtext }}>{title}</Text>
      <Text numberOfLines={1} style={{ marginTop: 6, fontSize: 16, fontWeight: '800', color: valueColor }}>
        {value}
      </Text>
      {detail ? <Text numberOfLines={1} style={{ marginTop: 4, fontSize: 10, color: colors.subtext }}>{detail}</Text> : null}
    </View>
  );
}

function SummaryTile({ title, value, detail, tone = 'default' }: { title: string; value: string; detail: string; tone?: TileTone }) {
  const { backgroundColor, valueColor } = getTileColors(tone);

  return (
    <View style={{ width: '48.5%', backgroundColor, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 12 }}>
      <Text style={{ fontSize: 11, color: colors.subtext }}>{title}</Text>
      <Text numberOfLines={1} style={{ marginTop: 6, fontSize: 18, fontWeight: '900', color: valueColor }}>
        {value}
      </Text>
      <Text numberOfLines={1} style={{ marginTop: 4, fontSize: 10, color: colors.subtext }}>{detail}</Text>
    </View>
  );
}

function InfoPill({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ backgroundColor: colors.mutedCard, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 }}>
      <Text style={{ fontSize: 10, color: colors.subtext }}>
        {label} <Text style={{ fontWeight: '800', color: colors.text }}>{value}</Text>
      </Text>
    </View>
  );
}

function AlertPill({ text, tone }: { text: string; tone: TileTone }) {
  const { backgroundColor, valueColor } = getTileColors(tone);

  return (
    <View style={{ backgroundColor, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 }}>
      <Text style={{ fontSize: 10, fontWeight: '800', color: valueColor }}>{text}</Text>
    </View>
  );
}

function SelectChip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        backgroundColor: active ? colors.primary : colors.card,
        borderRadius: 999,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderWidth: 1,
        borderColor: active ? colors.primary : colors.mutedCard,
      }}
    >
      <Text style={{ fontSize: 11, fontWeight: '800', color: active ? '#fff' : colors.subtext }}>{label}</Text>
    </Pressable>
  );
}

function UserCard({ user, usage }: { user: AdminUser; usage?: UsageStats }) {
  const isAdmin = user.role?.trim().toLowerCase() === 'admin';
  const userNameLabel = getUserNameLabel(user);
  const statusLabel = `${isAdmin ? 'admin · ' : ''}${user.status || 'active'} · ${userNameLabel}`;
  const totalCost = getUsageCost(usage);
  const totalTokens = getUsageTokens(usage);
  const totalRequests = getUsageRequests(usage);
  const balance = toOptionalNumber(user.balance);
  const balanceTone: TileTone = balance !== undefined && balance < 0 ? 'danger' : 'accent';
  const alerts = getUserAlerts(user, usage);

  return (
    <View style={{ backgroundColor: colors.card, borderRadius: 18, padding: 14 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={{ fontSize: 16, fontWeight: '800', color: colors.text }}>{user.email}</Text>
          <Text style={{ marginTop: 4, fontSize: 12, color: colors.subtext }}>最近使用 {formatActivityTime(user.last_used_at || user.updated_at || user.created_at)}</Text>
        </View>
        <View style={{ alignSelf: 'flex-start', backgroundColor: isInactiveStatus(user.status) ? '#cfc5b7' : colors.primary, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 }}>
          <Text style={{ fontSize: 10, fontWeight: '700', color: '#fff' }}>{statusLabel}</Text>
        </View>
      </View>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
        <InfoPill label="ID" value={`#${user.id}`} />
        <InfoPill label="角色" value={getRoleLabel(user.role)} />
        <InfoPill label="并发" value={formatConcurrency(user)} />
      </View>

      {alerts.length > 0 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
          {alerts.map((alert) => (
            <AlertPill key={alert.text} text={alert.text} tone={alert.tone} />
          ))}
        </View>
      ) : null}

      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
        <MetricTile title="余额" value={formatMoney(user.balance)} detail="当前账户余额" tone={balanceTone} />
        <MetricTile title="7 天消费" value={formatCost(totalCost)} detail="按当前筛选周期" />
      </View>

      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
        <MetricTile title="7 天 Token" value={formatTokenValue(totalTokens)} />
        <MetricTile title="7 天请求" value={formatCompactNumber(totalRequests)} />
      </View>
    </View>
  );
}

export default function UsersScreen() {
  const config = useSnapshot(adminConfigState);
  const hasAccount = hasAuthenticatedAdminSession(config);
  const [searchText, setSearchText] = useState('');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [sortKey, setSortKey] = useState<SortKey>('activity');
  const [filterKey, setFilterKey] = useState<FilterKey>('all');
  const debouncedSearchText = useDebouncedValue(searchText, 250);

  const usersQuery = useQuery({
    queryKey: ['users', debouncedSearchText],
    queryFn: () => listUsers(debouncedSearchText),
    enabled: hasAccount,
  });

  const usageRange = useMemo(() => getDateRange('7d'), []);

  const rawUsers = useMemo(() => [...(usersQuery.data?.items ?? [])], [usersQuery.data?.items]);

  const usageQueries = useQueries({
    queries: rawUsers.map((user) => ({
      queryKey: ['usage-stats', 'user', user.id, '7d', usageRange.start_date, usageRange.end_date],
      queryFn: () => getUsageStats({ ...usageRange, user_id: user.id }),
      enabled: hasAccount,
      staleTime: 60_000,
    })),
  });

  const usageByUserId = useMemo(
    () => new Map(rawUsers.map((user, index) => [user.id, usageQueries[index]?.data] as const)),
    [rawUsers, usageQueries]
  );

  const users = useMemo(() => {
    return rawUsers
      .filter((user) => matchesFilter(user, usageByUserId.get(user.id), filterKey))
      .sort((left, right) => sortUsers(left, right, usageByUserId, sortKey, sortOrder));
  }, [filterKey, rawUsers, sortKey, sortOrder, usageByUserId]);

  const summary = useMemo(() => {
    const usersWithBalance = rawUsers.filter((user) => toOptionalNumber(user.balance) !== undefined).length;
    const balanceTotal = rawUsers.reduce((sum, user) => sum + toSafeNumber(user.balance), 0);
    const activeUsers = rawUsers.filter((user) => !isInactiveStatus(user.status)).length;
    const adminUsers = rawUsers.filter((user) => user.role?.trim().toLowerCase() === 'admin').length;
    const lowBalanceUsers = rawUsers.filter((user) => hasLowBalance(user) || hasDebtBalance(user)).length;
    const highCostUsers = rawUsers.filter((user) => isHighCostUser(user, usageByUserId.get(user.id))).length;

    return {
      total: usersQuery.data?.total ?? users.length,
      pageCount: rawUsers.length,
      visibleCount: users.length,
      usersWithBalance,
      balanceTotal,
      activeUsers,
      adminUsers,
      lowBalanceUsers,
      highCostUsers,
    };
  }, [rawUsers, usageByUserId, users.length, usersQuery.data?.total]);

  const errorMessage = getErrorMessage(usersQuery.error);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.page }}>
      <View style={{ flex: 1, paddingHorizontal: 16, paddingTop: 14 }}>
        <View style={{ marginBottom: 10, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 28, fontWeight: '700', color: colors.text }}>用户</Text>
            <Text style={{ marginTop: 4, fontSize: 12, color: '#8a8072' }}>查看用户列表并进入详情页管理账号。</Text>
          </View>
          <Pressable
            onPress={() => router.push('/users/create-user')}
            style={{
              width: 40,
              height: 40,
              borderRadius: 12,
              backgroundColor: colors.primary,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ color: '#fff', fontSize: 24, lineHeight: 24, fontWeight: '500' }}>+</Text>
          </Pressable>
        </View>

        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
          <View style={{ flex: 1, backgroundColor: colors.card, borderRadius: 16, padding: 10 }}>
            <TextInput
              value={searchText}
              onChangeText={setSearchText}
              placeholder="搜索邮箱、用户名或备注"
              placeholderTextColor="#9b9081"
              style={{ backgroundColor: colors.mutedCard, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 11, fontSize: 15, color: colors.text }}
            />
          </View>
          <Pressable
            onPress={() => setSortOrder((value) => (value === 'desc' ? 'asc' : 'desc'))}
            style={{ backgroundColor: colors.card, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 14, minWidth: 92, alignItems: 'center' }}
          >
            <Text style={{ fontSize: 11, color: colors.subtext }}>方向</Text>
            <Text style={{ marginTop: 4, fontSize: 13, fontWeight: '700', color: colors.text }}>{sortOrder === 'desc' ? '倒序' : '正序'}</Text>
          </Pressable>
        </View>

        {hasAccount ? (
          <>
            <View style={{ marginTop: 10, flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {SORT_OPTIONS.map((item) => (
                <SelectChip key={item.key} label={item.label} active={sortKey === item.key} onPress={() => setSortKey(item.key)} />
              ))}
            </View>
            <View style={{ marginTop: 8, flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {FILTER_OPTIONS.map((item) => (
                <SelectChip key={item.key} label={item.label} active={filterKey === item.key} onPress={() => setFilterKey(item.key)} />
              ))}
            </View>
          </>
        ) : null}

        {hasAccount && !usersQuery.isLoading && !usersQuery.error ? (
          <View style={{ marginTop: 10, flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <SummaryTile title="用户总数" value={formatCompactNumber(summary.total, 0)} detail={`显示 ${summary.visibleCount}/${summary.pageCount} 个`} />
            <SummaryTile
              title="当前页余额"
              value={summary.usersWithBalance > 0 ? formatMoney(summary.balanceTotal) : '--'}
              detail={`已返回 ${summary.usersWithBalance}/${summary.pageCount} 个余额`}
              tone={summary.balanceTotal < 0 ? 'danger' : 'accent'}
            />
            <SummaryTile title="余额预警" value={formatCompactNumber(summary.lowBalanceUsers, 0)} detail="低余额或欠费" tone={summary.lowBalanceUsers > 0 ? 'danger' : 'default'} />
            <SummaryTile title="消费异常" value={formatCompactNumber(summary.highCostUsers, 0)} detail={`7天 >= $${HIGH_COST_THRESHOLD} 或接近余额`} tone={summary.highCostUsers > 0 ? 'accent' : 'default'} />
            <SummaryTile title="可用用户" value={formatCompactNumber(summary.activeUsers, 0)} detail="非禁用/停用状态" />
            <SummaryTile title="管理员" value={formatCompactNumber(summary.adminUsers, 0)} detail="当前页角色统计" />
          </View>
        ) : null}

        {!hasAccount ? (
          <View style={{ marginTop: 10, backgroundColor: colors.card, borderRadius: 18, padding: 16 }}>
            <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>未连接服务器</Text>
            <Text style={{ marginTop: 8, fontSize: 14, lineHeight: 22, color: colors.subtext }}>请先到“服务器”页完成连接，再查看用户列表。</Text>
            <Pressable
              style={{ marginTop: 14, alignSelf: 'flex-start', backgroundColor: colors.primary, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 12 }}
              onPress={() => router.push('/settings')}
            >
              <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>去配置服务器</Text>
            </Pressable>
          </View>
        ) : usersQuery.isLoading ? (
          <View style={{ marginTop: 10, backgroundColor: colors.card, borderRadius: 18, padding: 16 }}>
            <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>正在加载用户</Text>
            <Text style={{ marginTop: 8, fontSize: 14, lineHeight: 22, color: colors.subtext }}>已连接服务器，正在拉取用户列表。</Text>
          </View>
        ) : usersQuery.error ? (
          <View style={{ marginTop: 10, backgroundColor: colors.card, borderRadius: 18, padding: 16 }}>
            <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>加载失败</Text>
            <View style={{ marginTop: 12, borderRadius: 14, backgroundColor: colors.dangerBg, paddingHorizontal: 14, paddingVertical: 12 }}>
              <Text style={{ color: colors.danger, fontSize: 14, lineHeight: 20 }}>{errorMessage}</Text>
            </View>
          </View>
        ) : (
          <FlatList
            style={{ marginTop: 10, flex: 1 }}
            data={users}
            keyExtractor={(item) => `${item.id}`}
            showsVerticalScrollIndicator={false}
            refreshControl={<RefreshControl refreshing={usersQuery.isRefetching} onRefresh={() => void usersQuery.refetch()} tintColor="#1d5f55" />}
            contentContainerStyle={{ paddingBottom: 8, gap: 12, flexGrow: users.length === 0 ? 1 : 0 }}
            ListEmptyComponent={
              <View style={{ backgroundColor: colors.card, borderRadius: 18, padding: 16 }}>
                <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>暂无用户</Text>
                <Text style={{ marginTop: 8, fontSize: 14, lineHeight: 22, color: colors.subtext }}>当前搜索条件下没有匹配结果，可以修改关键词后重试。</Text>
              </View>
            }
            renderItem={({ item }) => (
              <Pressable
                onPress={() => {
                  void queryClient.prefetchQuery({ queryKey: ['user', item.id], queryFn: () => getUser(item.id) });
                  void queryClient.prefetchQuery({ queryKey: ['user-api-keys', item.id], queryFn: () => listUserApiKeys(item.id) });
                  router.push(`/users/${item.id}`);
                }}
              >
                <UserCard user={item} usage={usageByUserId.get(item.id)} />
              </Pressable>
            )}
          />
        )}
      </View>
    </SafeAreaView>
  );
}
