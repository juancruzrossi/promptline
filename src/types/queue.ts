export type PromptStatus = 'pending' | 'running' | 'completed';
export type SessionStatus = 'active' | 'idle';

export interface Prompt {
  id: string;
  text: string;
  status: PromptStatus;
  createdAt: string;
  completedAt: string | null;
}

export interface ActiveSession {
  sessionId: string;
  status: SessionStatus;
  startedAt: string;
  lastActivity: string;
  currentPromptId: string | null;
}

export interface SessionHistoryEntry {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  promptsExecuted: number;
}

export interface ProjectQueue {
  project: string;
  directory: string;
  prompts: Prompt[];
  activeSession: ActiveSession | null;
  sessionHistory: SessionHistoryEntry[];
}
