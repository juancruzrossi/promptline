import { useState } from 'react';
import { useQueues } from './hooks/useQueues';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { QueueDetail } from './components/QueueDetail';
import { CreateQueueModal } from './components/CreateQueueModal';

function App() {
  const { queues, loading, error, refresh } = useQueues();
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);

  function handleQueueCreated(project: string) {
    refresh();
    setSelectedProject(project);
  }

  function handleQueueDeleted() {
    setSelectedProject(null);
    refresh();
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-[var(--color-bg)] text-[var(--color-text)] font-mono">
      {/* Main area: sidebar + content */}
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          queues={queues}
          selectedProject={selectedProject}
          onSelectProject={setSelectedProject}
          onCreateQueue={() => setShowCreateModal(true)}
        />

        {/* Main content */}
        <main className="flex-1 overflow-hidden bg-[var(--color-bg)]">
          {loading && (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-[var(--color-muted)] animate-pulse">Loading...</p>
            </div>
          )}

          {!loading && error && (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-red-400">Error: {error}</p>
            </div>
          )}

          {!loading && !error && !selectedProject && (
            <div className="flex flex-col items-center justify-center h-full gap-2 select-none">
              <span className="text-2xl text-[var(--color-border)]">&#x25A1;</span>
              <p className="text-sm text-[var(--color-muted)]">Select a project</p>
            </div>
          )}

          {!loading && !error && selectedProject && (
            <QueueDetail
              project={selectedProject}
              onQueueDeleted={handleQueueDeleted}
            />
          )}
        </main>
      </div>

      {/* Status bar pinned at bottom */}
      <StatusBar queues={queues} />

      {/* Create Queue modal */}
      <CreateQueueModal
        open={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreated={handleQueueCreated}
      />
    </div>
  );
}

export default App;
