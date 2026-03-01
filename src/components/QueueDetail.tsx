import { useState, useRef } from 'react';
import { useQueue } from '../hooks/useQueue';
import { api } from '../api/client';
import type { Prompt } from '../types/queue';
import { SessionInfo } from './SessionInfo';
import { PromptCard } from './PromptCard';
import { AddPromptForm } from './AddPromptForm';

interface QueueDetailProps {
  project: string;
  onQueueDeleted: () => void;
}

export function QueueDetail({ project, onQueueDeleted }: QueueDetailProps) {
  const { queue, loading, error, refresh } = useQueue(project);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragSourceRef = useRef<string | null>(null);

  function handleDragStart(id: string) {
    dragSourceRef.current = id;
    setDraggingId(id);
  }

  function handleDragEnter(id: string) {
    if (dragSourceRef.current && dragSourceRef.current !== id) {
      setDragOverId(id);
    }
  }

  function handleDragEnd() {
    setDragOverId(null);
    setDraggingId(null);
    dragSourceRef.current = null;
  }

  function handleDrop(targetId: string) {
    const sourceId = dragSourceRef.current;
    if (!sourceId || sourceId === targetId || !queue) {
      handleDragEnd();
      return;
    }

    const pendingPrompts = queue.prompts.filter((p) => p.status === 'pending');
    const sourceIndex = pendingPrompts.findIndex((p) => p.id === sourceId);
    const targetIndex = pendingPrompts.findIndex((p) => p.id === targetId);
    if (sourceIndex === -1 || targetIndex === -1) {
      handleDragEnd();
      return;
    }

    const reordered = [...pendingPrompts];
    const [moved] = reordered.splice(sourceIndex, 1);
    reordered.splice(targetIndex, 0, moved);

    const newOrder = reordered.map((p) => p.id);
    handleDragEnd();
    api.reorderPrompts(project, newOrder).then(refresh).catch(() => {});
  }

  async function handleDeleteQueue() {
    const confirmed = window.confirm(
      `Delete queue "${project}"? This action cannot be undone.`
    );
    if (!confirmed) return;
    try {
      await api.deleteQueue(project);
      onQueueDeleted();
    } catch {
      // Silent fail
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-[var(--color-muted)] animate-pulse">Loading...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-red-400">Error: {error}</p>
      </div>
    );
  }

  if (!queue) return null;

  const activePrompts = queue.prompts.filter((p) => p.status !== 'completed');
  const completedPrompts = queue.prompts.filter((p) => p.status === 'completed');

  function renderPromptList(prompts: Prompt[], reorderable: boolean) {
    return prompts.map((prompt) => (
      <PromptCard
        key={prompt.id}
        prompt={prompt}
        project={project}
        onMutate={refresh}
        onDragStart={reorderable ? handleDragStart : undefined}
        onDragEnter={reorderable ? handleDragEnter : undefined}
        onDragEnd={reorderable ? handleDragEnd : undefined}
        onDrop={reorderable ? handleDrop : undefined}
        isDragOver={dragOverId === prompt.id}
        isDragging={draggingId === prompt.id}
      />
    ));
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="shrink-0 px-6 pt-6 pb-4 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-[var(--color-text)] truncate leading-tight">
              {queue.project}
            </h2>
            <p className="text-xs text-[var(--color-muted)] mt-0.5 truncate font-mono">
              {queue.directory}
            </p>
          </div>

          <button
            type="button"
            onClick={handleDeleteQueue}
            className={[
              'shrink-0 text-xs px-3 py-1.5 rounded border transition-all duration-150 cursor-pointer',
              'border-red-900/40 text-red-500/60',
              'hover:border-red-500/60 hover:text-red-400 hover:bg-red-500/5',
              'focus:outline-none focus:ring-1 focus:ring-red-500/30',
            ].join(' ')}
            aria-label={`Delete queue ${queue.project}`}
          >
            Delete Queue
          </button>
        </div>

        <div className="mt-4">
          <SessionInfo session={queue.activeSession} />
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-2">
        {activePrompts.length === 0 && completedPrompts.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-8 select-none">
            <span className="text-2xl text-[var(--color-border)]">&#x25A1;</span>
            <p className="text-sm text-[var(--color-muted)]">No prompts yet</p>
          </div>
        )}

        {activePrompts.length > 0 && (
          <div className="space-y-2" role="list" aria-label="Active prompts">
            {renderPromptList(activePrompts, true)}
          </div>
        )}

        <div className="pt-1">
          <AddPromptForm project={project} onAdded={refresh} />
        </div>

        {completedPrompts.length > 0 && (
          <div className="pt-2">
            <button
              type="button"
              onClick={() => setHistoryOpen((v) => !v)}
              className={[
                'flex items-center gap-2 text-xs text-[var(--color-muted)] uppercase tracking-wider py-1 cursor-pointer',
                'hover:text-[var(--color-text)] transition-colors duration-150 focus:outline-none',
              ].join(' ')}
              aria-expanded={historyOpen}
              aria-controls="history-section"
            >
              <span
                className="inline-block transition-transform duration-200"
                style={{ transform: historyOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
                aria-hidden="true"
              >
                ▶
              </span>
              History ({completedPrompts.length})
            </button>

            {historyOpen && (
              <div
                id="history-section"
                className="mt-2 space-y-2"
                role="list"
                aria-label="Completed prompts"
              >
                {renderPromptList(completedPrompts, false)}
              </div>
            )}
          </div>
        )}

        <div className="h-4" aria-hidden="true" />
      </div>
    </div>
  );
}
