import { useState } from 'react';
import { useProjects } from './hooks/useQueues';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { ProjectDetail } from './components/ProjectDetail';

function App() {
  const { projects, loading, error } = useProjects();
  const [selectedProject, setSelectedProject] = useState<string | null>(null);

  function handleProjectDeleted() {
    setSelectedProject(null);
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-[var(--color-bg)] text-[var(--color-text)] font-mono">
      {/* Main area: sidebar + content */}
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          projects={projects}
          selectedProject={selectedProject}
          onSelectProject={setSelectedProject}
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
            <ProjectDetail
              project={selectedProject}
              onProjectDeleted={handleProjectDeleted}
            />
          )}
        </main>
      </div>

      {/* Status bar pinned at bottom */}
      <StatusBar projects={projects} />
    </div>
  );
}

export default App;
