const BASE = "http://localhost:8000";

export async function startRun(params) {
  const res = await fetch(`${BASE}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed: ${res.status}`);
  }
  return res.json();
}

export function watchRun(runId, onEvent) {
  const source = new EventSource(`${BASE}/api/runs/${runId}/events`);
  source.onmessage = (e) => onEvent(JSON.parse(e.data));
  source.onerror = () => {
    onEvent({ type: "error", message: "Lost connection to the server." });
    source.close();
  };
  return () => source.close();
}

export async function fetchResult(runId) {
  const res = await fetch(`${BASE}/api/runs/${runId}/result`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed: ${res.status}`);
  }
  return res.json();
}
