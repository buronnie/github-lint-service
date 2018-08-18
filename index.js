const http = require('http');
const createHandler = require('github-webhook-handler');
const fetch = require('node-fetch');
const { CLIEngine } = require('eslint');

const PORT = process.env.PORT || 5000;
const githubToken = process.env.GITHUB_TOKEN;

const handler = createHandler({ path: '/lint', secret: 'snoopy' });
http.createServer((req, res) => {
	handler(req, res, () => {
		res.statusCode = 404;
		res.end('no such location');
	});
}).listen(PORT);

function requireFromString(src) {
	const Module = module.constructor;
	const m = new Module();
	m._compile(src, 'tmp.js');
	return m.exports;
}

function apiPrefix(repoName) {
	return `https://api.github.com/repos/buronnie/${repoName}`;
}

function postReviewUrl(repoName, prNumber) {
	return `${apiPrefix(repoName)}/pulls/${prNumber}/reviews?access_token=${githubToken}`;
}

function PRFilesUrl(repoName, prNumber) {
	return `${apiPrefix(repoName)}/pulls/${prNumber}/files?access_token=${githubToken}`;
}

function fileContentUrl(repoName, filename, branchName) {
	return `${apiPrefix(repoName)}/contents/${filename}?ref=${branchName}&access_token=${githubToken}`;
}

function commentsUrl(repoName, prNumber) {
	return `${apiPrefix(repoName)}/pulls/${prNumber}/comments?access_token=${githubToken}`;
}

function statusUrl(repoName, commitSHA) {
	return `${apiPrefix(repoName)}/statuses/${commitSHA}?access_token=${githubToken}`;
}

function parseCommitIdFromContentUrl(contentUrl) {
	return contentUrl.split('ref=')[1];
}

function flatten2DArray(arrays) {
	return [].concat(...arrays);
}

function postCheckStatus(url, state, description) {
	return fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			state,
			description,
		}),
	});
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

function buildCommentsFromLinting(filename, diff, fileContent, linter) {
	if (!(filename.endsWith('.js') || filename.endsWith('.jsx'))) {
		return [];
	}
	// ignore config file linting
	if (filename.startsWith('.')) {
		return [];
	}

	const { lineNumbers } = getChangedLinesFromHunk(diff.split('\n'));
	const res = linter.executeOnText(fileContent, filename).results[0].messages
		.filter(error => error.line in lineNumbers)
		.map(error => ({
			body: error.message,
			path: filename,
			position: lineNumbers[error.line],
		}));
	return res;
}

// avoid commenting the same error when new commit is pushed
function filterComments(repoName, prNumber, comments) {
	return fetch(commentsUrl(repoName, prNumber))
		.then(resp => resp.json())
		.then(currentComments => comments.filter(
			comment => !currentComments.some(
				currentComment => comment.position === currentComment.position
					&& comment.body === currentComment.body,
			),
		));
}

function buildReview(repoName, prNumber, branchName, files, commitSHA, linter) {
	const { contents_url: contentUrl } = files[0];
	const commitId = parseCommitIdFromContentUrl(contentUrl);
	return Promise.all(files.filter(file => !linter.isPathIgnored(file.filename))
		.map((file) => {
			const { filename, patch: diff } = file;
			const fileUrl = fileContentUrl(repoName, filename, branchName);

			return fetch(fileUrl, {
				method: 'GET',
				headers: { Accept: 'application/vnd.github.VERSION.raw' },
			}).then(resp => resp.text())
				.then(fileContent => buildCommentsFromLinting(filename, diff, fileContent, linter));
		}))
		.then(commentsIn2DArray => flatten2DArray(commentsIn2DArray))
		.then((comments) => {
			if (comments.length === 0) {
				postCheckStatus(statusUrl(repoName, commitSHA), 'success', 'no linting errors');
			} else {
				postCheckStatus(statusUrl(repoName, commitSHA), 'failure', 'linting check fails');
			}
			return filterComments(repoName, prNumber, comments);
		})
		.then(comments => ({
			commit_id: commitId,
			event: 'COMMENT',
			comments,
		}));
}

function postReview(repoName, prNumber, review) {
	return fetch(postReviewUrl(repoName, prNumber), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(review),
	});
}

handler.on('pull_request', async ({ payload }) => {
	if (payload.action !== 'opened' && payload.action !== 'synchronize') {
		return;
	}
	const repoName = payload.repository.name;
	const prNumber = payload.number;
	const branchName = payload.pull_request.head.ref;
	const commitSHA = payload.pull_request.head.sha;
	let eslintConfigFile;
	let eslintIgnoreFile;

	// fetch file list in the root dir
	// priority of eslintrc configs:
	// .eslintrc.js > .eslintrc.json > .eslintrc
	const filelistResp = await fetch(fileContentUrl(repoName, '.', branchName));
	const filelist = await filelistResp.json();

	// check .eslintrc.js
	if (filelist.some(file => file.name === '.eslintrc.js')) {
		eslintConfigFile = '.eslintrc.js';
	} else if (filelist.some(file => file.name === '.eslintrc.json')) {
		eslintConfigFile = '.eslintrc.json';
	} else if (filelist.some(file => file.name === '.eslintrc')) {
		eslintConfigFile = '.eslintrc';
	}
	if (filelist.some(file => file.name === '.eslintignore')) {
		eslintIgnoreFile = '.eslintignore';
	}

	// quit if there is no eslint config file
	if (!eslintConfigFile) {
		return;
	}

	postCheckStatus(statusUrl(repoName, commitSHA), 'pending', 'working hard to lint your js files');

	const eslintrcUrl = fileContentUrl(repoName, eslintConfigFile, branchName);
	const eslintrcResp = await fetch(eslintrcUrl, {
		method: 'GET',
		headers: { Accept: 'application/vnd.github.VERSION.raw' },
	});
	const eslintrcText = await eslintrcResp.text();
	const eslintrcConfig = requireFromString(eslintrcText);

	let ignorePattern;
	if (eslintIgnoreFile) {
		const eslintIgnoreUrl = fileContentUrl(repoName, eslintIgnoreFile, branchName);
		const eslintIgnoreResp = await fetch(eslintIgnoreUrl, {
			method: 'GET',
			headers: { Accept: 'application/vnd.github.VERSION.raw' },
		});
		ignorePattern = await eslintIgnoreResp.text();
	}

	const linter = new CLIEngine({
		baseConfig: eslintrcConfig,
		useEslintrc: false,
		ignorePattern,
	});

	const filesResp = await fetch(PRFilesUrl(repoName, prNumber));
	const files = await filesResp.json();
	const review = await buildReview(repoName, prNumber, branchName, files, commitSHA, linter);
	await postReview(repoName, prNumber, review);
});
