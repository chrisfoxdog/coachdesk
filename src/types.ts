export interface FormField {
  id: string;
  label: string;
  type: 'short_text' | 'long_text' | 'single_choice' | 'multi_choice' | 'checkbox';
  required: boolean;
  help_text?: string;
  options?: string[];
}

export interface RosterClient {
  id: string;
  display_name: string;
  status: string;
  started_at: string;
  program_week: number;
  membership_status: string | null;
  whop_product_id: string | null;
  open_flags: number;
  deletion_requested: boolean;
}

export interface Flag {
  id: string;
  client_id: string;
  client_name?: string;
  type: string;
  severity: 'urgent' | 'attention' | 'notice';
  status: string;
  detail: string;
  created_at: string;
}

export interface Goal {
  id: string;
  title: string;
  description: string;
  target: string;
  status: string;
  progress_note: string;
  progress_updated_at: string;
  visibility: 'shared' | 'coach_only';
}

export interface SessionLog {
  id: string;
  session_at: string;
  notes: string;
  wins: string;
  created_at: string;
}

export interface ActionItem {
  id: string;
  text: string;
  due_date?: string | null;
  done_at?: string | null;
  session_log_id?: string;
}

export interface ClientEvent {
  id?: string;
  type: string;
  summary: string;
  occurred_at: string;
  visibility?: string;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function formatDate(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatDateTime(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return (
    d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ', ' +
    d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  );
}
