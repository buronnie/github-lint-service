const http = require('http');
const createHandler = require('github-webhook-handler');
const fetch = require('node-fetch');
const { CLIEngine } = require('eslint');

const linter = new CLIEngine();

const PORT = process.env.PORT || 5000;
const githubToken = process.env.GITHUB_TOKEN;

const handler = createHandler({ path: '/lint', secret: 'snoopy' });
http.createServer((req, res) => {
	handler(req, res, () => {
		res.statusCode = 404;
		res.end('no such location');
	});
}).listen(PORT);

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

function buildCommentsFromLinting(filename, diff, fileContent) {
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

function buildReview(repoName, prNumber, branchName, files, commitSHA) {
	const { contents_url: contentUrl } = files[0];
	const commitId = parseCommitIdFromContentUrl(contentUrl);
	return Promise.all(files.map((file) => {
		const { filename, patch: diff } = file;
		const fileUrl = fileContentUrl(repoName, filename, branchName);

		return fetch(fileUrl, {
			method: 'GET',
			headers: { Accept: 'application/vnd.github.VERSION.raw' },
		}).then(resp => resp.text())
			.then(fileContent => buildCommentsFromLinting(filename, diff, fileContent));
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



handler.on('pull_request', ({ payload }) => {
	if (payload.action !== 'opened' && payload.action !== 'synchronize') {
		return;
	}
	const repoName = payload.repository.name;
	const prNumber = payload.number;
	const branchName = payload.pull_request.head.ref;
	const commitSHA = payload.pull_request.head.sha;

	postCheckStatus(statusUrl(repoName, commitSHA), 'pending', 'working hard to lint your js files');

	fetch(PRFilesUrl(repoName, prNumber))
		.then(resp => resp.json())
		.then(files => buildReview(repoName, prNumber, branchName, files, commitSHA))
		.then(review => postReview(repoName, prNumber, review));
});
