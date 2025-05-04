// The module 'vscode' contains the VS Code extensibility API
import * as vscode from 'vscode';
import * as path from 'path';
import simpleGit, { SimpleGit } from 'simple-git';
import * as https from 'https';

interface CommitInfo {
  hash: string;
  date: string;
  message: string;
  author_name: string;
  author_email: string;
}

interface NonReleaseCommit {
  hash: string;
  message: string;
  author: string;
  pattern: string;
  isPrCommit: boolean;
}

interface PrCommit {
  sha: string;
  commit: {
    message: string;
  };
  author: {
    login: string;
  };
}

export function activate(context: vscode.ExtensionContext) {
  console.log('拡張機能 "release-check" がアクティブになりました');

  const disposable = vscode.commands.registerCommand('release-check.checkReleaseCommits', async () => {
    try {
      const prUrlsInput = await vscode.window.showInputBox({
        prompt: 'リリース対象のプルリクエストURLを入力してください（複数の場合はカンマ区切り）',
        placeHolder: 'https://github.com/owner/repo/pull/123, https://github.com/owner/repo/pull/456',
        ignoreFocusOut: true,
        validateInput: (value: string) => {
          if (!value) {
            return 'URLを入力してください';
          }
          
          const urls = value.split(',').map(url => url.trim());
          for (const url of urls) {
            if (!url.includes('pull') && !url.includes('PR')) {
              return `無効なURL: ${url} - プルリクエストのURLを入力してください`;
            }
          }
          return null;
        }
      });

      if (!prUrlsInput) {
        return;
      }
      
      const prUrls = prUrlsInput.split(',').map((url: string) => url.trim());

      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('ワークスペースが開かれていません。');
        return;
      }
      
      const rootPath = workspaceFolders[0].uri.fsPath;
      
      const config = vscode.workspace.getConfiguration('release-check');
      const sourceBranch = config.get<string>('sourceBranch', 'develop');
      const targetBranch = config.get<string>('targetBranch', 'main');
      const excludePatterns = config.get<string[]>('excludePatterns', ['WIP', 'DO NOT MERGE', 'NOT FOR RELEASE']);
      
      const git: SimpleGit = simpleGit(rootPath);
      
      try {
        await git.revparse(['--verify', sourceBranch]);
        await git.revparse(['--verify', targetBranch]);
      } catch (error) {
        vscode.window.showErrorMessage(`ブランチの確認に失敗しました: ${error}`);
        return;
      }
      
      const logResult = await git.log({
        from: targetBranch,
        to: sourceBranch
      });
      
      if (!logResult.all || logResult.all.length === 0) {
        vscode.window.showInformationMessage(`${sourceBranch}と${targetBranch}の間に差分はありません。`);
        return;
      }
      
      const nonReleaseCommits: NonReleaseCommit[] = [];
      
      const prCommitHashes = new Set<string>();
      
      for (const prUrl of prUrls) {
        const prUrlRegex = /https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/;
        const prUrlMatch = prUrl.match(prUrlRegex);
        
        if (!prUrlMatch) {
          vscode.window.showErrorMessage(`無効なプルリクエストURL: ${prUrl}`);
          continue;
        }
        
        const [, owner, repo, prNumber] = prUrlMatch;
        
        try {
          const prCommits = await getPrCommits(owner, repo, prNumber);
          
          if (prCommits && prCommits.length > 0) {
            prCommits.forEach(commit => prCommitHashes.add(commit.sha));
          }
        } catch (error) {
          vscode.window.showWarningMessage(`PR ${prUrl} のコミット情報取得に失敗しました: ${error}`);
        }
      }
      
      if (prCommitHashes.size === 0) {
        vscode.window.showErrorMessage('有効なプルリクエストのコミット情報を取得できませんでした。');
        return;
      }
      
      console.log('Branch commits:', logResult.all.map(c => c.hash));
      console.log('PR commits:', Array.from(prCommitHashes));
      
      for (const commit of logResult.all) {
        const isMergeCommit = commit.message.startsWith('Merge pull request') || 
                             commit.message.startsWith('Merge branch');
        
        if (isMergeCommit) {
          continue;
        }
        
        let isNonReleaseCommit = false;
        let pattern = '';
        
        for (const excludePattern of excludePatterns) {
          if (commit.message.includes(excludePattern)) {
            isNonReleaseCommit = true;
            pattern = excludePattern;
            break;
          }
        }
        
        const isPrCommit = Array.from(prCommitHashes).some(prHash => 
          prHash.toLowerCase() === commit.hash.toLowerCase()
        );
        
        if (!isPrCommit) {
          isNonReleaseCommit = true;
          pattern = pattern || 'PR外のコミット';
        }
        
        if (isNonReleaseCommit) {
          nonReleaseCommits.push({
            hash: commit.hash,
            message: commit.message,
            author: `${commit.author_name} <${commit.author_email}>`,
            pattern: pattern,
            isPrCommit: isPrCommit
          });
        }
      }
      
      if (nonReleaseCommits.length === 0) {
        vscode.window.showInformationMessage(`リリース対象外のコミットは見つかりませんでした。${sourceBranch}から${targetBranch}へのマージは安全です。`);
      } else {
        const panel = vscode.window.createWebviewPanel(
          'releaseCheck',
          'リリース対象外コミット検出結果',
          vscode.ViewColumn.One,
          { enableScripts: true }
        );
        
        panel.webview.html = getWebviewContent(nonReleaseCommits, sourceBranch, targetBranch, prUrls);
      }
    } catch (error) {
      vscode.window.showErrorMessage(`エラーが発生しました: ${error}`);
    }
  });
  
  context.subscriptions.push(disposable);
}

function getWebviewContent(nonReleaseCommits: NonReleaseCommit[], sourceBranch: string, targetBranch: string, prUrls: string[]): string {
  const commitList = nonReleaseCommits.map(commit => {
    return `
      <div class="commit">
        <div class="commit-header">
          <span class="commit-hash">${commit.hash.substring(0, 7)}</span>
          <span class="commit-author">${commit.author}</span>
        </div>
        <div class="commit-message">${escapeHtml(commit.message)}</div>
        <div class="commit-pattern">検出パターン: "${commit.pattern}"</div>
        ${!commit.isPrCommit ? '<div class="commit-warning">警告: このコミットは指定されたプルリクエストに含まれていません</div>' : ''}
      </div>
    `;
  }).join('');
  
  const prUrlsList = prUrls.map(url => `<li><a href="${escapeHtml(url)}" target="_blank">${escapeHtml(url)}</a></li>`).join('');
  
  return `<!DOCTYPE html>
  <html lang="ja">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>リリース対象外コミット検出結果</title>
    <style>
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
        padding: 20px;
      }
      .header {
        margin-bottom: 20px;
      }
      .warning {
        color: #e74c3c;
        font-weight: bold;
        margin-bottom: 10px;
      }
      .pr-info {
        background-color: #f8f9fa;
        border-left: 4px solid #3498db;
        padding: 10px;
        margin-bottom: 15px;
      }
      .commit {
        border: 1px solid #ddd;
        border-radius: 5px;
        padding: 10px;
        margin-bottom: 10px;
        background-color: #f9f9f9;
      }
      .commit-header {
        display: flex;
        justify-content: space-between;
        margin-bottom: 5px;
      }
      .commit-hash {
        font-family: monospace;
        color: #3498db;
      }
      .commit-author {
        color: #7f8c8d;
        font-size: 0.9em;
      }
      .commit-message {
        white-space: pre-wrap;
        margin-bottom: 5px;
      }
      .commit-pattern {
        font-size: 0.9em;
        color: #e74c3c;
      }
      .commit-warning {
        font-size: 0.9em;
        color: #e74c3c;
        font-weight: bold;
        margin-top: 5px;
        padding: 3px 6px;
        background-color: #ffecec;
        border-left: 3px solid #e74c3c;
      }
    </style>
  </head>
  <body>
    <div class="header">
      <h2>リリース対象外コミット検出結果</h2>
      <div class="pr-info">
        <p><strong>プルリクエスト:</strong></p>
        <ul>
          ${prUrlsList}
        </ul>
      </div>
      <p>ブランチ比較: <strong>${sourceBranch}</strong> → <strong>${targetBranch}</strong></p>
      <p class="warning">警告: ${nonReleaseCommits.length}件のリリース対象外コミットが検出されました。</p>
    </div>
    <div class="commits">
      ${commitList}
    </div>
  </body>
  </html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function getPrCommits(owner: string, repo: string, prNumber: string): Promise<PrCommit[]> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repo}/pulls/${prNumber}/commits`,
      method: 'GET',
      headers: {
        'User-Agent': 'VSCode-Release-Check-Extension',
        'Accept': 'application/vnd.github.v3+json'
      }
    };

    const req = https.request(options, (res: any) => {
      let data = '';

      res.on('data', (chunk: any) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const commits = JSON.parse(data);
            resolve(commits);
          } catch (error) {
            reject(error);
          }
        } else {
          reject(new Error(`GitHub API returned status code ${res.statusCode}`));
        }
      });
    });

    req.on('error', (error: Error) => {
      reject(error);
    });

    req.end();
  });
}

export function deactivate() {}
