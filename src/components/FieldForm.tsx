import type { FormField } from '../types';
import { inputClass, labelClass } from './ui';

// One field system for intake forms and check-ins (design system §6.6):
// the answering view, the read view, and the coach's builder.

export function FieldAnswers({
  fields,
  values,
  onChange,
}: {
  fields: FormField[];
  values: Record<string, unknown>;
  onChange: (fieldId: string, value: unknown) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      {fields.map((f, idx) => {
        const v = values[f.id];
        return (
          <div key={f.id}>
            <label className={labelClass} htmlFor={`field-${f.id}`}>
              {idx + 1}. {f.label}
              {f.required ? ' · Required' : ''}
            </label>
            {f.help_text && <p className="mb-1 text-[13px] text-muted">{f.help_text}</p>}
            {f.type === 'short_text' && (
              <input
                id={`field-${f.id}`}
                className={inputClass}
                value={typeof v === 'string' ? v : ''}
                onChange={(e) => onChange(f.id, e.target.value)}
              />
            )}
            {f.type === 'long_text' && (
              <textarea
                id={`field-${f.id}`}
                className={`${inputClass} min-h-[88px]`}
                value={typeof v === 'string' ? v : ''}
                onChange={(e) => onChange(f.id, e.target.value)}
              />
            )}
            {f.type === 'single_choice' && (
              <div className="flex flex-col gap-2" role="radiogroup" aria-label={f.label}>
                {(f.options || []).map((opt) => (
                  <label key={opt} className="flex min-h-[44px] cursor-pointer items-center gap-3 rounded-[10px] border border-strong bg-raised px-3 text-sm">
                    <input
                      type="radio"
                      name={`field-${f.id}`}
                      checked={v === opt}
                      onChange={() => onChange(f.id, opt)}
                      className="h-4 w-4 accent-[#2563eb]"
                    />
                    {opt}
                  </label>
                ))}
              </div>
            )}
            {f.type === 'multi_choice' && (
              <div className="flex flex-col gap-2">
                {(f.options || []).map((opt) => {
                  const arr = Array.isArray(v) ? (v as string[]) : [];
                  const checked = arr.includes(opt);
                  return (
                    <label key={opt} className="flex min-h-[44px] cursor-pointer items-center gap-3 rounded-[10px] border border-strong bg-raised px-3 text-sm">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          onChange(f.id, checked ? arr.filter((x) => x !== opt) : [...arr, opt])
                        }
                        className="h-4 w-4 accent-[#2563eb]"
                      />
                      {opt}
                    </label>
                  );
                })}
              </div>
            )}
            {f.type === 'checkbox' && (
              <label className="flex min-h-[44px] cursor-pointer items-center gap-3 rounded-[10px] border border-strong bg-raised px-3 text-sm">
                <input
                  type="checkbox"
                  checked={v === true}
                  onChange={(e) => onChange(f.id, e.target.checked)}
                  className="h-4 w-4 accent-[#2563eb]"
                />
                {f.label}
              </label>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function AnswerList({ fields, answers }: { fields: FormField[]; answers: Record<string, unknown> }) {
  const render = (v: unknown): string => {
    if (v === undefined || v === null || v === '') return '—';
    if (Array.isArray(v)) return v.length ? v.join(', ') : '—';
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    return String(v);
  };
  return (
    <dl className="flex flex-col gap-3">
      {fields.map((f) => (
        <div key={f.id}>
          <dt className="text-xs font-medium uppercase tracking-wide text-muted">{f.label}</dt>
          <dd className="mt-0.5 whitespace-pre-wrap text-sm text-secondary">{render(answers?.[f.id])}</dd>
        </div>
      ))}
    </dl>
  );
}

const TYPE_OPTIONS: { value: FormField['type']; label: string }[] = [
  { value: 'short_text', label: 'Short text' },
  { value: 'long_text', label: 'Long text' },
  { value: 'single_choice', label: 'Single choice' },
  { value: 'multi_choice', label: 'Multi choice' },
  { value: 'checkbox', label: 'Checkbox' },
];

/** Coach builder: rows with up/down buttons (no drag — mobile webviews). */
export function FieldBuilder({
  fields,
  onChange,
}: {
  fields: FormField[];
  onChange: (fields: FormField[]) => void;
}) {
  const move = (idx: number, dir: -1 | 1) => {
    const next = [...fields];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    onChange(next);
  };
  const patch = (idx: number, p: Partial<FormField>) => {
    const next = fields.map((f, i) => (i === idx ? { ...f, ...p } : f));
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-3">
      {fields.map((f, idx) => (
        <div key={f.id} className="rounded-[10px] border border-strong bg-raised p-3">
          <div className="flex flex-col gap-2">
            <input
              aria-label={`Question ${idx + 1} label`}
              className={inputClass}
              placeholder="Question label"
              value={f.label}
              onChange={(e) => patch(idx, { label: e.target.value })}
            />
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label={`Question ${idx + 1} type`}
                className="rounded-[10px] border border-strong bg-surface px-2 py-2 text-sm"
                value={f.type}
                onChange={(e) => patch(idx, { type: e.target.value as FormField['type'] })}
              >
                {TYPE_OPTIONS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-2 text-sm text-secondary">
                <input
                  type="checkbox"
                  checked={f.required}
                  onChange={(e) => patch(idx, { required: e.target.checked })}
                  className="h-4 w-4 accent-[#2563eb]"
                />
                Required
              </label>
              <span className="ml-auto flex gap-1">
                <button type="button" aria-label="Move question up" className="min-h-[40px] px-2 text-bright" onClick={() => move(idx, -1)}>
                  ↑
                </button>
                <button type="button" aria-label="Move question down" className="min-h-[40px] px-2 text-bright" onClick={() => move(idx, 1)}>
                  ↓
                </button>
                <button
                  type="button"
                  aria-label="Delete question"
                  className="min-h-[40px] px-2 text-danger"
                  onClick={() => onChange(fields.filter((_, i) => i !== idx))}
                >
                  ✕
                </button>
              </span>
            </div>
            {(f.type === 'single_choice' || f.type === 'multi_choice') && (
              <input
                aria-label={`Question ${idx + 1} options`}
                className={inputClass}
                placeholder="Options, comma separated"
                value={(f.options || []).join(', ')}
                onChange={(e) => patch(idx, { options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
              />
            )}
            <input
              aria-label={`Question ${idx + 1} help text`}
              className={inputClass}
              placeholder="Help text (optional)"
              value={f.help_text || ''}
              onChange={(e) => patch(idx, { help_text: e.target.value })}
            />
          </div>
        </div>
      ))}
      <button
        type="button"
        className="min-h-[44px] rounded-[10px] border border-dashed border-strong text-sm font-medium text-bright"
        onClick={() =>
          onChange([
            ...fields,
            { id: `field_${Date.now()}_${fields.length}`, label: '', type: 'short_text', required: false },
          ])
        }
      >
        + Add question
      </button>
    </div>
  );
}
