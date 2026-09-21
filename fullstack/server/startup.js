export async function existingServer(port, request = fetch) {
  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await request(`${base}/health`, { signal: AbortSignal.timeout(1500) });
    if (!health.ok) return false;
    const data = await health.json();
    if (data.service === 'aez-live') return true;
    // Recognize the earlier local server without touching its open database.
    const config = await request(`${base}/api/config`, { signal: AbortSignal.timeout(1500) });
    return data.status === 'ok' && config.ok && typeof (await config.json()).googleClientId === 'string';
  } catch { return false; }
}
