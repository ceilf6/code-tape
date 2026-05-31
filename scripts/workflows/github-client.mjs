import { repoFromEnv } from './config.mjs';

export class GitHubClient {
  constructor({ token = process.env.GITHUB_TOKEN, owner, repo } = {}) {
    if (!token) {
      throw new Error('GITHUB_TOKEN is required');
    }
    const envRepo = owner && repo ? { owner, repo } : repoFromEnv();
    this.token = token;
    this.owner = envRepo.owner;
    this.repo = envRepo.repo;
    this.baseUrl = 'https://api.github.com';
  }

  async request(method, path, body) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (response.status === 204) {
      return null;
    }

    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const message = data?.message ?? response.statusText;
      const error = new Error(`${method} ${path} failed: ${message}`);
      error.status = response.status;
      error.response = data;
      throw error;
    }
    return data;
  }

  issuePath(issueNumber, suffix = '') {
    return `/repos/${this.owner}/${this.repo}/issues/${issueNumber}${suffix}`;
  }

  pullPath(prNumber, suffix = '') {
    return `/repos/${this.owner}/${this.repo}/pulls/${prNumber}${suffix}`;
  }

  async comment(issueNumber, body) {
    return this.request('POST', this.issuePath(issueNumber, '/comments'), { body });
  }

  async getIssue(issueNumber) {
    return this.request('GET', this.issuePath(issueNumber));
  }

  async getPull(prNumber) {
    return this.request('GET', this.pullPath(prNumber));
  }

  async getCommit(sha) {
    return this.request('GET', `/repos/${this.owner}/${this.repo}/commits/${sha}`);
  }

  async listCheckRunsForRef(ref) {
    const checkRuns = [];
    const basePath = `/repos/${this.owner}/${this.repo}/commits/${encodeURIComponent(ref)}/check-runs?filter=all&per_page=100`;
    for (let page = 1; ; page += 1) {
      const path = page === 1 ? basePath : `${basePath}&page=${page}`;
      const data = await this.request('GET', path);
      const pageRuns = data.check_runs ?? [];
      checkRuns.push(...pageRuns);
      if (pageRuns.length < 100 || (data.total_count !== undefined && checkRuns.length >= data.total_count)) {
        break;
      }
    }
    return checkRuns;
  }

  async addLabels(issueNumber, labels) {
    return this.request('POST', this.issuePath(issueNumber, '/labels'), { labels });
  }

  async removeLabel(issueNumber, label) {
    try {
      return await this.request('DELETE', this.issuePath(issueNumber, `/labels/${encodeURIComponent(label)}`));
    } catch (error) {
      if (error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async setAssignees(issueNumber, assignees) {
    return this.request('POST', this.issuePath(issueNumber, '/assignees'), { assignees });
  }

  async closeIssue(issueNumber) {
    return this.request('PATCH', this.issuePath(issueNumber), { state: 'closed' });
  }

  async closePull(prNumber) {
    return this.request('PATCH', this.pullPath(prNumber), { state: 'closed' });
  }

  async mergePull(prNumber, { commitTitle, commitMessage }) {
    return this.request('PUT', this.pullPath(prNumber, '/merge'), {
      merge_method: 'squash',
      commit_title: commitTitle,
      commit_message: commitMessage,
    });
  }

  async listPullFiles(prNumber) {
    return this.paginate(this.pullPath(prNumber, '/files'), (item) => item.filename);
  }

  async listPullReviews(prNumber) {
    return this.paginate(this.pullPath(prNumber, '/reviews'));
  }

  async listPullReviewComments(prNumber) {
    return this.paginate(this.pullPath(prNumber, '/comments'));
  }

  async listIssueComments(issueNumber) {
    return this.paginate(this.issuePath(issueNumber, '/comments'));
  }

  async listOpenPulls() {
    return this.paginate(`/repos/${this.owner}/${this.repo}/pulls?state=open&per_page=100`);
  }

  async deleteBranch(branch) {
    return this.request('DELETE', `/repos/${this.owner}/${this.repo}/git/refs/heads/${encodeURIComponent(branch)}`);
  }

  async upsertLabel(label) {
    try {
      return await this.request('POST', `/repos/${this.owner}/${this.repo}/labels`, label);
    } catch (error) {
      if (error.status !== 422) {
        throw error;
      }
      return this.request('PATCH', `/repos/${this.owner}/${this.repo}/labels/${encodeURIComponent(label.name)}`, {
        color: label.color,
        description: label.description,
      });
    }
  }

  async paginate(path, map = (item) => item) {
    const results = [];
    let nextPath = path.includes('?') ? `${path}&per_page=100` : `${path}?per_page=100`;
    while (nextPath) {
      const data = await this.request('GET', nextPath);
      results.push(...data.map(map));
      nextPath = null;
    }
    return results;
  }
}

export async function readEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error('GITHUB_EVENT_PATH is required');
  }
  const { readFile } = await import('node:fs/promises');
  return JSON.parse(await readFile(eventPath, 'utf8'));
}
