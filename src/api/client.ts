import type { ProjectView, Prompt } from '../types/queue';

const BASE = '/api';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `API error: ${res.status}`);
  }
  return res.json();
}

function projectUrl(project: string): string {
  return `/projects/${encodeURIComponent(project)}`;
}

function sessionUrl(project: string, sessionId: string): string {
  return `${projectUrl(project)}/sessions/${encodeURIComponent(sessionId)}`;
}

export const api = {
  listProjects: () => request<ProjectView[]>('/projects'),

  getProject: (project: string) => request<ProjectView>(projectUrl(project)),

  deleteProject: (project: string) =>
    request<{ deleted: string }>(projectUrl(project), { method: 'DELETE' }),

  deleteSession: (project: string, sessionId: string) =>
    request<{ deleted: string }>(sessionUrl(project, sessionId), { method: 'DELETE' }),

  clearPrompts: (project: string, sessionId: string) =>
    request<{ cleared: number }>(`${sessionUrl(project, sessionId)}/prompts`, { method: 'DELETE' }),

  addPrompt: (project: string, sessionId: string, text: string) =>
    request<Prompt>(`${sessionUrl(project, sessionId)}/prompts`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  updatePrompt: (project: string, sessionId: string, promptId: string, data: { text?: string }) =>
    request<Prompt>(`${sessionUrl(project, sessionId)}/prompts/${encodeURIComponent(promptId)}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  deletePrompt: (project: string, sessionId: string, promptId: string) =>
    request<Prompt>(`${sessionUrl(project, sessionId)}/prompts/${encodeURIComponent(promptId)}`, {
      method: 'DELETE',
    }),

  reorderPrompts: (project: string, sessionId: string, order: string[]) =>
    request<void>(`${sessionUrl(project, sessionId)}/prompts/reorder`, {
      method: 'PUT',
      body: JSON.stringify({ order }),
    }),
};
