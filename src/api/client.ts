import type { ProjectQueue, Prompt } from '../types/queue';

const BASE = '/api';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export const api = {
  listQueues: () => request<ProjectQueue[]>('/queues'),

  getQueue: (project: string) => request<ProjectQueue>(`/queues/${encodeURIComponent(project)}`),

  createQueue: (project: string, directory: string) =>
    request<ProjectQueue>(`/queues/${encodeURIComponent(project)}`, {
      method: 'POST',
      body: JSON.stringify({ directory }),
    }),

  deleteQueue: (project: string) =>
    request<{ deleted: string }>(`/queues/${encodeURIComponent(project)}`, { method: 'DELETE' }),

  addPrompt: (project: string, text: string) =>
    request<Prompt>(`/queues/${encodeURIComponent(project)}/prompts`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  updatePrompt: (project: string, id: string, data: Partial<Pick<Prompt, 'text' | 'status'>>) =>
    request<Prompt>(`/queues/${encodeURIComponent(project)}/prompts/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  deletePrompt: (project: string, id: string) =>
    request<Prompt>(`/queues/${encodeURIComponent(project)}/prompts/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  reorderPrompts: (project: string, order: string[]) =>
    request<ProjectQueue>(`/queues/${encodeURIComponent(project)}/prompts/reorder`, {
      method: 'PUT',
      body: JSON.stringify({ order }),
    }),
};
