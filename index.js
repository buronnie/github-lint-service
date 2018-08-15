const http = require('http');
const createHandler = require('github-webhook-handler');
const fetch = require('node-fetch');

const PORT = process.env.PORT || 5000;
const githubToken = process.env.GITHUB_TOKEN;

function addLabels(payload, labels) {
	const repoName = payload.repository.name;
	const number = payload.number;
	const url = `https://api.github.com/repos/buronnie/${repoName}/issues/${number}/labels?access_token=${githubToken}`;
	return fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(labels),
	})
}

const handler = createHandler({ path: '/lint', secret: '' });
http.createServer(function (req, res) {
  handler(req, res, function (err) {
    res.statusCode = 404
    res.end('no such location')
  })
}).listen(PORT);

handler.on('pull_request', function ({ payload }) {
	console.log(payload);
});
