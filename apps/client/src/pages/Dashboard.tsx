import { useEffect, useMemo, useState } from 'react';
import { fetchChats, fetchSettings, saveSettings } from '../lib/api';
import { useToast } from '../components/Toast';
import { Spinner } from '../components/Spinner';

type ChatOption = { id: string; subject: string; kind: 'group' | 'private' };

type ScheduleDay =
  | 'sunday'
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday';

type UptimeRange = { start: number; end: number };
type UptimeRow = { day: ScheduleDay; ranges: UptimeRange[] };

const DAY_META: { day: ScheduleDay; label: string }[] = [
  { day: 'sunday', label: 'Sunday' },
  { day: 'monday', label: 'Monday' },
  { day: 'tuesday', label: 'Tuesday' },
  { day: 'wednesday', label: 'Wednesday' },
  { day: 'thursday', label: 'Thursday' },
  { day: 'friday', label: 'Friday' },
  { day: 'saturday', label: 'Saturday' },
];

interface Settings {
  email?: string;
  password?: string;
  activeGroupIds?: string[];
  active?: boolean;
  uptimes?: { day: string; ranges: { start: number; end: number }[] }[];
}

function createDefaultUptimeRows(): UptimeRow[] {
  return DAY_META.map(({ day }) => ({ day, ranges: [] }));
}

function mergeLoadedUptimes(raw: unknown): UptimeRow[] {
  const byDay = new Map<ScheduleDay, UptimeRange[]>();
  for (const { day } of DAY_META) byDay.set(day, []);

  if (Array.isArray(raw)) {
    for (const u of raw) {
      if (!u || typeof u.day !== 'string') continue;
      const day = u.day as ScheduleDay;
      if (!byDay.has(day)) continue;
      const ranges = Array.isArray(u.ranges)
        ? u.ranges
            .map((r: { start?: number; end?: number }) => ({
              start: typeof r.start === 'number' ? Math.max(0, Math.min(1440, Math.floor(r.start))) : 0,
              end: typeof r.end === 'number' ? Math.max(0, Math.min(1440, Math.floor(r.end))) : 0,
            }))
            .filter((r: UptimeRange) => r.start < r.end)
        : [];
      byDay.set(day, ranges);
    }
  }

  return DAY_META.map(({ day }) => ({ day, ranges: byDay.get(day)! }));
}

function minutesToTimeInput(m: number): string {
  const clamped = Math.max(0, Math.min(1439, m));
  const h = Math.floor(clamped / 60);
  const min = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function timeInputToMinutes(v: string): number | null {
  const parts = v.split(':');
  if (parts.length !== 2) return null;
  const h = Number(parts[0]);
  const min = Number(parts[1]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function normalizeSearch(s: string): string {
  return s.trim().toLowerCase();
}

/** E.164 digits only, no leading + (WhatsApp PN jid user part). */
function phoneInputToPnJid(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return `${digits}@s.whatsapp.net`;
}

function privateJidToLabel(jid: string): string {
  if (jid.endsWith('@s.whatsapp.net')) {
    const d = jid.slice(0, -'@s.whatsapp.net'.length);
    return d ? `+${d}` : jid;
  }
  return jid;
}

export function DashboardPage() {
  const { toast } = useToast();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [groups, setGroups] = useState<ChatOption[]>([]);
  const [activeChatIds, setActiveChatIds] = useState<string[]>([]);
  const [chatQuery, setChatQuery] = useState('');
  const [phoneInput, setPhoneInput] = useState('');
  const [loadingChats, setLoadingChats] = useState(true);
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [saving, setSaving] = useState(false);
  const [automationActive, setAutomationActive] = useState(true);
  const [uptimeRows, setUptimeRows] = useState<UptimeRow[]>(() => createDefaultUptimeRows());

  useEffect(() => {
    fetchChats()
      .then((result) => {
        setGroups(result.chats.filter((c) => c.kind === 'group'));
      })
      .catch((err: Error) => toast(err.message, 'error'))
      .finally(() => setLoadingChats(false));

    fetchSettings()
      .then((result) => {
        const s = result.settings as Settings | null;
        if (s) {
          setEmail(s.email ?? '');
          setPassword(s.password ?? '');
          setActiveChatIds(s.activeGroupIds ?? []);
          setAutomationActive(s.active !== false);
          setUptimeRows(mergeLoadedUptimes(s.uptimes));
        }
      })
      .catch((err: Error) => toast(err.message, 'error'))
      .finally(() => setLoadingSettings(false));
  }, [toast]);

  const groupIdSet = useMemo(() => new Set(groups.map((g) => g.id)), [groups]);

  const privateChatOptions: ChatOption[] = useMemo(() => {
    const seen = new Set<string>();
    const out: ChatOption[] = [];
    for (const id of activeChatIds) {
      if (groupIdSet.has(id) || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        subject: privateJidToLabel(id),
        kind: 'private',
      });
    }
    return out;
  }, [activeChatIds, groupIdSet]);

  const filteredGroups = useMemo(() => {
    const q = normalizeSearch(chatQuery);
    if (!q) return groups;
    return groups.filter((c) => c.subject.toLowerCase().includes(q));
  }, [groups, chatQuery]);

  const filteredPrivate = useMemo(() => {
    const q = normalizeSearch(chatQuery);
    if (!q) return privateChatOptions;
    return privateChatOptions.filter(
      (c) => c.subject.toLowerCase().includes(q) || c.id.toLowerCase().includes(q),
    );
  }, [privateChatOptions, chatQuery]);

  function toggleChat(chatId: string) {
    setActiveChatIds((prev) =>
      prev.includes(chatId) ? prev.filter((id) => id !== chatId) : [...prev, chatId],
    );
  }

  function addUptimeRange(day: ScheduleDay) {
    setUptimeRows((prev) =>
      prev.map((row) =>
        row.day === day
          ? { ...row, ranges: [...row.ranges, { start: 9 * 60, end: 17 * 60 }] }
          : row,
      ),
    );
  }

  function removeUptimeRange(day: ScheduleDay, index: number) {
    setUptimeRows((prev) =>
      prev.map((row) =>
        row.day === day ? { ...row, ranges: row.ranges.filter((_, i) => i !== index) } : row,
      ),
    );
  }

  function patchUptimeRange(day: ScheduleDay, index: number, field: 'start' | 'end', raw: string) {
    const mins = timeInputToMinutes(raw);
    if (mins === null) return;
    setUptimeRows((prev) =>
      prev.map((row) => {
        if (row.day !== day) return row;
        const ranges = row.ranges.map((r, i) => (i === index ? { ...r, [field]: mins } : r));
        return { ...row, ranges };
      }),
    );
  }

  function addPrivateNumber() {
    const jid = phoneInputToPnJid(phoneInput);
    if (!jid) {
      toast('Enter a valid number with country code (8–15 digits).', 'error');
      return;
    }
    if (activeChatIds.includes(jid)) {
      toast('That number is already in the list.', 'error');
      return;
    }
    setActiveChatIds((prev) => [...prev, jid]);
    setPhoneInput('');
    toast('Number added.', 'success');
  }

  async function onSave(event: React.FormEvent) {
    event.preventDefault();

    for (const row of uptimeRows) {
      for (const r of row.ranges) {
        if (r.start >= r.end) {
          toast(`${DAY_META.find((d) => d.day === row.day)?.label ?? row.day}: each window needs end after start.`, 'error');
          return;
        }
      }
    }

    setSaving(true);
    try {
      await saveSettings({
        email,
        ...(password.trim() ? { password: password.trim() } : {}),
        activeGroupIds: activeChatIds,
        uptimes: uptimeRows.map((row) => ({
          day: row.day,
          ranges: row.ranges.map((r) => ({ start: r.start, end: r.end })),
        })),
        active: automationActive,
      });
      toast('Settings saved successfully', 'success');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  }

  const isLoading = loadingChats || loadingSettings;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
          Settings
        </h1>
        <p className="mt-1 text-sm text-gray-400">
          Configure your Moodle credentials, when automation may run (Asia/Jerusalem), WhatsApp groups, and private
          numbers to monitor.
        </p>
      </div>

      <form onSubmit={onSave} className="space-y-6">
        <div className="card">
          <h2 className="mb-4 text-base font-semibold text-white">Moodle Credentials</h2>

          {isLoading ? (
            <div className="space-y-4">
              <div className="skeleton h-10 w-full" />
              <div className="skeleton h-10 w-full" />
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <label htmlFor="moodle-email" className="mb-1.5 block text-xs font-medium text-gray-400">
                  Moodle Email
                </label>
                <input
                  id="moodle-email"
                  className="input-field"
                  type="email"
                  value={email}
                  placeholder="student@university.edu"
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div>
                <label htmlFor="moodle-password" className="mb-1.5 block text-xs font-medium text-gray-400">
                  Moodle Password
                </label>
                <input
                  id="moodle-password"
                  className="input-field"
                  type="password"
                  value={password}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  onChange={(e) => setPassword(e.target.value)}
                />
                <p className="mt-1.5 text-xs text-gray-600">
                  Loaded from your account. Clear before saving if you are only changing other settings — your saved
                  password is kept.
                </p>
              </div>
            </div>
          )}
        </div>

        <div
          className={`card relative overflow-hidden transition-shadow duration-300 ${
            automationActive
              ? 'border-emerald-500/25 shadow-emerald-900/20 shadow-lg ring-1 ring-emerald-500/15'
              : 'border-amber-500/20 ring-1 ring-amber-500/10'
          }`}
        >
          <div
            className={`pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent ${
              automationActive ? 'via-emerald-400/50' : 'via-amber-400/40'
            } to-transparent`}
            aria-hidden
          />
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-base font-semibold text-white">Automation schedule</h2>
              <p className="mt-1 text-xs text-gray-500">
                Times use <span className="text-gray-400">Asia/Jerusalem</span> (same as the listener). Outside these
                windows, Moodle links are ignored. Turning automation off stops the worker entirely.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={automationActive}
              disabled={isLoading}
              onClick={() => setAutomationActive((v) => !v)}
              className={`relative flex h-9 w-14 shrink-0 items-center rounded-full p-0.5 transition-colors duration-200 ${
                automationActive ? 'bg-emerald-600' : 'bg-gray-700'
              } disabled:opacity-50`}
            >
              <span
                className={`h-7 w-7 rounded-full bg-white shadow-md transition-transform duration-200 ease-out ${
                  automationActive ? 'translate-x-6' : 'translate-x-0.5'
                }`}
              />
              <span className="sr-only">{automationActive ? 'Automation on' : 'Automation off'}</span>
            </button>
          </div>

          {!automationActive ? (
            <div className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100/90">
              Automation is off: incoming Moodle links will not call the worker until you enable this again.
            </div>
          ) : null}

          {isLoading ? (
            <div className="mt-6 space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="skeleton h-14 w-full" />
              ))}
            </div>
          ) : (
            <div className="mt-6 space-y-3">
              {uptimeRows.map((row) => (
                <div
                  key={row.day}
                  className="rounded-xl border border-gray-800/80 bg-gray-950/40 px-4 py-3 transition-colors hover:border-gray-700/80"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <p className="text-sm font-medium text-gray-200">
                      {DAY_META.find((d) => d.day === row.day)?.label}
                    </p>
                    <button
                      type="button"
                      className="btn-secondary self-start px-3 py-1.5 text-xs"
                      onClick={() => addUptimeRange(row.day)}
                      disabled={!automationActive}
                    >
                      Add hours
                    </button>
                  </div>
                  {row.ranges.length === 0 ? (
                    <p className="mt-2 text-xs text-gray-600">No windows — automation will not run this day.</p>
                  ) : (
                    <ul className="mt-3 space-y-2">
                      {row.ranges.map((range, idx) => (
                        <li
                          key={`${row.day}-${idx}`}
                          className="flex flex-wrap items-center gap-2 rounded-lg bg-gray-900/50 px-2 py-2 sm:flex-nowrap"
                        >
                          <input
                            type="time"
                            className="input-field w-auto min-w-[7rem] py-2 text-sm"
                            value={minutesToTimeInput(range.start)}
                            onChange={(e) => patchUptimeRange(row.day, idx, 'start', e.target.value)}
                            disabled={!automationActive}
                          />
                          <span className="text-xs text-gray-500">to</span>
                          <input
                            type="time"
                            className="input-field w-auto min-w-[7rem] py-2 text-sm"
                            value={minutesToTimeInput(range.end)}
                            onChange={(e) => patchUptimeRange(row.day, idx, 'end', e.target.value)}
                            disabled={!automationActive}
                          />
                          <button
                            type="button"
                            className="ml-auto rounded-lg border border-gray-700 px-2 py-1 text-xs text-gray-400 transition-colors hover:border-red-500/50 hover:bg-red-500/10 hover:text-red-300"
                            onClick={() => removeUptimeRange(row.day, idx)}
                            disabled={!automationActive}
                          >
                            Remove
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <h2 className="mb-4 text-base font-semibold text-white">WhatsApp: groups</h2>
          <p className="mb-4 text-xs text-gray-500">
            Groups are loaded from your linked WhatsApp account. Select which groups may trigger Moodle submissions.
          </p>

          {!loadingChats && (groups.length > 0 || privateChatOptions.length > 0) ? (
            <div className="mb-3">
              <label htmlFor="chat-search" className="mb-1.5 block text-xs font-medium text-gray-400">
                Search groups
              </label>
              <input
                id="chat-search"
                className="input-field"
                type="search"
                value={chatQuery}
                placeholder="Filter…"
                onChange={(e) => setChatQuery(e.target.value)}
                autoComplete="off"
              />
            </div>
          ) : null}

          {loadingChats ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="skeleton h-8 w-full" />
              ))}
            </div>
          ) : groups.length === 0 ? (
            <div className="rounded-xl border border-gray-800/40 bg-gray-800/20 px-4 py-6 text-center">
              <p className="text-sm text-gray-500">
                No groups found. Connect WhatsApp on the setup page first.
              </p>
            </div>
          ) : (
            <div className="max-h-48 space-y-1 overflow-y-auto pr-1">
              {filteredGroups.map((chat) => (
                  <label
                    key={chat.id}
                    className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-gray-800/50"
                  >
                    <input
                      type="checkbox"
                      checked={activeChatIds.includes(chat.id)}
                      onChange={() => toggleChat(chat.id)}
                      className="h-4 w-4 shrink-0 rounded border-gray-600 bg-gray-800 text-indigo-500 focus:ring-indigo-500 focus:ring-offset-0"
                    />
                    <span className="shrink-0 rounded bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-300">
                      Group
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-gray-300">{chat.subject}</span>
                  </label>
                ))}
            </div>
          )}
        </div>

        <div className="card">
          <h2 className="mb-4 text-base font-semibold text-white">WhatsApp: private numbers</h2>
          <p className="mb-4 text-xs text-gray-500">
            Add contacts by international number (with or without +). Stored as{' '}
            <span className="font-mono text-gray-400">countrycode…@s.whatsapp.net</span>. Messages may arrive on a
            different internal id; the listener maps LID ↔ phone when possible.
          </p>

          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1">
              <label htmlFor="private-phone" className="mb-1.5 block text-xs font-medium text-gray-400">
                Phone number
              </label>
              <input
                id="private-phone"
                className="input-field"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="e.g. +972501234567 or 972501234567"
                value={phoneInput}
                onChange={(e) => setPhoneInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addPrivateNumber();
                  }
                }}
              />
            </div>
            <button type="button" className="btn-primary shrink-0" onClick={addPrivateNumber} disabled={isLoading}>
              Add number
            </button>
          </div>

          {privateChatOptions.length === 0 ? (
            <p className="text-sm text-gray-500">No numbers added yet. Add at least one if you need private DMs.</p>
          ) : (
            <div className="max-h-48 space-y-1 overflow-y-auto pr-1">
              {filteredPrivate.map((chat) => (
                <label
                  key={chat.id}
                  className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-gray-800/50"
                >
                  <input
                    type="checkbox"
                    checked={activeChatIds.includes(chat.id)}
                    onChange={() => toggleChat(chat.id)}
                    className="h-4 w-4 shrink-0 rounded border-gray-600 bg-gray-800 text-indigo-500 focus:ring-indigo-500 focus:ring-offset-0"
                  />
                  <span className="shrink-0 rounded bg-teal-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-teal-300">
                    Private
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-sm text-gray-300">{chat.subject}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        <p className="text-xs text-gray-600">
          {activeChatIds.filter((id) => groupIdSet.has(id)).length} of {groups.length} groups selected
          {' · '}
          {activeChatIds.filter((id) => !groupIdSet.has(id)).length} private number(s) in list
        </p>

        <div className="flex items-center justify-end gap-3">
          <button className="btn-primary" type="submit" disabled={saving || isLoading}>
            {saving ? <Spinner size="sm" className="mr-2" /> : null}
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </form>
    </div>
  );
}
