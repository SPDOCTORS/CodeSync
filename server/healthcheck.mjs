const baseUrl = new URL(process.env.CODESYNC_BACKEND_URL ?? 'http://localhost:8787').origin;
const timeout = AbortSignal.timeout(5_000);

try {
  const response = await fetch(`${baseUrl}/healthz`, { signal: timeout });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok !== true) throw new Error(`Unexpected HTTP ${response.status}`);
  console.log(`CodeSync backend is ready at ${baseUrl}`);
} catch (error) {
  console.error(`CodeSync backend readiness check failed for ${baseUrl}: ${error instanceof Error ? error.message : 'Unknown error'}`);
  process.exitCode = 1;
}
