# SSE Real-Time Updates

## Goal
Replace 2s polling with Server-Sent Events so the dashboard updates instantly when prompt states change.

## Approach
SSE + fs.watch (Enfoque A). The server watches `~/.promptline/queues/` for filesystem changes and broadcasts the full project state to all connected SSE clients.

## Architecture

### Server (vite-plugin-api.ts)
- New endpoint: `GET /api/events` returns `text/event-stream`
- `fs.watch` recursive on `QUEUES_DIR` detects JSON file changes
- Debounce 200ms to group rapid writes (atomic rename can fire multiple events)
- On change: `listProjects()` → broadcast `event: projects` with full payload
- `Set<ServerResponse>` tracks active SSE connections
- Cleanup: remove client on `res.close`, close watcher on server shutdown

### Event format
```
event: projects
data: [{"project":"foo","directory":"/path",...}]
```

Single event type. Full state replacement. Simple.

### Data flow
```
Claude Code hook writes JSON → fs.watch → debounce 200ms → listProjects() → SSE broadcast
Dashboard mutation (POST/DELETE) → writeSession() → fs.watch → same broadcast
```

Dashboard mutations automatically trigger SSE updates via the filesystem watcher — no extra code needed.

### Frontend

#### useSSE.ts (new)
- Opens `EventSource` to `/api/events`
- Parses `projects` events, calls subscriber callback
- Exposes connection status (connected/disconnected)

#### useProjects.ts (modified)
- Initial fetch on mount
- Subscribes to SSE for real-time updates
- Fallback: if SSE disconnects, activates 2s polling until reconnected

#### useProject.ts (modified)
- Derives data from useProjects stream filtered by project name
- Removes independent polling

One SSE stream for the entire app, not one per component.

## Tasks
1. Add fs.watch + SSE endpoint to vite-plugin-api.ts
2. Create useSSE.ts hook
3. Rewrite useProjects.ts to use SSE with polling fallback
4. Rewrite useProject.ts to derive from projects stream
5. E2E test
