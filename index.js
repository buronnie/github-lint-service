const http = require('http');
const createHandler = require('github-webhook-handler');
const fetch = require('node-fetch');
const { CLIEngine } = require('eslint');

const esLintConfig = {
	env: {
		browser: true,
		commonjs: true,
		es6: true,
	},
	extends: 'airbnb',
	rules: {
		'no-tabs': 0,
		indent: [2, 'tab'],
	},
};

const linter = new CLIEngine(esLintConfig);

const PORT = process.env.PORT || 5000;
const githubToken = process.env.GITHUB_TOKEN;

function apiPrefix(repoName) {
	return `https://api.github.com/repos/buronnie/${repoName}`;
}

function postCommentUrl(repoName, prNumber) {
	return `${apiPrefix(repoName, prNumber)}/pulls/${prNumber}/comments?access_token=${githubToken}`;
}

function PRFilesUrl(repoName, prNumber) {
	return `${apiPrefix(repoName, prNumber)}/pulls/${prNumber}/files?access_token=${githubToken}`;
}

function fileContentUrl(repoName, filename, branchName) {
	return `${apiPrefix(repoName)}/contents/${filename}?ref=${branchName}&access_token=${githubToken}`;
}

function postComment(repoName, prNumber, comments, index) {
	if (index === comments.length) {
		return Promise.resolve(true);
	}
	return fetch(postCommentUrl(repoName, prNumber), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(comments[index]),
	}).then(() => postComment(repoName, prNumber, comments, index + 1), err => console.log('error', err));
}

function postComments(repoName, prNumber, comments) {
	return postComment(repoName, prNumber, comments, 0);
}

const handler = createHandler({ path: '/lint', secret: 'snoopy' });
http.createServer((req, res) => {
	handler(req, res, () => {
		res.statusCode = 404;
		res.end('no such location');
	});
}).listen(PORT);

function parseCommitIdFromContentUrl(contentUrl) {
	return contentUrl.split('ref=')[1];
}

function getChangedLinesFromHunk(hunk) {
	let lineNumberInOriginalFile = 0;
	let lineNumberInDiff = 0;
	// lineNumbersInDiff: key is line number in original file, value is line number in diff
	const lineNumbers = {};
	let firstAtSymbol = true;
	const changedLineNumbers = hunk.forEach((line) => {
		if (line.startsWith('-')) {
			lineNumberInDiff += 1;
			return;
		}

		if (!firstAtSymbol) {
			lineNumberInDiff += 1;
		}

		if (line.startsWith('@@')) {
			lineNumberInOriginalFile = Number(line.match(/\+([0-9]+)/)[1]) - 1;
			firstAtSymbol = false;
			return;
		}
		lineNumberInOriginalFile += 1;

		if (line.startsWith('+')) {
			lineNumbers[lineNumberInOriginalFile] = lineNumberInDiff;
		}
	});

	return {
		lineNumbers,
		changedLineNumbers,
	};
}

function buildCommentsFromLinting(commitId, filename, diff, fileContent) {
	if (!(filename.endsWith('.js') || filename.endsWith('.jsx'))) {
		return [];
	}
	// ignore config file linting
	if (filename.startsWith('.')) {
		return [];
	}

	const { lineNumbers } = getChangedLinesFromHunk(diff.split('\n'));
	const res = linter.executeOnText(fileContent)
		.results[0].messages
		.filter(error => error.line in lineNumbers)
		.map(error => ({
			body: error.message,
			commit_id: commitId,
			path: filename,
			position: lineNumbers[error.line],
		}));
	return res;
}

function buildCommentsForSingleFile(repoName, prNumber, branchName, files, index) {
	if (files.length === index) {
		return Promise.resolve(true);
	}

	const { filename, contents_url: contentUrl, patch: diff } = files[index];
	const fileUrl = fileContentUrl(repoName, filename, branchName);
	const commitId = parseCommitIdFromContentUrl(contentUrl);

	return fetch(fileUrl, {
		method: 'GET',
		headers: { Accept: 'application/vnd.github.VERSION.raw' },
	}).then(resp => resp.text())
		.then(fileContent => buildCommentsFromLinting(commitId, filename, diff, fileContent))
		.then(comments => postComments(repoName, prNumber, comments))
		.then(() => buildCommentsForSingleFile(repoName, prNumber, branchName, files, index + 1));
}

function buildCommentsForFiles(repoName, prNumber, branchName, files) {
	return buildCommentsForSingleFile(repoName, prNumber, branchName, files, 0);
}

handler.on('pull_request', ({ payload }) => {
	const repoName = payload.repository.name;
	const prNumber = payload.number;
	const branchName = payload.pull_request.head.ref;
	fetch(PRFilesUrl(repoName, prNumber))
		.then(resp => resp.json())
		.then(files => buildCommentsForFiles(repoName, prNumber, branchName, files));
});
