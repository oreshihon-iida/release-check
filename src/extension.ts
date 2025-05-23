// The module 'vscode' contains the VS Code extensibility API
import * as vscode from 'vscode';
import * as path from 'path';
import simpleGit, { SimpleGit } from 'simple-git';

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
}

export function activate(context: vscode.ExtensionContext) {
  console.log('拡張機能 "release-check" がアクティブになりました');

  const disposable = vscode.commands.registerCommand('release-check.checkReleaseCommits', async () => {
    try {
      const prUrl = await vscode.window.showInputBox({
        prompt: 'リリース対象のプルリクエストURLを入力してください',
        placeHolder: 'https://github.com/owner/repo/pull/123',
        ignoreFocusOut: true,
        validateInput: (value) => {
          if (!value) {
            return 'URLを入力してください';
          }
          if (!value.includes('pull') && !value.includes('PR')) {
            return 'プルリクエストのURLを入力してください';
          }
          return null;
        }
      });

      if (!prUrl) {
        return;
      }

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
      
      for (const commit of logResult.all) {
        for (const pattern of excludePatterns) {
          if (commit.message.includes(pattern)) {
            nonReleaseCommits.push({
              hash: commit.hash,
              message: commit.message,
              author: `${commit.author_name} <${commit.author_email}>`,
              pattern: pattern
            });
            break;
          }
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
        
        panel.webview.html = getWebviewContent(nonReleaseCommits, sourceBranch, targetBranch, prUrl);
      }
    } catch (error) {
      vscode.window.showErrorMessage(`エラーが発生しました: ${error}`);
    }
  });
  
  context.subscriptions.push(disposable);
}

function getWebviewContent(nonReleaseCommits: NonReleaseCommit[], sourceBranch: string, targetBranch: string, prUrl: string): string {
  const commitList = nonReleaseCommits.map(commit => {
    return `
      <div class="commit">
        <div class="commit-header">
          <span class="commit-hash">${commit.hash.substring(0, 7)}</span>
          <span class="commit-author">${commit.author}</span>
        </div>
        <div class="commit-message">${escapeHtml(commit.message)}</div>
        <div class="commit-pattern">検出パターン: "${commit.pattern}"</div>
      </div>
    `;
  }).join('');
  
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
    </style>
  </head>
  <body>
    <div class="header">
      <h2>リリース対象外コミット検出結果</h2>
      <div class="pr-info">
        <p><strong>プルリクエスト:</strong> <a href="${escapeHtml(prUrl)}" target="_blank">${escapeHtml(prUrl)}</a></p>
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

export function deactivate() {}
