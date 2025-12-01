import { FormEvent, useEffect, useMemo, useState } from 'react';

type SystemSettings = {
  impressumUrl: string;
  privacyUrl: string;
  supportEmail: string;
  cacheVisibilityRadiusDefault: number;
  cacheFoundRadiusDefault: number;
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

type Cache = {
  id: string;
  latitude: number;
  longitude: number;
  clue: string;
  solution: string;
  createdAt: string;
};

type Invitation = {
  id: string;
  token: string;
  deliveryMethod: 'LINK' | 'EMAIL';
  email?: string | null;
  createdAt: string;
  usedAt?: string | null;
  isActive: boolean;
  deactivatedAt?: string | null;
};

type Event = {
  id: string;
  name: string;
  description?: string | null;
  startsAt: string;
  endsAt: string;
  visibleRadiusMeters: number;
  foundRadiusMeters: number;
  startPoint?: string | null;
  endPoint?: string | null;
  invitationEmailSubject?: string | null;
  invitationEmailBody?: string | null;
  senderEmail?: string | null;
  senderName?: string | null;
  caches: Cache[];
  invitations: Invitation[];
};

type EventPayload = {
  id?: string;
  name: string;
  description: string;
  startsAt: string;
  endsAt: string;
  visibleRadiusMeters: number;
  foundRadiusMeters: number;
  startPoint: string;
  endPoint: string;
  invitationEmailSubject: string;
  invitationEmailBody: string;
  senderEmail: string;
  senderName: string;
};

type CachePayload = {
  id?: string;
  latitude: number;
  longitude: number;
  clue: string;
  solution: string;
};

type EmailLog = {
  id: string;
  recipient: string;
  subject: string;
  status: 'SENT' | 'FAILED' | 'DISABLED' | 'RATE_LIMITED';
  errorMessage?: string | null;
  createdAt: string;
};

type Dashboard = {
  event: {
    id: string;
    name: string;
    startsAt: string;
    endsAt: string;
    archived: boolean;
    archivedAt: string | null;
  };
  caches: Array<{
    id: string;
    clue: string;
    latitude: number;
    longitude: number;
    found: boolean;
    foundAt: string | null;
  }>;
  playerCount: number;
  activePlayerCount: number;
  foundCount: number;
  completionPercent: number;
};

type SystemStatus = {
  database: 'ok' | 'error';
  migrationsUpToDate: boolean;
  emailSendingEnabled: boolean;
  version: string;
};

const useRoute = () => {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const handler = () => setPath(window.location.pathname);
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);

  const navigate = (to: string) => {
    window.history.pushState({}, '', to);
    setPath(to);
  };

  return { path, navigate };
};

const useToken = () => {
  const [token, setTokenState] = useState<string | null>(() =>
    localStorage.getItem('adminToken')
  );

  const setToken = (value: string | null) => {
    if (value) {
      localStorage.setItem('adminToken', value);
    } else {
      localStorage.removeItem('adminToken');
    }
    setTokenState(value);
  };

  return { token, setToken } as const;
};

const usePlayerIdentity = (eventId: string) => {
  const storageKey = `player:${eventId}`;
  const [playerId, setPlayerId] = useState<string | null>(() =>
    localStorage.getItem(storageKey)
  );

  const remember = (value: string) => {
    localStorage.setItem(storageKey, value);
    setPlayerId(value);
  };

  const reset = () => {
    localStorage.removeItem(storageKey);
    setPlayerId(null);
  };

  return { playerId, remember, reset } as const;
};

const haversineDistanceMeters = (
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
) => {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
};

const defaultInvitationSubject = 'Einladung: {{eventName}}';
const defaultInvitationBody =
  'Du wurdest zu {{eventName}} eingeladen.\n\nEventstart: {{eventStart}}\nEventende: {{eventEnd}}\n\nEinladungslink: {{inviteLink}}';

const AdminApp = ({ navigate }: { navigate: (path: string) => void }) => {
  const { token, setToken } = useToken();
  const [password, setPassword] = useState('');
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [emailSendingEnabled, setEmailSendingEnabled] = useState(false);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [activeAdminTab, setActiveAdminTab] = useState<'events' | 'settings' | 'status'>(
    'events'
  );
  const [events, setEvents] = useState<Event[]>([]);
  const [eventForm, setEventForm] = useState<EventPayload>({
    name: '',
    description: '',
    startsAt: '',
    endsAt: '',
    visibleRadiusMeters: 1000,
    foundRadiusMeters: 50,
    startPoint: '',
    endPoint: '',
    invitationEmailSubject: defaultInvitationSubject,
    invitationEmailBody: defaultInvitationBody,
    senderEmail: '',
    senderName: ''
  });
  const [editingEventId, setEditingEventId] = useState<string | null>(null);
  const [cacheDraft, setCacheDraft] = useState<CachePayload>({
    latitude: 0,
    longitude: 0,
    clue: '',
    solution: ''
  });
  const [targetEventId, setTargetEventId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [invitationDrafts, setInvitationDrafts] = useState<
    Record<string, { deliveryMethod: 'LINK' | 'EMAIL'; email: string }>
  >({});
  const [emailLogs, setEmailLogs] = useState<Record<string, EmailLog[]>>({});
  const [dashboards, setDashboards] = useState<Record<string, Dashboard>>({});
  const [loadingDashboard, setLoadingDashboard] = useState<string | null>(null);

  const authHeaders = useMemo(() => {
    if (!token) return {};
    return { Authorization: `Bearer ${token}` };
  }, [token]);

  const login = async (e: FormEvent) => {
    e.preventDefault();
    setMessage('');
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    if (res.ok) {
      const data = (await res.json()) as { token: string };
      setToken(data.token);
      setPassword('');
    } else {
      setMessage('Login fehlgeschlagen.');
    }
  };

  const loadSettings = async () => {
    if (!token) return;
    const res = await fetch('/api/admin/settings', { headers: authHeaders });
    if (res.ok) {
      const data = (await res.json()) as { settings: SystemSettings; emailSendingEnabled?: boolean };
      setSettings(data.settings);
      setEmailSendingEnabled(Boolean(data.emailSendingEnabled));
    }
  };

  const loadSystemStatus = async () => {
    if (!token) return;
    const res = await fetch('/api/admin/system-status', { headers: authHeaders });
    if (res.ok) {
      const data = (await res.json()) as SystemStatus;
      setSystemStatus(data);
      setEmailSendingEnabled(Boolean(data.emailSendingEnabled));
    }
  };

  const loadEvents = async () => {
    if (!token) return;
    const res = await fetch('/api/admin/events', { headers: authHeaders });
    if (res.ok) {
      const data = (await res.json()) as { events: Event[] };
      setEvents(data.events);
    }
  };

  useEffect(() => {
    void loadSettings();
    void loadEvents();
    void loadSystemStatus();
  }, [token]);

  const updateSettings = async (e: FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    const res = await fetch('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ settings })
    });
    if (res.ok) {
      const data = (await res.json()) as { settings: SystemSettings; emailSendingEnabled?: boolean };
      setSettings(data.settings);
      setEmailSendingEnabled(Boolean(data.emailSendingEnabled));
      setMessage('Einstellungen gespeichert.');
    }
  };

  const resetEventForm = () => {
    setEventForm({
      name: '',
      description: '',
      startsAt: '',
      endsAt: '',
      visibleRadiusMeters: settings?.cacheVisibilityRadiusDefault ?? 1000,
      foundRadiusMeters: settings?.cacheFoundRadiusDefault ?? 50,
      startPoint: '',
      endPoint: '',
      invitationEmailSubject: defaultInvitationSubject,
      invitationEmailBody: defaultInvitationBody,
      senderEmail: '',
      senderName: ''
    });
    setEditingEventId(null);
  };

  const saveEvent = async (e: FormEvent) => {
    e.preventDefault();
    setMessage('');
    const payload = { ...eventForm };
    const url = editingEventId
      ? `/api/admin/events/${editingEventId}`
      : '/api/admin/events';
    const method = editingEventId ? 'PUT' : 'POST';
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({ message: 'Fehler' }))) as {
        message?: string;
      };
      setMessage(data.message || 'Event konnte nicht gespeichert werden.');
      return;
    }
    await loadEvents();
    resetEventForm();
    setMessage('Event gespeichert.');
  };

  const editEvent = (event: Event) => {
    setEditingEventId(event.id);
    setEventForm({
      id: event.id,
      name: event.name,
      description: event.description || '',
      startsAt: event.startsAt.slice(0, 16),
      endsAt: event.endsAt.slice(0, 16),
      visibleRadiusMeters: event.visibleRadiusMeters,
      foundRadiusMeters: event.foundRadiusMeters,
      startPoint: event.startPoint || '',
      endPoint: event.endPoint || '',
      invitationEmailSubject: event.invitationEmailSubject || defaultInvitationSubject,
      invitationEmailBody: event.invitationEmailBody || defaultInvitationBody,
      senderEmail: event.senderEmail || '',
      senderName: event.senderName || ''
    });
  };

  const deleteEvent = async (eventId: string) => {
    if (!confirm('Event wirklich löschen?')) return;
    await fetch(`/api/admin/events/${eventId}`, {
      method: 'DELETE',
      headers: authHeaders
    });
    await loadEvents();
    if (editingEventId === eventId) resetEventForm();
  };

  const archiveEvent = async (eventId: string) => {
    if (!confirm('Event archivieren? Archivierte Events sind nicht öffentlich sichtbar.')) return;
    const res = await fetch(`/api/admin/events/${eventId}/archive`, {
      method: 'POST',
      headers: authHeaders
    });
    if (res.ok) {
      setMessage('Event archiviert.');
      await loadEvents();
    }
  };

  const loadDashboard = async (eventId: string) => {
    setLoadingDashboard(eventId);
    const res = await fetch(`/api/admin/events/${eventId}/dashboard`, { headers: authHeaders });
    setLoadingDashboard(null);
    if (res.ok) {
      const data = (await res.json()) as { dashboard: Dashboard };
      setDashboards((prev) => ({ ...prev, [eventId]: data.dashboard }));
    }
  };

  const exportEventData = async (eventId: string) => {
    const res = await fetch(`/api/admin/events/${eventId}/export`, { headers: authHeaders });
    if (!res.ok) {
      setMessage('Export fehlgeschlagen.');
      return;
    }
    const data = (await res.json()) as { export: unknown };
    const blob = new Blob([JSON.stringify(data.export, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `event-${eventId}-export.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setMessage('Export erstellt (JSON heruntergeladen).');
  };

  const saveCache = async (eventId: string, cache?: CachePayload) => {
    if (!cache) return;
    const isUpdate = Boolean(cache.id);
    const url = isUpdate
      ? `/api/admin/events/${eventId}/caches/${cache.id}`
      : `/api/admin/events/${eventId}/caches`;
    const method = isUpdate ? 'PUT' : 'POST';
    await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify(cache)
    });
    await loadEvents();
    setTargetEventId(null);
    setCacheDraft({ latitude: 0, longitude: 0, clue: '', solution: '' });
  };

  const deleteCache = async (eventId: string, cacheId: string) => {
    await fetch(`/api/admin/events/${eventId}/caches/${cacheId}`, {
      method: 'DELETE',
      headers: authHeaders
    });
    await loadEvents();
  };

  const updateInvitationDraft = (
    eventId: string,
    draft: Partial<{ deliveryMethod: 'LINK' | 'EMAIL'; email: string }>
  ) => {
    setInvitationDrafts((prev) => {
      const current = prev[eventId] ?? { deliveryMethod: 'LINK', email: '' };
      return { ...prev, [eventId]: { ...current, ...draft } };
    });
  };

  const createInvitation = async (eventId: string) => {
    const draft = invitationDrafts[eventId] ?? { deliveryMethod: 'LINK', email: '' };
    setMessage('');
    const res = await fetch(`/api/admin/events/${eventId}/invitations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({
        deliveryMethod: draft.deliveryMethod,
        email: draft.deliveryMethod === 'EMAIL' ? draft.email : undefined
      })
    });
    const data = (await res.json().catch(() => ({ message: 'Fehler' }))) as {
      message?: string;
      link?: string;
    };
    if (!res.ok) {
      setMessage(data.message || 'Einladung konnte nicht erstellt werden.');
      return;
    }
    setMessage(data.link ? `Einladungslink: ${data.link}` : 'Einladung erstellt.');
    setInvitationDrafts((prev) => ({ ...prev, [eventId]: { deliveryMethod: 'LINK', email: '' } }));
    await loadEvents();
  };

  const toggleInvitation = async (eventId: string, invitationId: string, isActive: boolean) => {
    setMessage('');
    const res = await fetch(`/api/admin/events/${eventId}/invitations/${invitationId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ isActive })
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({ message: 'Fehler' }))) as { message?: string };
      setMessage(data.message || 'Einladung konnte nicht aktualisiert werden.');
      return;
    }
    await loadEvents();
  };

  const loadEmailLogsForEvent = async (eventId: string) => {
    const res = await fetch(`/api/admin/events/${eventId}/email-logs`, { headers: authHeaders });
    if (res.ok) {
      const data = (await res.json()) as { logs: EmailLog[] };
      setEmailLogs((prev) => ({ ...prev, [eventId]: data.logs }));
    }
  };

  if (!token) {
    return (
      <div className="container">
        <header className="header">
          <h1>GeoCachingEngine Admin</h1>
          <button className="secondary" onClick={() => navigate('/public')}>
            Öffentliche Ansicht
          </button>
        </header>
        <form onSubmit={login} className="card">
          <label>Admin-Passwort</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <button type="submit">Login</button>
        </form>
        {message && <p className="message">{message}</p>}
      </div>
    );
  }

  return (
    <div className="container">
      <header className="header">
        <h1>GeoCachingEngine Admin</h1>
        <div>
          <button className="secondary" onClick={() => navigate('/public')}>
            Öffentliche Ansicht
          </button>
          <button className="secondary" onClick={() => setToken(null)}>
            Logout
          </button>
        </div>
      </header>

      <nav className="admin-nav" aria-label="Admin Navigation">
        <button
          className={activeAdminTab === 'events' ? 'tab active' : 'tab'}
          onClick={() => setActiveAdminTab('events')}
          aria-current={activeAdminTab === 'events'}
        >
          Events
        </button>
        <button
          className={activeAdminTab === 'settings' ? 'tab active' : 'tab'}
          onClick={() => setActiveAdminTab('settings')}
          aria-current={activeAdminTab === 'settings'}
        >
          Einstellungen
        </button>
        <button
          className={activeAdminTab === 'status' ? 'tab active' : 'tab'}
          onClick={() => setActiveAdminTab('status')}
          aria-current={activeAdminTab === 'status'}
        >
          Systemstatus
        </button>
      </nav>

      {message && <p className="message">{message}</p>}

      {activeAdminTab === 'settings' && (
        <section className="card">
        <h2>Einstellungen</h2>
        {settings ? (
          <form onSubmit={updateSettings} className="grid">
            <label className="field">
              <span>Impressum URL</span>
              <input
                value={settings.impressumUrl}
                onChange={(e) => setSettings({ ...settings, impressumUrl: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Datenschutz URL</span>
              <input
                value={settings.privacyUrl}
                onChange={(e) => setSettings({ ...settings, privacyUrl: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Support E-Mail</span>
              <input
                value={settings.supportEmail}
                onChange={(e) => setSettings({ ...settings, supportEmail: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Sichtbarkeitsradius (Default, m)</span>
              <input
                type="number"
                value={settings.cacheVisibilityRadiusDefault}
                onChange={(e) =>
                  setSettings({ ...settings, cacheVisibilityRadiusDefault: Number(e.target.value) })
                }
              />
            </label>
            <label className="field">
              <span>Fundradius (Default, m)</span>
              <input
                type="number"
                value={settings.cacheFoundRadiusDefault}
                onChange={(e) =>
                  setSettings({ ...settings, cacheFoundRadiusDefault: Number(e.target.value) })
                }
              />
            </label>
            <label className="field">
              <span>E-Mail-Limit pro Stunde (Admin)</span>
              <input
                type="number"
                value={settings.maxEmailsPerHourPerAdmin ?? ''}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    maxEmailsPerHourPerAdmin:
                      e.target.value === '' ? undefined : Number(e.target.value)
                  })
                }
              />
            </label>
            <label className="field">
              <span>E-Mail-Limit pro Tag (Admin)</span>
              <input
                type="number"
                value={settings.maxEmailsPerDayPerAdmin ?? ''}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    maxEmailsPerDayPerAdmin:
                      e.target.value === '' ? undefined : Number(e.target.value)
                  })
                }
              />
            </label>
            <label className="field">
              <span>SMTP Host</span>
              <input
                value={settings.smtpHost || ''}
                onChange={(e) => setSettings({ ...settings, smtpHost: e.target.value })}
              />
            </label>
            <label className="field">
              <span>SMTP Port</span>
              <input
                type="number"
                value={settings.smtpPort ?? ''}
                onChange={(e) =>
                  setSettings({ ...settings, smtpPort: e.target.value === '' ? null : Number(e.target.value) })
                }
              />
            </label>
            <label className="field">
              <span>SMTP Benutzername</span>
              <input
                value={settings.smtpUser || ''}
                onChange={(e) => setSettings({ ...settings, smtpUser: e.target.value })}
              />
            </label>
            <label className="field">
              <span>SMTP Passwort</span>
              <input
                type="password"
                value={settings.smtpPassword || ''}
                onChange={(e) => setSettings({ ...settings, smtpPassword: e.target.value })}
              />
            </label>
            <label className="field">
              <span>SMTP TLS/STARTTLS</span>
              <input
                type="checkbox"
                checked={Boolean(settings.smtpUseTls)}
                onChange={(e) => setSettings({ ...settings, smtpUseTls: e.target.checked })}
              />
            </label>
            <label className="field">
              <span>Absender-Adresse</span>
              <input
                type="email"
                value={settings.smtpFromAddress || ''}
                onChange={(e) => setSettings({ ...settings, smtpFromAddress: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Absender-Name</span>
              <input
                value={settings.smtpFromName || ''}
                onChange={(e) => setSettings({ ...settings, smtpFromName: e.target.value })}
              />
            </label>
            <p className="muted full-row">
              E-Mail-Versand aktiviert: {emailSendingEnabled ? 'ja' : 'nein'} (SMTP-Daten im Formular pflegen)
            </p>
            <button type="submit" className="primary">
              Speichern
            </button>
          </form>
        ) : (
          <p className="muted">Lade Einstellungen...</p>
        )}
        </section>
      )}

      {activeAdminTab === 'events' && (
        <>
      <section className="card">
        <h2>{editingEventId ? 'Event bearbeiten' : 'Event anlegen'}</h2>
        <form onSubmit={saveEvent} className="grid">
          <label className="field">
            <span>Event-Name</span>
            <input
              value={eventForm.name}
              onChange={(e) => setEventForm({ ...eventForm, name: e.target.value })}
              required
            />
          </label>
          <label className="field">
            <span>Beschreibung</span>
            <input
              value={eventForm.description}
              onChange={(e) => setEventForm({ ...eventForm, description: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Startzeit</span>
            <input
              type="datetime-local"
              value={eventForm.startsAt}
              onChange={(e) => setEventForm({ ...eventForm, startsAt: e.target.value })}
              required
            />
          </label>
          <label className="field">
            <span>Endzeit</span>
            <input
              type="datetime-local"
              value={eventForm.endsAt}
              onChange={(e) => setEventForm({ ...eventForm, endsAt: e.target.value })}
              required
            />
          </label>
          <label className="field">
            <span>Sichtbarkeitsradius (m)</span>
            <input
              type="number"
              value={eventForm.visibleRadiusMeters}
              min={1}
              onChange={(e) => setEventForm({ ...eventForm, visibleRadiusMeters: Number(e.target.value) })}
              required
            />
          </label>
          <label className="field">
            <span>Fundradius (m)</span>
            <input
              type="number"
              value={eventForm.foundRadiusMeters}
              min={1}
              onChange={(e) => setEventForm({ ...eventForm, foundRadiusMeters: Number(e.target.value) })}
              required
            />
          </label>
          <label className="field">
            <span>Startpunkt</span>
            <input
              value={eventForm.startPoint}
              onChange={(e) => setEventForm({ ...eventForm, startPoint: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Endpunkt</span>
            <input
              value={eventForm.endPoint}
              onChange={(e) => setEventForm({ ...eventForm, endPoint: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Absender-E-Mail (optional)</span>
            <input
              type="email"
              value={eventForm.senderEmail}
              onChange={(e) => setEventForm({ ...eventForm, senderEmail: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Absender-Name (optional)</span>
            <input
              value={eventForm.senderName}
              onChange={(e) => setEventForm({ ...eventForm, senderName: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Betreff (E-Mail-Einladung)</span>
            <input
              value={eventForm.invitationEmailSubject}
              onChange={(e) =>
                setEventForm({ ...eventForm, invitationEmailSubject: e.target.value })
              }
            />
          </label>
          <label className="field full-row">
            <span>Text (E-Mail-Einladung)</span>
            <textarea
              value={eventForm.invitationEmailBody}
              onChange={(e) => setEventForm({ ...eventForm, invitationEmailBody: e.target.value })}
              rows={4}
            />
            <div className="muted" style={{ fontSize: '0.85rem' }}>
              Platzhalter: {{'{{'}}eventName{{'}}'}}, {{'{{'}}eventDescription{{'}}'}}, {{'{{'}}eventStart{{'}}'}},
              {{'{{'}}eventEnd{{'}}'}}, {{'{{'}}inviteLink{{'}}'}}. Der Link-Platzhalter sollte enthalten sein.
            </div>
            <div style={{ marginTop: '0.5rem' }}>
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  setEventForm({
                    ...eventForm,
                    invitationEmailSubject: defaultInvitationSubject,
                    invitationEmailBody: defaultInvitationBody
                  })
                }
              >
                Standardvorlage verwenden
              </button>
            </div>
          </label>
          <div className="field full-row" style={{ display: 'flex', gap: '0.5rem' }}>
            <button type="submit" className="primary">
              Speichern
            </button>
            {editingEventId && (
              <button type="button" className="secondary" onClick={resetEventForm}>
                Neu anlegen
              </button>
            )}
          </div>
        </form>
      </section>

      <section className="card">
        <h2>Events</h2>
        {events.length === 0 && <p className="muted">Keine Events angelegt.</p>}
        <div className="event-list">
          {events.map((event) => (
            <div key={event.id} className="event-row">
              <div className="event-meta">
                <div>
                  <div className="event-title-row">
                    <strong>{event.name}</strong>
                    {event.archived && <span className="chip muted">Archiviert</span>}
                  </div>
                  <p className="muted">
                    {new Date(event.startsAt).toLocaleString()} → {new Date(event.endsAt).toLocaleString()}
                  </p>
                  <p className="muted">
                    Radius Sichtbar: {event.visibleRadiusMeters}m · Fund: {event.foundRadiusMeters}m
                  </p>
                  {event.description && <p className="muted">{event.description}</p>}
                </div>
                <div className="event-actions">
                  <span className="cache-summary">Caches: {event.caches?.length ?? 0}</span>
                  <button className="secondary" onClick={() => editEvent(event)}>
                    Bearbeiten
                  </button>
                  <button className="secondary" onClick={() => archiveEvent(event.id)}>
                    Archivieren
                  </button>
                  <button className="secondary" onClick={() => exportEventData(event.id)}>
                    Exportieren
                  </button>
                  <button className="secondary" onClick={() => deleteEvent(event.id)}>
                    Löschen
                  </button>
                  <button className="secondary" onClick={() => void loadDashboard(event.id)}>
                    Live-Status
                  </button>
                </div>
              </div>
              {loadingDashboard === event.id && <p className="muted">Status wird geladen...</p>}
              {dashboards[event.id] && (
                <div className="status-card">
                  <div className="status-header">
                    <h4>Live-Status</h4>
                    <span className="muted">
                      Fortschritt: {dashboards[event.id].completionPercent}% · Aktive Spieler:{' '}
                      {dashboards[event.id].activePlayerCount}
                    </span>
                  </div>
                  <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={dashboards[event.id].completionPercent}>
                    <div
                      className="progress-bar"
                      style={{ width: `${dashboards[event.id].completionPercent}%` }}
                    />
                  </div>
                  <div className="status-grid">
                    <div className="metric">
                      <span className="muted">Caches gesamt</span>
                      <strong>{dashboards[event.id].caches.length}</strong>
                    </div>
                    <div className="metric">
                      <span className="muted">Gefundene Caches</span>
                      <strong>{dashboards[event.id].foundCount}</strong>
                    </div>
                    <div className="metric">
                      <span className="muted">Spieler</span>
                      <strong>{dashboards[event.id].playerCount}</strong>
                    </div>
                  </div>
                  <div className="cache-list" aria-label="Cache Status">
                    {dashboards[event.id].caches.map((cache) => (
                      <div key={cache.id} className="cache-row">
                        <div>
                          <strong>Hinweis:</strong> {cache.clue}
                          <p className="muted">
                            {cache.latitude}, {cache.longitude}
                          </p>
                        </div>
                        <div className="muted">
                          {cache.found ? 'Gefunden' : 'Offen'}{' '}
                          {cache.foundAt ? `seit ${new Date(cache.foundAt).toLocaleString()}` : ''}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="invitation-block">
                <h4>Einladungen</h4>
                <div className="field" style={{ alignItems: 'flex-start', gap: '0.5rem' }}>
                  <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                    <label>
                      <input
                        type="radio"
                        name={`invitation-${event.id}`}
                        checked={(invitationDrafts[event.id]?.deliveryMethod || 'LINK') === 'LINK'}
                        onChange={() => updateInvitationDraft(event.id, { deliveryMethod: 'LINK' })}
                      />{' '}
                      Link
                    </label>
                    <label title={emailSendingEnabled ? '' : 'SMTP-Postfach erforderlich'}>
                      <input
                        type="radio"
                        name={`invitation-${event.id}`}
                        checked={(invitationDrafts[event.id]?.deliveryMethod || 'LINK') === 'EMAIL'}
                        onChange={() => updateInvitationDraft(event.id, { deliveryMethod: 'EMAIL' })}
                        disabled={!emailSendingEnabled}
                      />{' '}
                      E-Mail
                    </label>
                    {!emailSendingEnabled && (
                      <span className="muted">E-Mail-Versand nur mit SMTP-Postfach aktiv.</span>
                    )}
                  </div>
                  {(invitationDrafts[event.id]?.deliveryMethod || 'LINK') === 'EMAIL' && (
                    <input
                      type="email"
                      placeholder="E-Mail-Adresse"
                      value={invitationDrafts[event.id]?.email || ''}
                      onChange={(e) =>
                        updateInvitationDraft(event.id, { email: e.target.value, deliveryMethod: 'EMAIL' })
                      }
                      required
                    />
                  )}
                  <button className="secondary" onClick={() => void createInvitation(event.id)}>
                    Einladung erstellen
                  </button>
                </div>
                <div className="cache-list" style={{ marginTop: '0.5rem' }}>
                  {event.invitations.length === 0 && <p className="muted">Keine Einladungen.</p>}
                  {event.invitations.map((invitation) => {
                    const base = window.location.origin;
                    const link = `${base}/join/${invitation.token}`;
                    return (
                      <div key={invitation.id} className="cache-row" style={{ alignItems: 'flex-start' }}>
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <span>{invitation.deliveryMethod === 'EMAIL' ? 'E-Mail' : 'Link'}</span>
                          {invitation.email && <span className="muted">{invitation.email}</span>}
                          <span className="muted">{new Date(invitation.createdAt).toLocaleString()}</span>
                          <span className="muted">
                            Status: {invitation.isActive ? 'aktiv' : 'deaktiviert'}
                            {!invitation.isActive && invitation.deactivatedAt
                              ? ` seit ${new Date(invitation.deactivatedAt).toLocaleString()}`
                              : ''}
                          </span>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                          <span className="muted" style={{ wordBreak: 'break-all' }}>
                            {link}
                          </span>
                          {invitation.usedAt && (
                            <span className="muted">Benutzt: {new Date(invitation.usedAt).toLocaleString()}</span>
                          )}
                          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                            <button
                              className="secondary"
                              onClick={() => void toggleInvitation(event.id, invitation.id, !invitation.isActive)}
                            >
                              {invitation.isActive ? 'Deaktivieren' : 'Aktivieren'}
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div style={{ marginTop: '0.5rem' }}>
                  <button className="secondary" onClick={() => void loadEmailLogsForEvent(event.id)}>
                    E-Mail-Log laden
                  </button>
                  {emailLogs[event.id] && emailLogs[event.id].length === 0 && (
                    <p className="muted" style={{ marginTop: '0.25rem' }}>
                      Keine Einträge vorhanden.
                    </p>
                  )}
                  {emailLogs[event.id] && emailLogs[event.id].length > 0 && (
                    <div className="cache-list" style={{ marginTop: '0.5rem' }}>
                      {emailLogs[event.id]?.map((log) => (
                        <div key={log.id} className="cache-row" style={{ alignItems: 'flex-start' }}>
                          <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <strong>{log.status}</strong>
                            <span className="muted">{new Date(log.createdAt).toLocaleString()}</span>
                            <span className="muted">{log.recipient}</span>
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                            <span>{log.subject}</span>
                            {log.errorMessage && <span className="muted">{log.errorMessage}</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>Caches</h2>
        <p className="muted">Caches sind immer einem Event zugeordnet.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!targetEventId) return;
            void saveCache(targetEventId, cacheDraft);
          }}
          className="grid"
        >
          <label className="field">
            <span>Event</span>
            <select
              value={targetEventId ?? ''}
              onChange={(e) => setTargetEventId(e.target.value || null)}
            >
              <option value="">Event auswählen</option>
              {events.map((event) => (
                <option key={event.id} value={event.id}>
                  {event.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Breite</span>
            <input
              type="number"
              value={cacheDraft.latitude}
              onChange={(e) => setCacheDraft({ ...cacheDraft, latitude: Number(e.target.value) })}
              required
            />
          </label>
          <label className="field">
            <span>Länge</span>
            <input
              type="number"
              value={cacheDraft.longitude}
              onChange={(e) => setCacheDraft({ ...cacheDraft, longitude: Number(e.target.value) })}
              required
            />
          </label>
          <label className="field">
            <span>Hinweis</span>
            <input
              value={cacheDraft.clue}
              onChange={(e) => setCacheDraft({ ...cacheDraft, clue: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Lösung</span>
            <input
              value={cacheDraft.solution}
              onChange={(e) => setCacheDraft({ ...cacheDraft, solution: e.target.value })}
            />
          </label>
          <button type="submit" className="primary">
            Cache speichern
          </button>
        </form>

        <div className="cache-list full-row">
          {events.map((event) => (
            <div key={event.id} className="card" style={{ padding: '0.75rem', marginBottom: '0.5rem' }}>
              <div className="field-header">
                <strong>{event.name}</strong>
                <button className="secondary" onClick={() => setTargetEventId(event.id)}>
                  Cache zuweisen
                </button>
              </div>
              {event.caches.length === 0 && <p className="muted">Keine Caches</p>}
              {event.caches.map((cache) => (
                <div key={cache.id} className="cache-row">
                  <span>Lat: {cache.latitude}</span>
                  <span>Lon: {cache.longitude}</span>
                  <span>Hinweis: {cache.clue}</span>
                  <span>Lösung: {cache.solution}</span>
                  <button
                    className="secondary"
                    onClick={() => {
                      setTargetEventId(event.id);
                      setCacheDraft({
                        id: cache.id,
                        latitude: cache.latitude,
                        longitude: cache.longitude,
                        clue: cache.clue,
                        solution: cache.solution
                      });
                    }}
                  >
                    Bearbeiten
                  </button>
                  <button className="secondary" onClick={() => deleteCache(event.id, cache.id)}>
                    Löschen
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>
        </>
      )}

      {activeAdminTab === 'status' && (
        <section className="card">
          <h2>Systemstatus</h2>
          {systemStatus ? (
            <div className="status-grid">
              <div className="metric">
                <span className="muted">Datenbank</span>
                <strong className={systemStatus.database === 'ok' ? 'text-success' : 'text-danger'}>
                  {systemStatus.database === 'ok' ? 'OK' : 'Fehler'}
                </strong>
              </div>
              <div className="metric">
                <span className="muted">Migrationen</span>
                <strong className={systemStatus.migrationsUpToDate ? 'text-success' : 'text-danger'}>
                  {systemStatus.migrationsUpToDate ? 'Aktuell' : 'Ausstehend'}
                </strong>
              </div>
              <div className="metric">
                <span className="muted">E-Mail-Versand</span>
                <strong className={systemStatus.emailSendingEnabled ? 'text-success' : 'text-danger'}>
                  {systemStatus.emailSendingEnabled ? 'Aktiv' : 'Deaktiviert'}
                </strong>
              </div>
              <div className="metric">
                <span className="muted">Version</span>
                <strong>{systemStatus.version}</strong>
              </div>
            </div>
          ) : (
            <p className="muted">Status wird geladen...</p>
          )}
          <button className="secondary" onClick={() => void loadSystemStatus()}>
            Status neu laden
          </button>
        </section>
      )}
    </div>
  );
};

const PublicIndex = ({ navigate }: { navigate: (path: string) => void }) => {
  const [events, setEvents] = useState<Event[]>([]);

  useEffect(() => {
    const load = async () => {
      const res = await fetch('/api/public/events');
      if (res.ok) {
        const data = (await res.json()) as { events: Event[] };
        setEvents(data.events);
      }
    };
    void load();
  }, []);

  return (
    <div className="container">
      <header className="header">
        <h1>GeoCachingEngine Events</h1>
        <button className="secondary" onClick={() => navigate('/admin')}>
          Admin
        </button>
      </header>
      <section className="card">
        <h2>Aktive Events</h2>
        {events.length === 0 && <p className="muted">Keine aktiven Events.</p>}
        <div className="event-list">
          {events.map((event) => (
            <div key={event.id} className="event-row">
              <div>
                <strong>{event.name}</strong>
                <p className="muted">
                  {new Date(event.startsAt).toLocaleString()} → {new Date(event.endsAt).toLocaleString()}
                </p>
                {event.description && <p className="muted">{event.description}</p>}
              </div>
              <button onClick={() => navigate(`/public/event/${event.id}`)}>Details</button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};

const useFoundState = (eventId: string) => {
  const key = `found:${eventId}`;
  const [found, setFound] = useState<string[]>(() => {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : [];
  });

  const update = (ids: string[]) => {
    setFound(ids);
    localStorage.setItem(key, JSON.stringify(ids));
  };

  return { found, update } as const;
};

const PublicEventPage = ({ eventId, navigate }: { eventId: string; navigate: (path: string) => void }) => {
  const [event, setEvent] = useState<Event | null>(null);
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [error, setError] = useState('');
  const [nickname, setNickname] = useState('');
  const [registering, setRegistering] = useState(false);
  const { found, update } = useFoundState(eventId);
  const { playerId, remember: rememberPlayer } = usePlayerIdentity(eventId);

  useEffect(() => {
    const load = async () => {
      const res = await fetch(`/api/public/events/${eventId}`);
      if (res.ok) {
        const data = (await res.json()) as { event: Event };
        setEvent(data.event);
      }
    };
    void load();
  }, [eventId]);

  const requestPosition = () => {
    if (!navigator.geolocation) {
      setError('Geolocation nicht verfügbar.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        setError('');
      },
      () => setError('Position konnte nicht ermittelt werden.'),
      { enableHighAccuracy: true }
    );
  };

  const registerPlayer = async () => {
    setRegistering(true);
    const res = await fetch(`/api/public/events/${eventId}/players`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: nickname || undefined, playerId: playerId || undefined })
    });
    setRegistering(false);
    if (res.ok) {
      const data = (await res.json()) as { playerId: string };
      rememberPlayer(data.playerId);
      return data.playerId;
    }
    return null;
  };

  useEffect(() => {
    if (event && !playerId) {
      void registerPlayer();
    }
  }, [event, playerId]);

  const markFound = async (cacheId: string) => {
    let id = playerId;
    if (!id) {
      id = await registerPlayer();
    }
    if (!id) {
      setError('Spieler konnte nicht registriert werden.');
      return;
    }
    const res = await fetch(`/api/events/${eventId}/caches/${cacheId}/found`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: id, nickname: nickname || undefined })
    });
    if (!res.ok) {
      setError('Fund konnte nicht gespeichert werden.');
      return;
    }
    const data = (await res.json()) as { playerId: string };
    rememberPlayer(data.playerId);
    if (!found.includes(cacheId)) {
      update([...found, cacheId]);
    }
  };

  const visibleCaches = useMemo(() => {
    if (!event) return [] as Array<{ cache: Cache; distance: number; canFind: boolean }>;
    if (!coords) return event.caches.map((cache) => ({ cache, distance: Infinity, canFind: false }));
    return event.caches.map((cache) => {
      const distance = haversineDistanceMeters(coords.lat, coords.lon, cache.latitude, cache.longitude);
      const visible = distance <= event.visibleRadiusMeters;
      const canFind = distance <= event.foundRadiusMeters;
      return { cache, distance: visible ? distance : Infinity, canFind };
    });
  }, [coords, event]);

  if (!event) {
    return (
      <div className="container">
        <header className="header">
          <h1>GeoCachingEngine Events</h1>
          <button className="secondary" onClick={() => navigate('/public')}>
            Zurück
          </button>
        </header>
        <p className="muted">Event wird geladen...</p>
      </div>
    );
  }

  return (
    <div className="container">
      <header className="header">
        <h1>{event.name}</h1>
        <button className="secondary" onClick={() => navigate('/public')}>
          Zurück zur Übersicht
        </button>
      </header>

      <section className="card">
        <p className="muted">
          {new Date(event.startsAt).toLocaleString()} → {new Date(event.endsAt).toLocaleString()} · Sichtbar bis {event.visibleRadiusMeters}m
        </p>
        {event.description && <p>{event.description}</p>}
        <div className="field" style={{ gap: '0.35rem', marginBottom: '0.5rem' }}>
          <label className="field">
            <span>Pseudonym (optional)</span>
            <input
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="Name, der bei Funden angezeigt wird"
            />
          </label>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="secondary" onClick={() => void registerPlayer()} disabled={registering}>
              {registering ? 'Registriere...' : 'Pseudonym speichern'}
            </button>
            {playerId && <span className="muted">Spieler-ID: {playerId}</span>}
          </div>
        </div>
        <div className="field" style={{ gap: '0.5rem' }}>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button onClick={requestPosition}>Aktuelle Position verwenden</button>
            <button className="secondary" onClick={() => setCoords(null)}>
              Position zurücksetzen
            </button>
          </div>
          <div className="cache-row">
            <label className="field">
              <span>Latitude</span>
              <input
                type="number"
                value={coords?.lat ?? ''}
                onChange={(e) =>
                  setCoords({ lat: Number(e.target.value), lon: coords?.lon ?? 0 })
                }
              />
            </label>
            <label className="field">
              <span>Longitude</span>
              <input
                type="number"
                value={coords?.lon ?? ''}
                onChange={(e) =>
                  setCoords({ lat: coords?.lat ?? 0, lon: Number(e.target.value) })
                }
              />
            </label>
          </div>
          {error && <p className="message">{error}</p>}
        </div>
      </section>

      <section className="card">
        <h2>Caches</h2>
        {coords ? (
          <p className="muted">Berechnet Abstände basierend auf Ihrer Position.</p>
        ) : (
          <p className="muted">Position setzen, um Reichweiten zu sehen.</p>
        )}
        <div className="cache-list">
          {visibleCaches
            .filter(({ distance }) => distance !== Infinity)
            .sort((a, b) => a.distance - b.distance)
            .map(({ cache, distance, canFind }) => (
              <div key={cache.id} className="event-row">
                <div>
                  <strong>Hinweis:</strong> {cache.clue}
                  <p className="muted">Distanz: {distance}m</p>
                  {found.includes(cache.id) && <p className="muted">Status: Gefunden</p>}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                  <button
                    className="secondary"
                    disabled={!canFind || found.includes(cache.id)}
                    onClick={() => markFound(cache.id)}
                  >
                    {found.includes(cache.id) ? 'Bereits gefunden' : 'Als gefunden markieren'}
                  </button>
                  {found.includes(cache.id) && <span className="muted">Lösung: {cache.solution}</span>}
                </div>
              </div>
            ))}
          {visibleCaches.filter(({ distance }) => distance !== Infinity).length === 0 && (
            <p className="muted">Keine Caches in Reichweite.</p>
          )}
        </div>
      </section>
    </div>
  );
};

const App = () => {
  const { path, navigate } = useRoute();

  if (path.startsWith('/public/event/')) {
    const eventId = path.split('/public/event/')[1];
    return <PublicEventPage eventId={eventId} navigate={navigate} />;
  }

  if (path.startsWith('/public')) {
    return <PublicIndex navigate={navigate} />;
  }

  return <AdminApp navigate={navigate} />;
};

export default App;
