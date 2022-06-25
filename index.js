const Sentry = require('@sentry/node');
const express = require('express');
const crypto = require('crypto');
const { Octokit } = require("@octokit/rest");
const HttpStatus = require('http-status-codes');
const YAML = require('yaml');
const fs = require('fs');
const path = require('path');
const AWS = require('aws-sdk');
require('log-timestamp');

let suitePublishRuns = {};

let config = null;
try {
    const configFileContents = fs.readFileSync('./config.yml', 'utf8');
    config = YAML.parse(configFileContents);
} catch (e) {
    console.error("error: " + 'Failed to load config.yml be sure exists otherwise copy config.example.yml and modify it to your needs.');
    return;
}

const LISTENING_PORT = Number(config.listening_port || 3000);
const ALLOWED_REPOS = Object.keys(config.repositories);
const BUILD_UPLOAD_ALLOWED_LABEL = config.build_allowed_upload_label || "allow-build-upload";
const BUILD_FILE_HASHES_REGEX = "BuildFileHashes: (\\[(.+)\\])";

Sentry.init({ dsn: config.sentry_dsn });

const app = express();

const octokit = new Octokit({
    auth: config.github_auth_token
});

app.use('/webhook', express.json());

app.use(async (request, response, next) => {
    if (request.path === '/webhook') {
        next();
        return;
    }

    const {owner, repo, commit_hash, pull_number, job_name, file_sizes} = request.headers;
    if (!owner || !repo || !commit_hash || !pull_number || !job_name || !file_sizes) {
        response.status(HttpStatus.StatusCodes.INTERNAL_SERVER_ERROR).send('One of the required headers is not set correctly.');
        return;
    }
    if (!ALLOWED_REPOS.includes(`${owner}/${repo}`)) {
        response.status(HttpStatus.StatusCodes.INTERNAL_SERVER_ERROR).send('Selected repo is not permitted to use this service.');
        return;
    }
    let pull_data = (await octokit.pulls.get({owner, repo, pull_number})).data;
    if (!isPRBuildAllowedToBeUploaded(pull_data)) {
        response.status(HttpStatus.StatusCodes.INTERNAL_SERVER_ERROR)
            .send(`Please label PR build next time with the ${BUILD_UPLOAD_ALLOWED_LABEL} label.`);
        return;
    }
    const GITHUB_MAX_VISIBLE_COMMITS = 250;
    let last_commit_page = pull_data.commits > GITHUB_MAX_VISIBLE_COMMITS ? GITHUB_MAX_VISIBLE_COMMITS : pull_data.commits;

    let pull_commits = (await octokit.pulls.listCommits({
        owner,
        repo,
        pull_number,
        per_page: 1,
        page: last_commit_page
    })).data;
    if (!pull_commits.some(commit => commit.sha === commit_hash)) {
        response.status(HttpStatus.StatusCodes.INTERNAL_SERVER_ERROR)
            .send(`Pull request does not contains commit sha: ${commit_hash}.`);
        return;
    }

    let file_sizes_list = file_sizes.split(',').map(file_size => parseInt(file_size));
    let file_index = 0;
    request.files = [];
    let hash = crypto.createHash('sha256');
    let fileBuffers = [];
    let fileSeek = 0;
    let fileSize = file_sizes_list[file_index];

    request.on('data', (chunk) => {
        let readData = chunk;
        while (readData.length > 0) {
            let dataLength = readData.length;
            let bytesToGo = fileSize - fileSeek;
            // only read part of this file
            let readLength = Math.min(bytesToGo, dataLength);
            fileSeek += readLength;
            let readDataNow = readData.slice(0, readLength);
            let remainingData = readData.slice(readLength, readData.length);
            hash.update(readDataNow);
            fileBuffers.push(readDataNow);
            if (remainingData.length > 0 || fileSeek === fileSize) {
                console.log("info: " + 'Reading of file completed');
                request.files.push({
                    hash: hash.digest('hex'),
                    buffer: Buffer.concat(fileBuffers),
                    fileSize,
                    verified: false
                });

                if (file_index < (file_sizes_list.length - 1)) {
                    // Go to next file
                    file_index++;
                    fileSize = file_sizes_list[file_index];
                    fileSeek = 0;
                    fileBuffers = [];
                    hash = crypto.createHash('sha256');
                }
            }
            readData = remainingData;
        }
    }).on('end', () => {
        next();
    });
});

function isPRBuildAllowedToBeUploaded(pull_request_data) {
    return pull_request_data.author_association === "OWNER" ||
        pull_request_data.author_association === "MEMBER" ||
        pull_request_data.author_association === "COLLABORATOR" ||
        pull_request_data.labels.some(label => label.name === BUILD_UPLOAD_ALLOWED_LABEL);
}

function getStoragePath(path, variables) {
    return path.replace(/\[\:([a-zA-Z0-9_]+)\]/g, (match, variable_key) => {
        if (variables[variable_key] === undefined) {
            console.error("error:" + `Could not find ${variable_key} for path: ${path}.`);
            return '';
        }
        return variables[variable_key];
    });
}

async function publishRuns(check_suite_id) {
    const requests = suitePublishRuns[check_suite_id];
    delete suitePublishRuns[check_suite_id];

    let publishUrls = {};
    let areGlobalCheckSuiteVariablesSet = false;
    let globalPullNumber = false;
    let globalOwner = null;
    let globalRepo = null;

    for (let requestKey in requests) {
        if (!requests.hasOwnProperty(requestKey)) {
            continue;
        }
        let request = requests[requestKey];
        const {owner, repo, commit_hash, pull_number, job_name, run_id} = request.headers;
        if (!areGlobalCheckSuiteVariablesSet) {
            globalPullNumber = pull_number;
            globalOwner = owner;
            globalRepo = repo;
            areGlobalCheckSuiteVariablesSet = true;
        }

        const repositoryConfig = config.repositories[`${owner}/${repo}`];

        let jobsForWorkflowRun = (await octokit.actions.listJobsForWorkflowRun({
            owner,
            repo,
            run_id
        }).catch((e) => {
            console.error("error: " + e.stack);
        })).data;
        console.log("info: " + 'workflow run jobs: ' + JSON.stringify(jobsForWorkflowRun));

        let actualJobID = null;
        let isJobCompleted = false;
        if (!jobsForWorkflowRun.jobs.some((job) => {
            if (job.name === job_name) {
                actualJobID = job.id;
                isJobCompleted = job.status === "completed";
                return true;
            }
            return false;
        })) {
            console.warn("warn: " + `Failed to find matching job_name in running jobs.`);
            return false;
        }

        let logs = (await octokit.actions.downloadJobLogsForWorkflowRun({
            owner,
            repo,
            job_id: actualJobID
        }).catch((e) => {
            console.error("error: " + e.stack);
        })).data;

        let regExp = new RegExp(BUILD_FILE_HASHES_REGEX, 'gm');
        let match = regExp.exec(logs);
        if (!match) {
            console.warn("warn: " + `check_run ${check_run.name} doesn't have build file hashes.`);
            continue;
        }
        let buildFileHashes;
        try {
            buildFileHashes = JSON.parse(match[1]);
        } catch (e) {
            Sentry.captureException(e);
            console.error("error: " + `failed to parse build hashes.`);
            continue;
        }

        console.log("info: " + 'buildFileHashes: ' + JSON.stringify(buildFileHashes));

        let hasHashError = false;
        for (let i = 0; i < request.files.length; i++) {
            let file = request.files[i];
            console.log("info: " + `Looking for the filename of artifact with the hash ${file.hash}.`);

            let buildFileHashPair = buildFileHashes.find((buildFileHash) => {
                return buildFileHash.sha256_checksum === file.hash;
            });

            if (!buildFileHashPair) {
                hasHashError = true;
                console.warn("warn: " + `Failed to find build hash in JSON object. Bailing.`);
                break;
            }

            file.name = buildFileHashPair.filename;
            file.extname = path.extname(file.name);
            file.basename = path.basename(file.name, file.extname);

            console.log("info: " + `Found ${file.name} with selected hash ${file.hash}.`);
        }

        if (hasHashError) {
            console.warn("warn: " + `Hash error found. Publishing for ${job_name} terminated`);
            continue;
        }

        publishUrls[job_name] = [];

        // Storage
        const repositoryStorages = repositoryConfig.storages;
        for (let repositoryStorageKey in repositoryStorages) {
            if (!repositoryStorages.hasOwnProperty(repositoryStorageKey)) {
                continue;
            }

            const repositoryStorage = repositoryStorages[repositoryStorageKey];
            const storage = config.storages[repositoryStorage.storage];

            for (let i = 0; i < request.files.length; i++) {
                let file = request.files[i];
                const storageParams = {
                    owner,
                    repo,
                    pull_number,
                    file_name: file.name,
                    file_basename: file.basename,
                    file_extname: file.extname,
                    file_hash: file.hash,
                    commit_short_hash: commit_hash.substring(0, 8)
                };

                const storagePath = getStoragePath(storage.path, storageParams);
                if (storage.method === 'file') {
                    try {
                        let storageDirectory = path.dirname(storagePath);
                        if (!fs.existsSync(storageDirectory)) {
                            fs.mkdirSync(storageDirectory, {recursive: true});
                        }
                        await fs.writeFile(storagePath, file.buffer, function (err) {
                            if (err) {
                                throw err;
                            }
                            console.log("info: " + 'Saved ' + file.hash + '!');
                        });
                        if (repositoryStorage.publish_url) {
                            publishUrls[job_name].push(storagePath);
                        }
                    } catch (err) {
                        Sentry.captureException(err);
                        console.error("error: " + JSON.stringify(err.stack));
                        continue;
                    }
                } else if (storage.method === 'S3') {
                    // Create S3 service object
                    let s3 = new AWS.S3({
                        //apiVersion: '2006-03-01',
                        region: storage.region,
                        endpoint: storage.endpoint,
                        credentials: new AWS.Credentials(storage.accessKeyId, storage.secretAccessKey)
                    });
                    let data = (await s3.upload({
                        Bucket: storage.bucket,
                        Key: storagePath,
                        Body: file.buffer,
                        Endpoint: storage.endpoint,
                        ACL: storage.acl
                    }).promise().catch((err) => {
                        console.log("error: ", err.stack);
                    }));
                    console.log("info: " + 's3 upload output = ' + JSON.stringify(data));

                    if (data !== undefined && repositoryStorage.publish_url) {
                        publishUrls[job_name].push(getStoragePath(storage.public_url, storageParams));
                    }
                }
                console.log("info: " + storagePath);
            }
        }
    }

    let urlCount = Object.values(publishUrls).reduce((a, b) => {
        return a.concat(b);
    }).length;

    // Only comment on PR if public urls are available
    if (urlCount > 0) {
        let message = "";
        for (let publishUrlJobName in publishUrls) {
            if (!publishUrls.hasOwnProperty(publishUrlJobName)) {
                continue;
            }
            let urls = publishUrls[publishUrlJobName];
            if (urls.length > 0) {
                message += `**${publishUrlJobName}**\n - ` + urls.join('\n - ') + '\n\n';
            }
        }

        // Publish a message with build links
        octokit.issues.createComment({
            owner: globalOwner,
            repo: globalRepo,
            issue_number: globalPullNumber,
            body: 'Here are some builds you may use for testing: \n\n' + message
        }).catch((e) => {
            Sentry.captureException(e);
            console.error('error: ', JSON.stringify(e));
        });
    }
}

app.listen(LISTENING_PORT, () => console.log("info: " + `App listening on port ${LISTENING_PORT}!`));

app.put('/', async function (request, response) {
    try {
        const {owner, repo, commit_hash, pull_number, job_name, run_id} = request.headers;

        let check_run_data = (await octokit.checks.listForRef({
            owner,
            repo,
            ref: commit_hash,
            check_name: job_name
        })).data;

        console.log(JSON.stringify(check_run_data));

        const checksuite_id = check_run_data.check_runs[0].check_suite.id;
        console.log("info: " + 'checkrun id = ' + check_run_data.check_runs[0].id);
        console.log("info: " + 'checksuite id = ' + checksuite_id);

        console.log("info: " + 'run_id = ' + run_id);

        if (suitePublishRuns[checksuite_id] === undefined) {
            suitePublishRuns[checksuite_id] = [];
        }
        suitePublishRuns[checksuite_id].push(request);

        response.send({
            success: true,
            message: "Publishing procedure started, unfortunately the GHA will have to finish before this."
        });
    } catch (err) {
        console.error("error: " + err.stack);
        Sentry.captureException(err);
        response.status(HttpStatus.StatusCodes.INTERNAL_SERVER_ERROR).send('Error happened please check server logs.');
    }
});

function getSignatureForBody(body) {
    return 'sha1='+ crypto.createHmac('sha1', config.repositories[body.repository.full_name].gh_notify_secret)
        .update(JSON.stringify(body))
        .digest('hex')
}

app.post('/webhook', async function(request, response) {
    try {
        const signature = request.headers['x-hub-signature'];
        const event = request.headers['x-github-event'];
        const expectedSignature = getSignatureForBody(request.body);

        if (signature !== expectedSignature) {
            response.status(HttpStatus.StatusCodes.UNAUTHORIZED).send('Webhook authentication failure.');
            return;
        }

        if (event === 'check_suite' && request.body.action === 'completed') {
            await publishRuns(request.body.check_suite.id);
            response.status(HttpStatus.StatusCodes.OK).send('Check suite completed request handled.');
            return;
        }
        response.status(HttpStatus.StatusCodes.OK).send('Request handled.');

    } catch (err) {
        console.error("error: " + err.stack + "\n Make sure that your Webhook secret matches gh_notify_secret and that your Webhook Content type is set to json.");
        Sentry.captureException(err);
        response.status(HttpStatus.StatusCodes.INTERNAL_SERVER_ERROR).send('Error happened please check server logs.');
    }
});
