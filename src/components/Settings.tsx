import { useCallback, useEffect, useState } from 'react';
import { api, downloadJson } from '../api';
import type { FormField } from '../types';
import { FieldBuilder } from './FieldForm';
import {
  Card,
  ErrorBanner,
  GhostButton,
  PrimaryButton,
  SecondaryButton,
  SectionTitle,
  ThemeToggle,
  inputClass,
  labelClass,
} from './ui';

interface IntakeForm {
  id: string;
  whop_product_id: string;
  title: string;
  fields: FormField[];
  consent_text: string;
  version: number;
  is_active: boolean;
}
interface CheckinTemplate {
  id: string;
  whop_product_id?: string;
  cadence: string;
  questions: FormField[];
  is_active: boolean;
}

export default function Settings() {
  const [settings, setSettings] = useState<any>(null);
  const [forms, setForms] = useState<IntakeForm[]>([]);
  const [templates, setTemplates] = useState<CheckinTemplate[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([
      api.get<{ settings: any }>('/api/coach/settings'),
      api.get<{ intake_forms: IntakeForm[] }>('/api/coach/intake-forms'),
      api.get<{ checkin_templates: CheckinTemplate[] }>('/api/coach/checkin-templates'),
    ])
      .then(([s, f, t]) => {
        setSettings(s.settings);
        setForms(f.intake_forms);
        setTemplates(t.checkin_templates);
      })
      .catch((e) => setError(e.message || 'Could not load settings.'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const flash = (msg: string) => {
    setNotice(msg);
    setError(null);
    load();
  };

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-[22px] font-semibold">Settings</h1>
      {notice && <div className="rounded-[10px] border-l-[3px] border-success bg-success/10 px-3 py-2 text-sm">{notice}</div>}
      {error && <ErrorBanner message={error} />}

      <Card>
        <SectionTitle>Appearance</SectionTitle>
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-secondary">
            CoachDesk is dark by design. Switch to light if you prefer it — the choice is saved on this device.
          </p>
          <ThemeToggle />
        </div>
      </Card>

      {settings && (
        <Card>
          <SectionTitle>Your practice</SectionTitle>
          <div className="flex flex-col gap-3">
            <div>
              <label className={labelClass} htmlFor="set-name">Display name</label>
              <input
                id="set-name"
                className={inputClass}
                defaultValue={settings.display_name}
                onBlur={async (e) => {
                  if (e.target.value.trim() && e.target.value !== settings.display_name) {
                    await api.patch('/api/coach/settings', { display_name: e.target.value });
                    flash('Saved.');
                  }
                }}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="set-tz">Timezone</label>
              <input
                id="set-tz"
                className={inputClass}
                defaultValue={settings.timezone}
                onBlur={async (e) => {
                  if (e.target.value.trim() && e.target.value !== settings.timezone) {
                    await api.patch('/api/coach/settings', { timezone: e.target.value });
                    flash('Saved.');
                  }
                }}
              />
              <p className="mt-1 text-[13px] text-muted">Used for program weeks and check-in timing. Example: America/Chicago.</p>
            </div>
          </div>
        </Card>
      )}

      <IntakeFormsSection forms={forms} onSaved={() => flash('Intake form saved.')} onError={setError} />
      <CheckinTemplatesSection templates={templates} onSaved={() => flash('Check-in template saved.')} onError={setError} />

      {settings && (
        <Card>
          <SectionTitle>Retention &amp; data</SectionTitle>
          <div className="flex flex-col gap-3">
            <div>
              <label className={labelClass} htmlFor="set-retention">Keep archived records for</label>
              <select
                id="set-retention"
                className="w-full rounded-[10px] border border-strong bg-raised px-3 py-2.5 text-sm"
                defaultValue={settings.archived_retention_months}
                onChange={async (e) => {
                  await api.patch('/api/coach/settings', { archived_retention_months: Number(e.target.value) });
                  flash('Retention updated.');
                }}
              >
                {[3, 6, 12, 24].map((m) => (
                  <option key={m} value={m}>
                    {m} months
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[13px] text-muted">
                When a membership ends, the record archives instead of deleting — returning clients pick up their
                history. Deletion is always available per record.
              </p>
            </div>
            <div>
              <label className={labelClass} htmlFor="set-stale">Stale-goal reminder after (days without a progress update)</label>
              <input
                id="set-stale"
                type="number"
                min={1}
                max={90}
                className={inputClass}
                defaultValue={settings.goal_stale_days}
                onBlur={async (e) => {
                  const v = Number(e.target.value);
                  if (v >= 1 && v <= 90 && v !== settings.goal_stale_days) {
                    await api.patch('/api/coach/settings', { goal_stale_days: v });
                    flash('Saved.');
                  }
                }}
              />
            </div>
            <SecondaryButton
              onClick={() =>
                downloadJson('/api/coach/export', 'coachdesk-whole-book.json').catch(() => setError('Export failed. Try again.'))
              }
            >
              Export whole book (JSON)
            </SecondaryButton>
            <p className="text-[13px] text-muted">Exports are written to the audit log.</p>
            <SecondaryButton
              onClick={async () => {
                const r = await api.post<{ support_access_until: string }>('/api/coach/settings/support-access');
                flash(`Support access open until ${new Date(r.support_access_until).toLocaleString()}. Elite can only use it inside this window, and every access is audit-logged.`);
              }}
            >
              Grant Elite support access (24h)
            </SecondaryButton>
            {settings.support_access_until && (
              <p className="text-[13px] text-muted">Current support window ends {new Date(settings.support_access_until).toLocaleString()}.</p>
            )}
          </div>
        </Card>
      )}

      <DangerZone onError={setError} />
    </div>
  );
}

function IntakeFormsSection({
  forms,
  onSaved,
  onError,
}: {
  forms: IntakeForm[];
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [editing, setEditing] = useState<IntakeForm | 'new' | null>(null);
  const [productId, setProductId] = useState('');
  const [title, setTitle] = useState('');
  const [fields, setFields] = useState<FormField[]>([]);
  const [consent, setConsent] = useState('');
  const [saving, setSaving] = useState(false);

  const startNew = async () => {
    setEditing('new');
    setProductId('');
    setTitle('');
    setFields([{ id: `field_${Date.now()}`, label: 'What is your main goal right now?', type: 'long_text', required: true }]);
    try {
      const r = await api.get<{ consent_text: string }>('/api/coach/consent-template');
      setConsent(r.consent_text);
    } catch {
      setConsent('');
    }
  };
  const startEdit = (f: IntakeForm) => {
    setEditing(f);
    setProductId(f.whop_product_id);
    setTitle(f.title);
    setFields(f.fields);
    setConsent(f.consent_text);
  };
  const save = async () => {
    setSaving(true);
    try {
      if (editing === 'new') {
        await api.post('/api/coach/intake-forms', {
          whop_product_id: productId,
          title: title || 'Intake form',
          fields,
          consent_text: consent,
          is_active: true,
        });
      } else if (editing) {
        await api.patch(`/api/coach/intake-forms/${editing.id}`, { title, fields, consent_text: consent });
      }
      setEditing(null);
      onSaved();
    } catch (e: any) {
      onError(e.message || 'Could not save the form.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <SectionTitle>Intake forms</SectionTitle>
      <p className="mb-3 text-[13px] text-muted">
        One active form per product. A new client's record opens with this form waiting. The consent block ships with
        CoachDesk — you can edit its wording, but it can't be removed.
      </p>
      {forms.length === 0 && !editing && <p className="mb-3 text-sm text-secondary">No intake forms yet.</p>}
      <ul className="mb-3 flex flex-col gap-2">
        {forms.map((f) => (
          <li key={f.id} className="flex items-center gap-2 rounded-[10px] border border-strong bg-raised px-3 py-2">
            <span className="flex-1 text-sm">
              {f.title} <span className="text-muted">· v{f.version} · {f.is_active ? 'Active' : 'Inactive'} · {f.whop_product_id}</span>
            </span>
            <GhostButton onClick={() => startEdit(f)}>Edit</GhostButton>
            <GhostButton
              onClick={async () => {
                await api.patch(`/api/coach/intake-forms/${f.id}`, { is_active: !f.is_active });
                onSaved();
              }}
            >
              {f.is_active ? 'Deactivate' : 'Activate'}
            </GhostButton>
          </li>
        ))}
      </ul>
      {!editing ? (
        <PrimaryButton onClick={startNew}>New intake form</PrimaryButton>
      ) : (
        <div className="flex flex-col gap-3 rounded-[10px] border border-strong p-3">
          {editing === 'new' && (
            <div>
              <label className={labelClass} htmlFor="form-product">Whop product ID</label>
              <input id="form-product" className={inputClass} value={productId} onChange={(e) => setProductId(e.target.value)} placeholder="prod_…" />
              <p className="mt-1 text-[13px] text-muted">The product ID from your Whop dashboard — the form attaches to that product's buyers.</p>
            </div>
          )}
          <div>
            <label className={labelClass} htmlFor="form-title">Form title</label>
            <input id="form-title" className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Start Here" />
          </div>
          <FieldBuilder fields={fields} onChange={setFields} />
          <div>
            <label className={labelClass}>Consent text · Required — ships with CoachDesk</label>
            <textarea className={`${inputClass} min-h-[120px]`} value={consent} onChange={(e) => setConsent(e.target.value)} />
          </div>
          <div className="flex gap-2">
            <PrimaryButton onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save form'}
            </PrimaryButton>
            <SecondaryButton onClick={() => setEditing(null)}>Cancel</SecondaryButton>
          </div>
        </div>
      )}
    </Card>
  );
}

function CheckinTemplatesSection({
  templates,
  onSaved,
  onError,
}: {
  templates: CheckinTemplate[];
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [editing, setEditing] = useState<CheckinTemplate | 'new' | null>(null);
  const [productId, setProductId] = useState('');
  const [questions, setQuestions] = useState<FormField[]>([]);
  const [saving, setSaving] = useState(false);

  const startNew = () => {
    setEditing('new');
    setProductId('');
    setQuestions([
      { id: `field_${Date.now()}`, label: 'How was your week?', type: 'long_text', required: true },
    ]);
  };
  const startEdit = (t: CheckinTemplate) => {
    setEditing(t);
    setProductId(t.whop_product_id || '');
    setQuestions(t.questions);
  };
  const save = async () => {
    setSaving(true);
    try {
      if (editing === 'new') {
        await api.post('/api/coach/checkin-templates', { whop_product_id: productId, questions, is_active: true });
      } else if (editing) {
        await api.patch(`/api/coach/checkin-templates/${editing.id}`, { whop_product_id: productId, questions });
      }
      setEditing(null);
      onSaved();
    } catch (e: any) {
      onError(e.message || 'Could not save the template.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <SectionTitle>Check-in templates</SectionTitle>
      <p className="mb-3 text-[13px] text-muted">
        Weekly by default. Leave the product blank for a coach-wide template, or set one per product. A pending
        check-in appears in each active client's home every week.
      </p>
      <ul className="mb-3 flex flex-col gap-2">
        {templates.map((t) => (
          <li key={t.id} className="flex items-center gap-2 rounded-[10px] border border-strong bg-raised px-3 py-2">
            <span className="flex-1 text-sm">
              Weekly check-in <span className="text-muted">· {t.whop_product_id || 'all products'} · {t.questions.length} questions · {t.is_active ? 'Active' : 'Inactive'}</span>
            </span>
            <GhostButton onClick={() => startEdit(t)}>Edit</GhostButton>
            <GhostButton
              onClick={async () => {
                await api.patch(`/api/coach/checkin-templates/${t.id}`, { is_active: !t.is_active });
                onSaved();
              }}
            >
              {t.is_active ? 'Deactivate' : 'Activate'}
            </GhostButton>
          </li>
        ))}
      </ul>
      {!editing ? (
        <PrimaryButton onClick={startNew}>New check-in template</PrimaryButton>
      ) : (
        <div className="flex flex-col gap-3 rounded-[10px] border border-strong p-3">
          <div>
            <label className={labelClass} htmlFor="tpl-product">Whop product ID (blank = all products)</label>
            <input id="tpl-product" className={inputClass} value={productId} onChange={(e) => setProductId(e.target.value)} placeholder="prod_… (optional)" />
          </div>
          <FieldBuilder fields={questions} onChange={setQuestions} />
          <div className="flex gap-2">
            <PrimaryButton onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save template'}
            </PrimaryButton>
            <SecondaryButton onClick={() => setEditing(null)}>Cancel</SecondaryButton>
          </div>
        </div>
      )}
    </Card>
  );
}

function DangerZone({ onError }: { onError: (m: string) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [checked, setChecked] = useState(false);
  return (
    <Card className="border-danger/40">
      <h2 className="mb-2 text-base font-semibold text-danger">Danger zone</h2>
      {!confirming ? (
        <>
          <p className="mb-3 text-sm text-secondary">
            Delete your CoachDesk account and every client record in it. Export your book first — this cannot be
            undone.
          </p>
          <button
            className="min-h-[44px] rounded-[10px] bg-danger-fill px-4 text-sm font-semibold text-white"
            onClick={() => setConfirming(true)}
          >
            Delete account
          </button>
        </>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            This hard-deletes every client record (notes, answers, goals, check-ins) held in CoachDesk. Nothing in
            Whop is touched — CoachDesk never held payment data. Deleted content is fully out of backups within 30
            days.
          </p>
          <SecondaryButton onClick={() => downloadJson('/api/coach/export', 'coachdesk-whole-book.json').catch(() => onError('Export failed.'))}>
            Export book first
          </SecondaryButton>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="h-4 w-4 accent-[#dc2626]" />
            I understand every record will be deleted
          </label>
          <div className="flex gap-2">
            <button
              disabled={!checked}
              className="min-h-[44px] rounded-[10px] bg-danger-fill px-4 text-sm font-semibold text-white disabled:opacity-50"
              onClick={async () => {
                try {
                  await api.post('/api/coach/account/delete', { confirm: true });
                  window.location.reload();
                } catch (e: any) {
                  onError(e.message || 'Deletion failed.');
                }
              }}
            >
              Delete my account
            </button>
            <SecondaryButton onClick={() => setConfirming(false)}>Cancel</SecondaryButton>
          </div>
        </div>
      )}
    </Card>
  );
}
