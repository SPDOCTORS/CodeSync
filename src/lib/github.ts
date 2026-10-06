import type { Settings } from './types';

export class GitHubRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export function normalizeRepository(value: string): string | null {
  const input = value.trim().replace(/\.git\/?$/, '');
  const match = input.match(/^(?:https?:\/\/(?:www\.)?github\.com\/)?([^/\s]+)\/([^/\s]+)\/?$/i);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

export function normalizeAuthorizationServer(value: string): string | null {
  try {
    const url = new URL(value.trim());
    const isLocalDevelopment = url.protocol === 'http:' && url.hostname === 'localhost' && url.port === '8787';
    if (url.protocol !== 'https:' && !isLocalDevelopment) return null;
    return url.origin;
  } catch { return null; }
}

export class GitHubService {
  constructor(private readonly baseUrl: string, private readonly sessionToken: string) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.sessionToken}`, ...(init?.headers ?? {}) }
    });
    if (!response.ok) throw new GitHubRequestError((await response.text()) || `GitHub request failed (${response.status})`, response.status);
    return response.json() as Promise<T>;
  }

  async listRepositories(): Promise<Array<{ full_name: string; private: boolean }>> {
    return this.request('/v1/github/repos');
  }
  async checkSession(): Promise<{ ok: true }> {
    return this.request('/v1/github/session');
  }
  async verifyRepository(repository: string): Promise<{ full_name: string; private: boolean }> {
    return this.request(`/v1/github/repos/${encodeURIComponent(repository)}`);
  }
  async createRepository(): Promise<{ full_name: string }> {
    return this.request('/v1/github/repos', { method: 'POST', body: JSON.stringify({ name: 'Competitive-Programming', private: true }) });
  }
  async commit(repository: string, path: string, content: string, message: string): Promise<void> {
    await this.request(`/v1/github/repos/${encodeURIComponent(repository)}/contents`, {
      method: 'PUT', body: JSON.stringify({ path, content, message })
    });
  }
}

export async function githubService(settings: Settings): Promise<GitHubService | null> {
  const baseUrl = normalizeAuthorizationServer(settings.authorizationServer);
  const local = await chrome.storage.local.get('backendSession') as { backendSession?: string };
  const session = await chrome.storage.session.get('backendSession') as { backendSession?: string };
  const backendSession = local.backendSession ?? session.backendSession;
  return baseUrl && typeof backendSession === 'string' ? new GitHubService(baseUrl, backendSession) : null;
}
