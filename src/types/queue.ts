export type PromptStatus = 'pending' | 'running' | 'completed' | 'cancelled';
export type SessionStatus = 'active' | 'idle';
export type QueueStatus = 'active' | 'completed' | 'empty';

export interface Prompt {
  id: string;
  text: string;
  status: PromptStatus;
  createdAt: string;
  completedAt: string | null;
}

export interface SessionQueue {
  sessionId: string;
  project: string;
  directory: string;
  sessionName: string | null;
  prompts: Prompt[];
  startedAt: string;
  lastActivity: string;
  currentPromptId: string | null;
  completedAt: string | null;
  closedAt: string | null;
}

export type SessionWithStatus = SessionQueue & { status: SessionStatus };

export interface ProjectView {
  project: string;
  directory: string;
  sessions: SessionWithStatus[];
  queueStatus: QueueStatus;
}
